# 2026-10-02 修复 Windows 上 session 保存被瞬时共享冲突吞掉

## 背景

上一轮在收尾核对时记录了一条"已知既有问题（非本轮引入）"：
`session-memory.test.ts > two instances saving the same session concurrently
leave an intact file` 是 flaky 的。本轮把它查清楚了——它不是测试写松了，
而是一个真实的 Windows 数据丢失路径。

## 根因

复现出来的报错：

```
Error: EPERM: operation not permitted, rename
  '...\.claude\sessions\<id>.json.75200.tmp'
  -> '...\.claude\sessions\<id>.json'
```

session 保存用 tmp + rename 保证原子性（读者永远看到完整旧文件或完整新文件）。
但在 Windows 上，`MoveFileEx` 在**目标文件正被某个未以 `FILE_SHARE_DELETE`
打开的句柄占用**时会失败，Node 把它呈现为 `EPERM`。

而"我们自己制造的并发读者"恰好就会造成这种句柄：另一个实例的 `load()`、
会话列表扫描、文件监视器，持有时间只有几毫秒。于是原子写入可能**完全因为
外因而失败**。

这比测试 flaky 严重得多：`rename` 正是这里的持久性保证，rename 抛错就意味着
**整次保存直接丢失**，还会在目录里留下一个 `.tmp`（只能等启动清扫回收）。
在 `save()` 里该异常会被 saveChain 的 catch 吞掉以免拆掉 REPL，所以用户看到的是
"保存了但就是没存上"。

同一模式在 `session-memory.ts` 里有三处，全部同样脆弱：
会话保存、catalog 写入、损坏会话的隔离改名。

## 修复

新增 `src/utils/atomic-rename.ts` 的 `renameWithRetry`：仅对
`EPERM` / `EBUSY` / `EACCES` 做短退避重试（10/20/30/40/50ms，约 150ms 上限），
其余错误（ENOENT、EXDEV 等）**首次即抛**，不浪费预算。三处 rename 全部改用它。

## 复现与验证方法

单跑该测试 60 轮不失败——它需要 CPU 争用才会触发，与全量套件的并行 worker
环境一致。因此另写了进程内压力脚本：8~10 个并行进程 × 15~30 轮，每轮复刻测试
的双实例 20 次并发保存。

| | 修复前 | 修复后 |
|---|---|---|
| 8 进程 × 15 轮（120 轮） | 6 次 EPERM（约 5%） | **0** |
| 10 进程 × 30 轮（300 轮） | — | **0** |

单元测试 `atomic-rename.test.ts`（6 条）覆盖：正常路径、三种瞬时码各自重试、
预算耗尽后抛出且保留原始 code、永久错误只试一次。

## 影响范围

这不是测试专属问题。**双终端恢复同一会话**、TUI 扫描会话列表、任何与保存并发的
读取，都会让一次保存静默丢失。本修复同时消除了该 flake 与该数据丢失路径。

## 本轮未做

- `Workflow.name`（内置 / `.claude/workflows/` 命名工作流注册表）、`Agent.name`
  （需团队寻址子系统）。
- `Read.pages`：官方支持 PDF 页范围读取，但本项目**无任何 PDF 解析依赖**
  （`pdf-lib` / `pdfjs-dist` 均未安装）。实现它等于新增运行时依赖、改变安装体积，
  属于需要用户拍板的取舍，未擅自添加。
- 版本号仍为 `1.6.1`。

## 验证

- `npm run typecheck` ✅ 0 错误
- `npx biome check src --diagnostic-level=error` ✅ 0 错误
- `npm test` ✅ **2295/2295，185 文件，0 失败**
- `npm run build` ✅ · `npm run smoke` ✅ · `doc-sync --check --with-tests` ✅