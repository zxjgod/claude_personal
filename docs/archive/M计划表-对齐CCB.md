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
| **P2** | 多 provider 原生化 | cloud-gateway 薄路由 → 原生 adapter（Bedrock/Vertex/Gemini/Grok） | 7 provider 注册 | 做成 adapter 而非网关 |
| **P2** | 可观测性（轻量） | 本地 telemetry → + analytics + 远程配置开关 | telemetry remote config | 仅开关 + 本地 analytics，不引 Sentry/Langfuse |
| **不做** | Bun / NAPI / 群控 / Remote Control / Chrome Use / Computer Use / monorepo | — | — | 与"轻量本地"定位冲突 |

---

## 二、M18 — 命令广度补齐（P0，最高投入产出比）

> 目标：26 → ~40。优先移植 B 中高频、低耦合、纯 TS 可实现的命令。`commands.ts` 单文件已到瓶颈，**本轮开始拆 `src/commands/<name>.ts`**，对齐 B 的目录化结构（但保留单文件而非每命令一目录，控制体量）。

### 移植清单（按价值排序）

| # | 命令 | B 来源 | 作用 | A 现状 | 估时 |
|---|---|---|---|---|---|
| 18.1 | `/branch` | commands/branch | 在当前对话点开分支（fork 当前 messages） | 🔴 无 | 0.5d |
| 18.2 | `/fork` | commands/fork（subagent redesign） | 子代理分支重设计，与 branch 互补 | 🔴 无 | 0.5d |
| 18.3 | `/review` | commands/review | 对当前 diff 做代码审查（调 model 读 change-tracker） | 🔴 无 | 0.5d |
| 18.4 | `/recap` | commands/recap | 总结本会话做了什么（基于 transcript + change-tracker） | 🔴 无 | 0.5d |
| 18.5 | `/share` | commands/share | 导出会话为可分享文本/markdown（增强现有 /export） | 🟡 /export 基础 | 0.5d |
| 18.6 | `/rewind` | commands/rewind | 回退到某轮之前（基于 messages 快照） | 🔴 无 | 0.5d |
| 18.7 | `/onboarding` | commands/onboarding | 首次使用引导（生成 CLAUDE.md + 检查 .env） | 🟡 /init 部分 | 0.5d |
| 18.8 | `/context` 增强 | commands/context | 真实 token 计数（替代 ~4 字符估算）+ 压缩预览 | 🟡 估算版 | 0.5d |
| 18.9 | `/doctor` 增强 | commands/doctor | 加 MCP 连通性、git、worktree、disk 检查 | 🟡 基础 | 0.5d |
| 18.10 | `/vim` | commands/vim | vim 模式开关（InputBox 切换输入语义） | 🔴 无 | 1d |
| 18.11 | `/theme` 增强 | commands/theme | 真主题切换（不只是粒子色） | 🟡 占位 | 0.5d |
| 18.12 | `/tags` 或 `/goal` | commands/goal | 设定/查看本轮目标，注入 system prompt | 🔴 无 | 0.5d |
| 18.13 | `/hooks` | commands/hooks | 查看/启停已注册 PreToolUse/PostToolUse | 🟡 hooks 已实现无命令 | 0.5d |
| 18.14 | `/schedule` | commands/schedule | 查看/删除 ScheduleCron 注册的 jobs | 🟡 工具已实现无命令 | 0.5d |

### 结构重构（18.0）

- 新建 `src/commands/` 目录，每个命令一个文件 `src/commands/<name>.ts`，默认导出 `CommandDef`
- `commands.ts` 改为注册表：`import * as cmd from "./commands/*.js"` + `registerAll()`
- 现有 26 命令逐个迁移（保持行为不变，纯搬运）
- 验收：`/help` 仍列出全部，行为零回归，458 测试全绿

### 验收

- 命令数 26 → **40**
- `tsc --noEmit` 通过；`vitest run` 全绿（新增 ~14 命令各 1–2 用例）
- `/help` 输出可读、分组

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

---

## 六、M22 — 多 provider 原生化（P2）

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

## 七、M23 — 轻量可观测性（P2，按需）

| # | 任务 | 验收 |
|---|---|---|
| 23.1 | analytics 本地计数（命令/工具调用频次） | `/stats` 可查看 |
| 23.2 | telemetry 远程配置开关（读 settings.json 的 endpoint，但不强依赖） | 开关可配 |
| 23.3 | **不引** Sentry / Langfuse / GrowthBook / OpenTelemetry | — |

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
                                                            └──> M22 (多provider, P2) ──> M23 (可观测, P2, 按需)
```

| 里程碑 | 主题 | 优先级 | 估时 | 完成后状态 |
|---|---|---|---|---|
| M18 | 命令广度补齐 26→40 | P0 | 5–7 天 | 操作手感大幅对齐 |
| M19 | 记忆服务化 | P0 | 3–4 天 | 会话/记忆机制对齐 |
| M20 | 工程化（CI/构建/pre-commit） | P1 | 2–3 天 | 从个人项目迈向可发布 |
| M21 | 测试广度 458→600+ | P1 | 3–4 天 | 质量门槛对齐 |
| M22 | 多 provider 原生化 | P2 | 2–3 天 | provider 体系对齐 |
| M23 | 轻量可观测性 | P2 | 1–2 天 | 迭代数据可见 |

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

**一句话**：M18–M21 落地后，A 在"机制 + 广度 + 工程化"上基本对齐 B 的里子，同时保留"纯 TS / Node 可跑 / 易读 / 轻量"的差异化护城河。M22–M23 视需求推进。
