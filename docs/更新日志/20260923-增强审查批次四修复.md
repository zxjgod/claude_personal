# 功能与性能增强 · 审查批次四修复

> 完成时间：2026-09-23
> 审查对象：工作区未提交的「功能与性能增强」批次 1-4（64 文件 +2542/-908）
> 状态：✅ **4 高 + 8 中全部修复**，7 条低风险顺手项一并处理 — typecheck 0 错误、vitest 147 文件 / **1812 用例全绿**（+8 新增）、smoke PASSED

---

## 审查方式

6 域并行审查（核心循环/上下文、核心工具+utils、扩展工具/子代理、MCP/hooks/插件/LSP、沙箱/权限/适配器、记忆/会话/CLI/TUI），全部高/中发现由主线逐条对照源码核实后才动手。基线：修复前 typecheck 0 错、1804 用例全绿（changelog 自述属实）。

---

## 高严重度修复（4 条）

### H1+H2 · LSP 全项目诊断（S4）两处致命缺陷 — `lsp.ts`

- **每次调用固定阻塞 60s**：tsserver 的 `geterrForProject` 不回 response 帧（handler 返回 `notRequired`），旧代码 `await request(...)` 只能等满安全超时才走到 `await done`——`requestCompleted` 早到也白等。改为**发后即跟踪**：完成由 requestCompleted/deadline/请求失败三路 resolve。实测 `lsp.test.ts` 全文件 **73.9s → 8.0s**。
- **锚点无视 tsconfig → 假"零诊断"**：旧代码取目录遍历字母序 `files[0]`，本仓库会落到 `sandbox\src\math.js`（tsconfig 只 include `src/**`）→ tsserver 归入 inferred project，真实项目一个文件不扫且静默报"干净"。新增 `pickProjectAnchor()`：解析 tsconfig/jsconfig（JSONC 容错、`files[]` 优先、include/exclude 经 fast-glob 展开；`extends` 不解析，注释已言明），实测本仓库锚点正确落回 `src/` 内。
- **配套**：请求失败（error response）现在 **throw**，`breadth/index.ts` 外层 catch 得以触发 `npx tsc` 兜底（旧代码 `.catch(()=>undefined)` 吞掉后按空数组"成功"返回）；deadline 到达仍按文档返回已落地的部分诊断。

### H3 · `/memory extract --model` 完全不可达 — `commands/memory.ts`

`/\b--model\b/` 永不匹配（`\b` 要求一侧是 word 字符，`-` 两侧都不是；node 实测 `"extract --model"` → false）。改 `/(^|\s)--model(\s|$)/i`；子命令匹配同步收紧为 `/^extract(\s|$)/i`（`/memory extraction` 不再误触发提取）。**并按批次 4 changelog 的设计接上 M5 快模型**：`CommandContext` 新增 `fastModelFactory`（cli.ts 单点注入，REPL/TUI 两入口共用），提取优先走 `CCR_FAST_MODEL`。

### H4 · Layer 3 主驱逐没接 CollapseStore（F2 空头承诺）— `context-pipeline.ts`

生产中绝大多数驱逐经由 count-based 路径完成，而该调用 `microcompact(msgs)` 不传 store；`evictionStub` 却无条件承诺 "call RestoreContext … to recover the original" → 模型照做必然 "Nothing stashed"。修复：count-based 调用传 `{ store: opts.store }`；stub 文案同步弱化为 "**may be** recoverable"（store 生命周期为单轮 agentLoop，跨轮/resume 的 id 本就 miss，诚实文案防误导）。

---

## 中严重度修复（8 条）

| # | 位置 | 修复 |
|---|---|---|
| M1 | `powershell.ts` | 非原生路径（Windows 默认）补上缺失的缓存失效；位置放在 abort/timeout/error 各 return **之前**（被杀命令可能已写盘），native 路径同步升级为新 helper |
| M8 | `fs-cache.ts` | 新增 `invalidateToolWritableScopes(context)`：失效 workspaceRoot **+ 全部 allowedDirectories**（Glob/Grep 以 searchDir 为 key，可在 root 之外）；win32/darwin 下 key 与前缀统一小写归一（realpath 与配置大小写不一致时失效不再脱靶）。write/edit/bash/powershell 五个调用点全部切换 |
| M2 | `anthropic-adapter.ts` | 早发射记录 `content_block_start` 携带的完整 `input`；块无 delta 时回落到它（缓冲式 Anthropic 兼容中继场景），不再以空 input 执行工具、也不再被去重集压掉 finalMessage 权威块。官方 API（start input 恒 `{}`）行为不变。新增中继场景回归测试 |
| M3 | `tui/run.tsx` | `model_retry` 消费 `continuation` 字段：续写式重试（`CCR_RETRY_CONTINUE=1`）时部分文本已入会话历史，TUI 改 `flush+commitStreaming` 保留可视转录；普通重试维持 discard |
| M4 | `provider-profiles.ts` | `resolveFastModelConfig` 跨 provider 不再继承主配置 baseURL/apiKey（旧行为：文档示例 `deepseek/deepseek-chat` 会拿主 key 打 openai 端点）；改为经 `resolveProviderConfig` 解析目标 provider 默认端点，凭据取 `CCR_FAST_MODEL_API_KEY`（可选 `CCR_FAST_MODEL_BASE_URL` 覆盖），缺 key 返回 null 走主模型兜底。`"/xxx"`（缺 provider 段）明确拒绝。新增 7 个单测 + `.env.example` 文档 |
| M5 | `mcp/index.ts` + `cli-tools.ts` | `wrapRemoteTools` 按名去重（坏服务器重复列名不再炸 registry）、`getAllTools` 跨服务器去重（`__` 服务器名碰撞）；监听器改为**先捕获完整新集合再动 registry**；`refreshServerTools` 的裸 catch 改为 console.error 留痕；`disconnectServer` 补发 tools-changed 通知（死工具不再滞留 live 数组被继续广告） |
| M6 | `agent.ts` | 重排为「类型解析 → 槽位守卫 → 创建 worktree」：并发拒绝与 unknown-type 两条早退路径发生在任何资源获取**之前**，不再泄漏 worktree+分支；catch/end_turn 清理路径不变 |
| M7 | `grep.ts` | 共享 listing promise 与调用方 abort 解耦：producer 不再捕获首个调用者的 signal（保留自身 30s timeout），各调用方用 `raceAbort(listing, 自己的signal)` 竞速——一个子代理被 kill 不再让并发兄弟误报 "Search aborted" |

---

## 顺手修复的低风险项（7 条）

1. `lsp.ts` diag 事件按 waiter 门控（超时残留不再混入下一轮）+ 全项目扫描经 `projectDiagChain` 串行化（并发调用互踩消除，兑现 `isConcurrencySafe:true` 声明）
2. `agent.ts` 后台模式文案 `JobOutput`/`JobKill` → 实名 `job_output`/`job_kill`
3. `agent.ts` 后台分支预检 `abortSignal.aborted`（已中止信号永不触发事件 → 不再失控跑完）
4. `context-pipeline.ts` evictionStub 文案弱化（见 H4）
5. `agent-memory.ts` `appendAgentMemory` 去重前 LF 归一（CRLF 文件不再重复累积同一 bullet，重建时顺带收敛换行风格）
6. `mcp/index.ts` 监听器异常留痕 + disconnect 广播（并入 M5）
7. 仓库根 `.tmp-mcp.txt` 调试残留已删除

---

## 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ 147 文件 / **1812 用例全绿**（1804 + 新增 8），总时长 125.6s → **78.2s**（lsp 不再空等 60s） |
| `npx biome check`（17 个改动文件） | ✅ 0 error（26 个存量风格 warning 不变） |
| `npm run smoke` | ✅ PASSED |

**新增测试**：`anthropic-early-tooluse.test.ts` +1（中继 start-input 场景）、`provider-profiles.test.ts` +7（`resolveFastModelConfig` 全语义：同 provider 继承/跨 provider 需独立 key/BASE_URL 覆盖/畸形值拒绝）；`web-fetch-extract.test.ts` 的快模型用例改为 mock 保留真实 `resolveProviderConfig` 并补 stub key。

## 未修（遗留清单，均为低风险或需产品决策）

- hook envelope 的 `session_id`/`transcript_path`/`cwd` 按值固化（`/resume`、`/cd` 后过期）——需把 hookCtx 改 getter，涉及面较宽
- `toolSources` 快照在 S2 刷新后漂移（`/tools`、`/status` 显示旧清单）
- integer elicitation 校验只在 TUI 入口（行模式仍放行 "3.7"）
- MemorySave `isConcurrencySafe:true` 但 `appendAgentMemory` 读-改-写无锁（同轮并发丢一条）；`agent_type` 未对照 `listSubagentNames()` 校验
- fork 子代理 `enter_worktree` 经共享 sessionId 改写父会话 shell cwd（task.ts 复用 `context.sessionId`）——需设计决策（fork 是否该有独立 cwd 域）
- F5 时间微压缩默认开且清理结果回写持久化（破坏性、无提示）——建议默认关或首次清理打 notice
- FNV-1a 32 位哈希碰撞会"错误折叠"且不回验内容（概率 ~n²/2^33，注释把后果说反了）
- auto-compact fast 降级的 catch 不辨 AbortError（中止后多付一次主模型调用）
- web-fetch 提取调用不挂 context.abortSignal（自身 15s 上限兜底）；20k 提取窗口不在输出中声明
- 沙箱网络 deny-list 可被 `certutil.exe`/裸 `yarn`/`sftp`/flag 换序绕过（启发式定位已在注释言明，非能力边界）
- 后台 bash 作业（run_in_background）不失效 fs 缓存（TTL 10s 兜底）
- CollapseStore 生命周期为单轮 agentLoop（stub 文案已弱化为 may be；如需跨轮恢复要把 store 提升到会话级）
