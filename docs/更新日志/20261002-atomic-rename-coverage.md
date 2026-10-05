# 2026-10-02 原子 rename 重试覆盖面补全（9 处 renameSync）

## 背景

上一轮修的是 `session-memory` 的 Windows `EPERM` 瞬时共享冲突，并在日志里
写下了"同类是否存在于别处"的疑问。本轮把这个问题查完了——**答案是存在，而且
上一轮的排查漏掉了**。

## 上一轮为什么漏了

上一轮用 `rename(` 搜索调用点，只找到 `session-memory.ts` 的三处。但代码库里
**同步写路径用的是 `fs.renameSync`**，是完全不同的 token，三处之外还有 **9 处**
`renameSync` 调用点没被上一轮的搜索覆盖到。

这也解释了为什么第一轮压力脚本只测 session-memory 就能复现、而我据此以为
"问题范围已知"：复现的是最容易触发的那个写入点，不代表只有它。

## 本轮改动

给 `src/utils/atomic-rename.ts` 增加同步孪生 `renameSyncWithRetry`，并把全部
9 处 `renameSync` 改用它：

| 文件 | 场景 | 修复前的后果 |
|---|---|---|
| `checkpoint.ts:129` | **每次文件编辑**的影子 blob 写入 | 静默丢一个 blob → rewind 深度下降 |
| `checkpoint.ts:244` | checkpoint 镜像状态写入 | 镜像不同步，仅剩内存副本 |
| `checkpoint.ts:572` | rewind 恢复文件 | 该文件进入 `failures`，恢复失败 |
| `utils/file-lock.ts:28` | `atomicWriteFile` 通用原子写 | 写入失败 |
| `session-runtime.ts:41` | session 运行时快照 | 运行时状态丢失 |
| `tools/extended/cron-shared.ts:344` | 定时任务存储 | 任务定义丢失 |
| `executable-config-trust.ts:41` | 可执行配置信任存储 | 信任记录写不进去 |
| `workflow.ts:169` | workflow 快照 | 快照写失败，resume 受影响 |

其中 `checkpoint.ts:129` / `:244` 最要紧：它们在**每次编辑文件**时都会走，
被 `catch` 吞掉后返回 `null`（"best-effort"），所以一次瞬时 `EPERM` 就会
无声地削掉一个 checkpoint 影子——用户不会看到任何提示，只是 rewind 能力
不知不觉变浅了。这类"静默降级"比直接报错更值得修。

同步版本的退避用 `Atomics.wait`（Node 里唯一真正的同步睡眠），不用忙等烧 CPU。

契约与异步版一致：**只**重试 `EPERM`/`EBUSY`/`EACCES`，其余错误首次即抛。
最多阻塞约 150ms——这些调用点本来就在同步阻塞，代价远小于"写丢"。

## 同时确认无误的部分

顺带排查了 `unlinkSync` / `rmSync` 一类删除点。结论是**不需要改**：

- `checkpoint.ts` blob GC、`open-editor.ts` 临时文件清理、`clipboard-image.ts`、
  `powershell.ts`、`native-sandbox.ts` 的临时目录清理——都已在 try/catch 中
  按 best-effort 处理并显式注释了"另一个进程可能持有"。
- `session-memory.ts` 的会话删除对非 `ENOENT` 仍然抛出，属于有意的严格语义
  （删除失败必须让调用方知道）。

也就是说本轮只动了 rename 写路径，没有借机扩大改动面。

## 验证

- `npm run typecheck` ✅ 0 错误 · `npx biome check src --diagnostic-level=error` ✅ 0 错误
- `npm test` ✅ **2301/2301，185 文件，0 失败**
- `npm run build` ✅ · `npm run smoke` ✅ · `doc-sync --check --with-tests` ✅
- 全仓已无裸 `fs.renameSync(` / `fsPromises.rename(`（`atomic-rename.ts` 内除外）
- `atomic-rename.test.ts` 扩到 **12 条**，同步版与异步版各覆盖：正常路径、
  三种瞬时码、预算耗尽保留原始 code、永久错误只试一次。

## 方法论教训（已记入本文件）

上一轮"复现到 1 个 EPERM 就宣布范围已知"是个错误推断。本轮的正确做法是
**按 token 形态分别搜索**（`rename(` 与 `renameSync(` 是两个不同的调用面），
并把结论落到可验证的不变量上："全仓不存在裸 rename"。后者比"我搜过、
没找到更多"可靠得多。