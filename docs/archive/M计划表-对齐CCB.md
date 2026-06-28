# M 计划表 — 对齐 claude-code 参考标准（CCB）

> 生成：2026-06-27
> 基线：A = claude_personal（v1.0.0，26 命令 / 24 工具 / 458 测试 / M1–M17 完成）
> 参考：B = `claude-code-参考标准/`（CCB v2.8.0，120 命令 / 40+ 工具 / 319 测试 / 7 provider）
> 策略：**学 B 的"里子"（机制 + 广度），不学 B 的"壳子"（Bun / NAPI / 群控 / 企业可观测性）**。坚守"纯 TS / Node 可跑 / 无原生依赖 / 易读"差异化。

---

## 一、对齐优先级总览

| 优先级 | 主题 | 目标 | 对应 B 能力 | 是否照搬 |
|---|---|---|---|---|
| **P0** | 命令广度补齐 | 26 → ~40 | commands/<name>/ 目录 120 个 | 选择性移植 ~14 个 |
| **P0** | 记忆服务化 | persistence 单点 → SessionMemory + extractMemories + sessionTranscript | services/memory, memdir | 机制对齐，简化实现 |
| **P1** | 工程化对齐 | 零 CI → CI + pre-commit + 构建升级 | GitHub Actions, Biome, husky | 引入 CI + husky，构建用 esbuild |
| **P1** | 测试广度 | 458 → 600+，补 tools/permissions/persistence 集成 + production-test 冒烟 | 319 + production-test | 补集成测试 + 冒烟脚本 |
| **P1** | TUI 体验对齐 | 静态状态行 → 橙字形+流光+实时秒表+真 token；流式合批 + markdown 提交时解析 | Spinner / StatusBar 组件 | 复用 ink/chalk，不引渲染库 |
| **P2** | 多 provider 原生化 | cloud-gateway 薄路由 → 原生 adapter（Bedrock/Vertex/Gemini/Grok） | 7 provider 注册 | 做成 adapter 而非网关 |
| **不做** | Bun / NAPI / 群控 / Remote Control / Chrome Use / Computer Use / monorepo | — | — | 与"轻量本地"定位冲突 |

---

## 二、M18 — 命令广度补齐（P0，最高投入产出比）

> 目标：26 → ~40。优先移植 B 中高频、低耦合、纯 TS 可实现的命令。`commands.ts` 单文件已到瓶颈，**本轮开始拆 `src/commands/<name>.ts`**，对齐 B 的目录化结构（但保留单文件而非每命令一目录，控制体量）。

### 移植清单（按价值排序）

| # | 命令 | B 来源 | 作用 | A 现状 | 估时 |
|---|---|---|---|---|---|
| 18.1 | `/branch` | commands/branch | 在当前对话点开分支（fork 当前 messages） | ✅ 完成 | 0.5d |
| 18.2 | `/fork` | commands/fork（subagent redesign） | 子代理分支重设计，与 branch 互补 | ✅ 完成 | 0.5d |
| 18.3 | `/review` | commands/review | 对当前 diff 做代码审查（调 model 读 change-tracker） | ✅ 完成 | 0.5d |
| 18.4 | `/recap` | commands/recap | 总结本会话做了什么（基于 transcript + change-tracker） | ✅ 完成 | 0.5d |
| 18.5 | `/share` | commands/share | 导出会话为可分享文本/markdown（增强现有 /export） | ✅ 完成 | 0.5d |
| 18.6 | `/rewind` | commands/rewind | 回退到某轮之前（基于 messages 快照） | ✅ 完成 | 0.5d |
| 18.7 | `/onboarding` | commands/onboarding | 首次使用引导（生成 CLAUDE.md + 检查 .env） | ✅ 完成 | 0.5d |
| 18.8 | `/context` 增强 | commands/context | 真实 token 计数（替代 ~4 字符估算）+ 压缩预览 | ✅ 完成（压缩窗口进度条 + 真实估算口径对齐 agent-loop） | 0.5d |
| 18.9 | `/doctor` 增强 | commands/doctor | 加 MCP 连通性、git、worktree、disk 检查 | ✅ 完成 | 0.5d |
| 18.10 | `/vim` | commands/vim | vim 模式开关（InputBox 切换输入语义） | ✅ 完成（InputBox 模态编辑 + [N]/[I] 指示） | 1d |
| 18.11 | `/theme` 增强 | commands/theme | 真主题切换（不只是粒子色） | 🟡 dark/light 已可用 | 0.5d |
| 18.12 | `/tags` 或 `/goal` | commands/goal | 设定/查看本轮目标，注入 system prompt | ✅ 完成（注入 [SESSION GOAL]，CLI + TUI 双路径） | 0.5d |
| 18.13 | `/hooks` | commands/hooks | 查看/启停已注册 PreToolUse/PostToolUse | ✅ 完成（查看，HookRegistry.list） | 0.5d |
| 18.14 | `/schedule` | commands/schedule | 查看/删除 ScheduleCron 注册的 jobs | ✅ 完成（list / cancel / clear） | 0.5d |

### 结构重构（18.0）

- 新建 `src/commands/` 目录，每个命令一个文件 `src/commands/<name>.ts`，默认导出 `CommandDef`
- `commands.ts` 改为注册表：`import * as cmd from "./commands/*.js"` + `registerAll()`
- 现有 26 命令逐个迁移（保持行为不变，纯搬运）
- 验收：`/help` 仍列出全部，行为零回归，458 测试全绿

### 验收

- 命令数 26 → **40**
- `tsc --noEmit` 通过；`vitest run` 全绿（新增 ~14 命令各 1–2 用例）
- `/help` 输出可读、分组

> **进度（2026-06-27）**：18.0 结构重构 + 18.1–18.10、18.12–18.14 全部完成。命令数 37（注册表 COMMANDS）。18.11 `/theme` 仍为 dark/light 占位（未做完整主题引擎）。`tsc --noEmit` 通过；`vitest run --dir src` 全绿 **472 测试**（含新增 14 用例）。

---

## 三、M19 — 记忆服务化（P0）

> 目标：把 `persistence.ts` 单点拆成 B 的 `SessionMemory + sessionTranscript + extractMemories` 三层，对齐"会话即记忆"的机制，但不引 B 的 memdir/teamMemorySync/localVault 重型存储。

| # | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| 19.1 | 拆 `SessionMemory`：会话级消息 + 元数据读写 | `src/session-memory.ts`（新） | 现有 `/sessions` `/resume` 走新接口，行为不变 |
| 19.2 | `sessionTranscript`：完整事件流持久化（tool_use/results/usage） | `src/session-transcript.ts`（新） | 重启后能重放事件流 |
| 19.3 | `extractMemories`：会话结束时抽取"事实/偏好"存入 CLAUDE.md 或 `.claude/memories.jsonl` | `src/memory-extract.ts`（新） | `/recap` 复用此能力；可 `/memory` 查看 |
| 19.4 | 旧 `persistence.ts` 改为薄封装，向后兼容 | `src/persistence.ts` | 现有测试不破 |

### 验收

- `tsc` 通过；新增 ~12 测试；总量 458 → ~470

> **进度（2026-06-27）**：M19 完成。19.1 `SessionMemory`（重定位消息+元数据读写，行为字节级不变）；19.4 `PersistenceManager extends SessionMemory` 薄封装，`persistence.test.ts` 零改动通过；19.2 `SessionTranscript` append-only JSONL 事件流（`<id>.transcript.jsonl`，append/read/replay，容忍崩溃尾行），接入 CLI REPL 事件循环（user_prompt + tool_use/tool_result/usage/done/error/aborted，best-effort 不阻塞）；19.3 `extractMemoriesHeuristic`（离线规则）+ 可选 `extractMemoriesWithModel` + `MemoryStore`（`.claude/memories.jsonl`，去重），接入 `/memory`（列表 + `extract` 子命令）与 `/recap`（注入 durable notes）。决策：transcript 仅接 CLI（TUI 后续）、记忆按需+启发式抽取（退出不自动调模型）、存 `.claude/memories.jsonl`。`tsc --noEmit` 通过；`vitest run --dir src` 全绿 **488 测试**（新增 16 用例）。

- 真机：长会话退出再 `/resume`，transcript 与 memory 均可恢复

---

## 四、M20 — 工程化对齐（P1）

| # | 任务 | 产物 | 验收 |
|---|---|---|---|
| 20.1 | GitHub Actions CI | `.github/workflows/ci.yml` | push/PR 跑 lint + tsc + vitest |
| 20.2 | husky + lint-staged pre-commit | `.husky/pre-commit` | commit 前自动 lint 暂存区 |
| 20.3 | 构建升级：`tsc` → esbuild 代码分割 | `scripts/build.mjs` | 产物体积下降、启动更快；保留 `tsc --noEmit` 做类型检查 |
| 20.4 | production-test 冒烟脚本 | `scripts/smoke.ts` | 一条命令跑通 build → 启动 → 管道输入 → 退出 |
| 20.5 | Biome（可选）替换 ESLint+Prettier | `biome.json` | 单工具 lint+format，配置更轻 |

### 验收

- PR 自动跑 CI 绿
- `npm run build` 用 esbuild，产物可 `node dist/cli.js` 启动
- `npm run smoke` 一键冒烟通过

> **进度（2026-06-28）**：M20 完成。20.5 引入 **Biome 2.5.1** 替换坏掉的 eslint(无 flat config)+prettier，规则"真 bug 留、风格洁癖关"，经用户确认**立即全量格式化**（重排 120 文件，净 −362 行）；20.3 构建升级 **esbuild 转译**（`bundle:false` 逐文件，99 文件 ~260ms，避开 Ink/React + `createRequire(import.meta.url)` 打包风险），类型检查独立为 `npm run typecheck`；20.4 **冒烟脚本** `scripts/smoke.mjs`（build→`--version`/`--help`→无 key 管道输入优雅退出，9/9 全过）+ cli 加 `--version/-V`/`--help/-h`（config 前早退出，免 key）+ 修无 key 限跛前行隐患；20.2 **husky + lint-staged**（pre-commit 对暂存跑 `biome check --write`，可修自动修、不可修拦截，端到端实测）；20.1 **GitHub Actions CI**（push/PR→main 跑 typecheck+biome+test+smoke，Node 20）；附 `.gitattributes` 强制源码 LF 根治 Windows CRLF 与 biome 冲突。`tsc --noEmit` 0 错；`biome check` 干净；`vitest run --dir src` **506 测试**全过；`npm run smoke` PASSED。详见 [更新日志 20260628-m20-engineering](../更新日志/20260628-m20-engineering.md)。

---

## 五、M21 — 测试广度（P1）

| # | 任务 | 验收 |
|---|---|---|
| 21.1 | tools 集成测试（Worktree/Skill/Cron 真实 git 流程） | 新增 ~15 用例 |
| 21.2 | permissions 集成测试（LLM 分类器开/关路径） | 新增 ~10 用例 |
| 21.3 | persistence/session-memory 集成测试（多 session 隔离、resume） | 新增 ~12 用例 |
| 21.4 | MCP 多传输（http/sse/ws）连接测试（用 mock server） | 新增 ~10 用例 |
| 21.5 | TUI 长会话回归（ink-testing-library 30 轮） | 新增 ~5 用例 |
| 21.6 | production-test 冒烟纳入 CI | CI 跑 smoke |

### 验收

- 测试 458 → **600+**
- CI 全绿

> **进度（2026-06-28）**：M21 完成。新增 **6 个集成测试文件 / +105 用例**，总量 **508 → 613**（超 600 目标），`tsc --noEmit` 0 错、`biome check` 干净、`npm test` **613/613**、`npm run smoke` PASSED。
> - 21.1 `integration-tools.test.ts`（23）——真 git 全生命周期：enter→worktree 内 commit→exit keep/remove，证明提交隔离（main 不被 worktree 提交带走）、嵌套 worktree 栈 LIFO 弹出、脏树拒删+`discardChanges` 强删、跨 session 栈隔离；Skill 注册/解析/override/未知列目录；Cron list/get/remove/durable + Sleep 入队一次性 job。
> - 21.2 `integration-permissions.test.ts`（21）——完整 `checkPermission` 管道 × LLM 分类器：read-only/plan/bypass/blocked-path 在分类器之前短路（验证 callModel **零调用**）、BLOCK/CONFIRM/ALLOW 三判决端到端、失败安全（无 key/抛错/不可解析/超时/已 abort 一律退回正则原因并仍弹窗）、`formatActionForClassifier` 四种形态（bash/edit/url/JSON）、工作区外写入被标记后 BLOCK 拒绝。
> - 21.3 `integration-persistence.test.ts`（20）——多 session 隔离（同/异 workspace）、模拟重启后 `resume`（新实例读快照，保 `createdAt`/completed）、`history-replay` 把多轮会话折回 transcript items、`SessionTranscript` 有序 seq+recap 折叠+崩溃尾行容错、`MemoryStore` 抽取+去重+跨实例、并发多 session 落盘。
> - 21.4 `integration-mcp.test.ts`（23）+ `fixtures/mock-mcp-stdio-server.mjs`——**真 SDK** 多传输：stdio 子进程 mock server 全链路（connect→listTools→包装 `mcp__<srv>__<tool>`→调用 echo/add→首调批准粘滞→resources 读取→断开）、**进程内 StreamableHTTP** mock server（无状态+JSON 响应）http 往返、sse/ws/http 路由分支与不可达端点优雅降级（serverCount 0 不抛）、disabled/缺 url/缺 command/未知类型/坏 JSON 配置容错。
> - 21.5 `integration-tui.test.tsx`（12）——30 轮长会话压测 store 不变量（transcript 每轮 +3、id 全唯一、活动工具零泄漏、token 精确累加、乱序并发工具收尾不漏）、overlay 中途开/解不扰历史、`<App>` 渲染 30 轮与 resume 回放大 transcript 不崩、expandedId 展开工具卡。
> - 21.6 `ci-smoke.test.ts`（6）——回归守卫：`scripts/smoke.mjs` 存在、`package.json` 暴露 smoke/typecheck/test/check、smoke 覆盖 build+无 key 路径、`ci.yml` push/PR→main 跑 typecheck+check+test+smoke 且 smoke 在 test **之后**（M20 已接入 CI，此处把"接入"本身钉成不可回归）。
> - 决策：MCP 用 stdio 子进程 + 进程内 HTTP 作"真 mock server"（非打桩），sse/ws 以路由构造+不可达降级覆盖（真起 sse/ws 服务跨平台易脆）；分类器超时测试改用"慢流中途截断"（其超时是 yield 间协作式，无法中断从不 yield 的生成器）。详见 [更新日志 20260628-m21-testing](../更新日志/20260628-m21-testing.md)。

---

## 六、M22 — 多 provider 原生化（P2）

> **状态更新（2026-06-28）：降为「按需/低优先」。** 用户面的「多后端切换」需求已由 `/provider` 多端点档案（`.claude/providers.json` + 会话内热切换）覆盖——中转站/国内平台都是 OpenAI 兼容，改 baseURL 即可，无需为它们写原生 adapter。M22 仅在确需 Bedrock/Vertex 命名式注册时再做，且仍不含 SigV4/ADC 签名。详见 [更新日志 20260628-provider-profiles](../更新日志/20260628-provider-profiles.md)。

> 目标：把 `cloud-gateway.ts` 薄路由升级为原生 adapter，对齐 B 的 7 provider 注册体系，但**不打包云 SDK、不做 SigV4/ADC 签名**（保持薄层，token 用户提供）。

| # | 任务 | 验收 |
|---|---|---|
| 22.1 | provider 注册表 `src/providers/registry.ts` | 按 provider 名解析 caller |
| 22.2 | Bedrock / Vertex adapter（OpenAI 兼容面，复用现有 caller） | URL 路由正确 |
| 22.3 | Gemini / Grok adapter（OpenAI 兼容端点） | 切 provider 不改业务代码 |
| 22.4 | 废弃 `cloud-gateway.ts`，迁移到 registry | 旧测试改指向 registry |

### 验收

- provider 数 2（OpenAI 兼容 + Anthropic）→ **5+**
- `tsc` 通过；新增 ~10 测试

---

## 七、M23 — TUI 体验对齐参考版（响应 / 状态行 / 流式输出，P1）✅

> **状态（2026-06-28）：完成。** 9 项子任务全落地，`tsc --noEmit` 0 错、`biome check` 干净、`npm test` **651/651**（+38）、`npm run smoke` PASSED。新增 `src/spinner-core.ts`（共享原语）、`src/tui/SpinnerGlyph.tsx`、`src/tui/StatusLine.tsx`、`src/tui/stream-buffer.ts`；删除 `src/tui/ParticleSpinner.tsx` 与未用依赖 `ink-spinner`。状态行/工具卡共享粒子帧集 `·✢✶✻✽`，已按用户偏好移除 `✳`。详见 [更新日志 20260628-m23-tui-statusline](../更新日志/20260628-m23-tui-statusline.md)。
>
> **缘起**：项目已有一份**完整且忠实**的参考版 spinner（`src/cli-spinner.ts`：随机 gerund 动词、橙→shimmer 流光、实时秒表 `formatDuration`、真实 token `↑ 1.2k`），但它**只服务于旧的行式 CLI 路径，Ink TUI 从未用上**。当前 TUI（`App.tsx` + `ParticleSpinner.tsx`）只显示静态 "Thinking/Responding" + 黄色（非橙）粒子字形 + 粗估 `(streamedChars/4 tokens)`、**无计时**；而 `ToolCard.tsx` 又用了另一套 `ink-spinner` dots。M23 把这份已有能力接进 TUI，并修复流式重绘成本——本质是「接线 + 优化」而非从零造轮子。
>
> **决策（用户选定）**：① 状态行 **完全对齐参考版**（橙字形 / 流光 / 实时秒表 / 真实 token）；② 标签用 **具体动作**（Thinking / Reading `<file>` / Running `<cmd>` / Responding），而非随机 verb；③ 四项响应优化 **全做**（合并流式重绘 + markdown 延迟到提交 + 隔离动画子树 + 统一工具卡字形）。
>
> **落地要点**：
> - 23.1 `spinner-core.ts`：verbs / 帧 / 颜色 / shimmer 数学 / `formatDuration` / `formatTokens` / `glyphAt` / `actionLabel` 抽为纯模块，`cli-spinner.ts` 改为 import + re-export（旧测试零改动仍绿）。
> - 23.2/23.8 `StatusLine.tsx` + `SpinnerGlyph.tsx`：各自持有 `setInterval`，动画帧只重绘那一小块叶子，不惊动 `<Static>` 与输入框。
> - 23.3 `actionLabel`：从 spinner 模式 + 活动工具 detail 推导（Reading/Writing/Editing/Running/Searching/Fetching/Delegating），多工具时显示 `Running N tools`。
> - 23.4 真实 token：`usage` 事件在每次模型调用结束时落 `committedOutputTokens`，期间用 `char/4` 估算并在 usage 落地时校准（loop 内 usage 在流末，故估算+校准而非纯实时）。
> - 23.5 实时计时：`store.turnStartedAt` 在 turn 起点记录，跨 thinking→tool→responding 不重置，结束归零。
> - 23.6 `stream-buffer.ts`：注入式定时器的 `StreamBuffer`，token delta 合批 ~30fps（`appendStreamingWithTokens` 单次 emit）。
> - 23.7 流式期间渲染纯文本，markdown 仅在 `commitStreaming` 后的 assistant 行解析一次。
> - 23.9 `ToolCard` 改用 `SpinnerGlyph`，全 TUI 字形/配色统一为橙色粒子。

### 现状 vs 目标

| 维度 | 当前 TUI | 目标（对齐参考版） |
|---|---|---|
| 左侧字形 | 黄色粒子（`ParticleSpinner`），`ToolCard` 又用 `ink-spinner` dots | 统一橙色粒子字形 `·✢✶✻✽`（正放+倒放；无 `✳`） |
| 标签 | 静态 "Thinking" / "Responding" | 具体动作：`Reading App.tsx` / `Running npm test` |
| 计时 | 无 | 实时秒表（`16s` · `2m 5s`） |
| token | `streamedChars/4` 粗估 | 流式期间估算，`usage.output_tokens` 落地后校准为真实值（`↑ 1.2k`） |
| 流光 | 无 | shimmer 扫过标签（150ms） |
| 流式重绘 | 每 token → 整树 re-render + 每 delta 重解析 markdown | 合批 ~30fps + markdown 仅提交时解析一次 |

### 任务

| # | 任务 | 验收 |
|---|---|---|
| 23.1 | 抽公共 spinner 模块：把 `cli-spinner.ts` 的 verb / shimmer / `formatDuration` / `formatTokens` 提取为 Ink 与行式 CLI 共用（不重复实现） | 两端共用一份字形/计时/格式化逻辑 |
| 23.2 | TUI 状态行重写：橙色粒子字形 + shimmer 流光 + 实时秒表 + 真实 token，形如 `✶ Reading App.tsx (16s · ↑ 1.2k tokens)` | 手测与参考版一致 |
| 23.3 | 具体动作标签：从 `store.spinner` + 活动工具 detail 推导（Thinking / Reading `<file>` / Running `<cmd>` / Editing `<file>` / Searching `<pattern>` / Responding） | 工具运行时显示「动作 + 目标」 |
| 23.4 | token 计数：流式期间用 char/4 估算，`usage` 事件真实 `output_tokens` 落地后校准并累计 | 状态行 token 与会话累计最终一致 |
| 23.5 | 实时计时：turn 起点记 `startTime`，状态行按帧推进已用秒（`formatDuration`） | 秒表随帧前进，turn 结束归零 |
| 23.6 | 合并流式重绘：token delta 合批，固定节奏（~30ms / 30fps）刷新，避免每 token 触发整树 re-render | 高频流式重绘成本显著下降，不掉帧 |
| 23.7 | Markdown 延迟到提交：流式期间纯文本输出，仅 `commitStreaming` 时解析一次 markdown | 不再每 delta 重解析整段 markdown |
| 23.8 | 隔离动画子树：字形/计时/shimmer 收进自带 `interval` 的独立组件，动画帧只重绘那一小块 | 动画不惊动 `<Static>` transcript 与输入框 |
| 23.9 | 统一工具卡字形：`ToolCard` 的 `ink-spinner` dots 改为统一橙色粒子字形 | 全 TUI 字形/配色一致 |

### 验收

- 状态行：`✶ Reading App.tsx (16s · ↑ 1.2k tokens)`——橙色字形（帧集 `·✢✶✻✽`，无 `✳`）+ 流光 + 实时秒表 + token 估算/真实校准。
- 流式：长输出不卡顿/不闪烁；markdown 仅在消息提交时解析一次。
- `tsc --noEmit` 0 错、`biome check` 干净；新增/更新 TUI 组件测试覆盖状态行格式化 + 合批逻辑。
- 不引新依赖（复用 `ink` / `chalk` / 现有 `terminal-width` 工具）。

### 不做

- 不引入新动画/渲染库（仍用 Ink + 自管 `interval`）。
- 不改 agent loop 的事件协议（仅消费已有 `text_delta` / `usage` / `tool_use` 事件）。

**优先级 P1（用户明确要求）· 估时 1.5–2.5 天**

---

## 八、明确不做（与定位冲突）

| B 能力 | 不做理由 |
|---|---|
| Bun 运行时 / NAPI 原生包（audio-capture/image-processor/color-diff/modifiers/url-handler） | 破坏"纯 TS / Node 可跑 / 无原生编译" |
| Pipe IPC 群控 / LAN 跨机 / Remote Control 自托管 / SSH / daemon / bg sessions / teleport | 企业级重特性，与"轻量本地"冲突 |
| ACP（Zed/Cursor）/ bridge / artifacts | 需 IDE 协议层，超出当前定位 |
| Voice / Computer Use / Chrome Use / vim（完整）/ mobile | 重交互，按需再说 |
| workflow-engine / jobs / DreamTask / ultraplan / autoDream | 工作流引擎，体量过大 |
| plugins / dxt / marketplace / channels（飞书/Slack/微信） | 生态平台化，超出范围 |
| monorepo（20+ 包） | 体量不足以支撑，强行拆徒增复杂度 |

---

## 九、里程碑路线图

```
M18 (命令广度, P0) ──> M19 (记忆服务化, P0)
                              │
                              └──> M20 (工程化, P1) ──> M21 (测试, P1)
                                                            │
                                                            ├──> M22 (多provider, P2, 按需)
                                                            └──> M23 (TUI响应, P1)
```

| 里程碑 | 主题 | 优先级 | 估时 | 完成后状态 |
|---|---|---|---|---|
| M18 | 命令广度补齐 26→40 | P0 | 5–7 天 | 操作手感大幅对齐 |
| M19 | 记忆服务化 | P0 | 3–4 天 | 会话/记忆机制对齐 |
| M20 | 工程化（CI/构建/pre-commit） | P1 | 2–3 天 | 从个人项目迈向可发布 |
| M21 | 测试广度 458→600+ | P1 | 3–4 天 | 质量门槛对齐 |
| M22 | 多 provider 原生化 | P2 | 2–3 天 | provider 体系对齐 |
| M23 | TUI 体验对齐（响应/状态行/流式） | P1 | 1.5–2.5 天 | 交互手感对齐参考版 |

---

## 十、对齐后预期状态

| 指标 | 当前（A） | 对齐后（A） | B（参考） |
|---|---|---|---|
| 版本 | 1.0.0 | 1.1.0 | 2.8.0 |
| 斜杠命令 | 26 | ~40 | 120 |
| 内置工具 | 24 | 24（已够） | 40+ |
| provider | 2 | 5+ | 7 |
| 测试 | 458 | 600+ | 319 |
| CI/CD | 无 | 有 | 有 |
| 构建 | tsc 单步 | esbuild 代码分割 | Bun.build/Vite |
| 记忆 | persistence 单点 | SessionMemory + transcript + extractMemories | 完整记忆体系 |
| 运行时 | Node（纯 TS） | Node（纯 TS） | Bun + NAPI |
| 定位 | 轻量本地 | 轻量本地 + 工程化 | 企业级全功能 |

**一句话**：M18–M21 落地后，A 在"机制 + 广度 + 工程化"上基本对齐 B 的里子，同时保留"纯 TS / Node 可跑 / 易读 / 轻量"的差异化护城河。M22 视需求推进；M23（TUI 体验对齐）按用户要求推进。
