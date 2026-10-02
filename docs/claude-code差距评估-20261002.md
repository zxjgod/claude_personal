# 当前项目与官方 Claude Code 的差距评估

> 此报告固定升级前基线。后续实现与剩余边界见 [v1.6.0 全面升级](更新日志/20261002-comprehensive-upgrade.md)，不能把下文升级前的问题继续当成当前未修复状态。

评估日期：2026-10-02。项目版本：1.5.0；评估基线：`f28352a`。本机官方 CLI：`2.1.202 (Claude Code)`，通过 `claude --version` 核验。

对照使用两种基准：本机官方版本的公开帮助和工具类型，以及当日读取的滚动更新官方文档。文档包含比 2.1.202 更新的能力；有最低版本标注的功能不算本机版本已经提供。此次未确认官方最新发布版本。

## 结论

项目已有完整的本地编码工作流：模型调用、工具执行、权限审批、计划模式、结构化询问、上下文压缩、会话恢复、文件回退、MCP、Skills、子代理、团队、工作流和定时任务。最近完成的询问面板与启动文字颜色调整也属于当前实现。

主要差距在**执行约束的一致性、官方配置和扩展格式的兼容性、自动化协议、长期任务可靠性、语言语义能力以及产品集成**。功能同名不代表行为等价；没有同任务、同模型的对照评估，不能给出可信的“对齐百分比”或宣称编码效果等同官方。

第三方模型与 OpenAI 兼容接口支持是本项目的优势。是否接入官方账号、云端执行、IDE 或浏览器，应由本地产品目标决定。

## 优先处理的实际问题

### 1. Fork Skill 没有继承父会话的权限规则和 Hooks（P1，已模拟复现）

触发：调用 `context: fork` 的 Skill，父会话设置 `deny: ["Read"]`、`ask: ["Read"]`，或注册阻断读取的 PreToolUse Hook。

`runForkSkill()` 创建子循环时手工拼装 `toolContext`，传了 `permissionMode`、模型和审批回调，但没有传 `permissionPolicy`、`hooks`、`allowedDirectories`，也没有使用已有的 `deriveSubContext()`。`agentLoop` 只能使用收到的规则，不能自动补回这些限制。

本次用不访问文件的模拟 Read 工具核验：父会话 deny 规则未阻止执行，ask 规则没有触发审批，阻断 Hook 没有被调用。三个检查均失败；作为对照，现有 Task / Agent / Team / Workflow 委派约束测试 13 项通过。

这是项目自身的执行约束漏洞，不属于“安装即信任”的模板政策。可信模板进入子循环后仍应保留父会话的执行限制。建议沿用 `deriveSubContext()` 和受限审批通道，再把 Fork Skill 纳入委派约束回归矩阵。

源码：[forkSkill.ts](../src/skills/forkSkill.ts#L73)、[agent-loop.ts](../src/agent-loop.ts#L228)、[deriveSubContext](../src/types.ts#L316)。对照测试：[delegated-policy.test.ts](../src/__tests__/delegated-policy.test.ts)。

### 2. Worktree 的成果保留和工作区切换还不完整（P1，源码确认）

- `Agent(isolation: "worktree")` 在正常完成和异常分支调用清理函数，直接执行 `git worktree remove --force` 和 `git branch -D`；没有先检查未提交修改或尚未回收的提交，也没有返回可供回收成果的 worktree 元数据。尚未移交的修改可能丢失。
- 主会话 `enter_worktree` 只更新 Shell 的 session cwd。文件工具与系统提示仍以原工作区为根，需要模型显式使用 worktree 路径。
- `exit_worktree(action: "remove")` 只检查工作区是否脏，没有检查未合并提交；干净但含独有提交的分支仍会被强制删除。

官方随安装包发布的 `ExitWorktreeInput` 明确要求：存在未提交文件或未合并提交时，必须显式指定 `discard_changes` 才能删除；`EnterWorktreeInput` 还支持切换到已有 worktree。[O3]

建议先完整保留有成果的 worktree，返回路径与分支，再统一 Shell、文件工具、项目指令和工作区上下文。会话存储位置继续保持稳定，沿用既有架构决策。

源码：[agent.ts](../src/tools/extended/agent.ts#L106)、[成功清理分支](../src/tools/extended/agent.ts#L437)、[orchestration.ts](../src/tools/breadth/orchestration.ts#L140)、[退出检查](../src/tools/breadth/orchestration.ts#L180)。本次没有执行会修改真实仓库的 Git 复现。

## 能力差距清单

| 领域 | 当前项目的实际状态 | 与官方的差距及用户影响 | 建议顺序 |
|---|---|---|---|
| 项目指令与规则 | `loadClaudeMd()` 只读工作区根 `CLAUDE.md` | 缺少官方的用户、祖先与子目录指令发现、`CLAUDE.local.md`、规则目录与按路径规则、`@imports` 等；多目录项目的约束容易漏掉。较新文档还支持直接读取 AGENTS.md（要求 ≥2.1.277），有加载条件。[O-memory] | 第一批 |
| 设置与配置层级 | 合并项目 `settings.json` 与 `settings.local.json`；只消费六类顶层键 | 没有完整用户、项目、本地和管理策略层级；不支持 `--settings`、`--setting-sources`，嵌套配置使用顶层浅覆盖；官方 `statusLine` 等设置不能直接沿用。[O1、O-settings] | 第一批 |
| Skills | 支持延迟加载、模板、inline / fork、工具调用与 slash 入口 | 默认不发现用户 Skills；读取 `allowedTools` 而不是官方 `allowed-tools`，且运行语义不同；缺少 `disable-model-invocation`、`user-invocable`、模型和 Hooks 等控制；不能保证直接复用官方 Skill。[O-skills] | 第一批 |
| Hooks | 多个生命周期事件与 command Hook 已实现 | 事件返回值与权限决策协议未完整消费；缺少其他执行类型与多个生命周期；官方 Hook 配置仍可能无法发挥作用。[O-hooks] | 第一批 |
| 子代理 | 支持角色、背景运行、工具集合、Agent 调用时 model / effort 覆盖 | 磁盘代理的 `model` 字段没有执行；默认用户代理目录不加载；磁盘代理的权限、Hooks、预载技能等定义并未完整支持。官方插件代理也有字段限制，不能一概按用户代理处理。[O-subagents] | 第一批 |
| 插件生态 | 有安装、禁用、市场索引、组件加载与依赖检查 | 自有根目录 `plugin.json` 与组件布局；缺少官方 `.claude-plugin/plugin.json`、安装作用域和命名空间；官方插件通常需要转换。[O-plugins] | 第二批 |
| MCP | stdio / HTTP / SSE / WebSocket、OAuth、resources、prompts、动态工具与 elicitation 已实现 | 配置发现明确不读取官方 `.mcp.json` / 用户配置；缺少官方范围管理、完整 CLI 和部分连接器入口。重点是兼容层，不是重新实现 MCP。[O1、O4] | 第二批 |
| CLI / SDK / 非交互模式 | 有 `-p`、JSON、stream-json、resume / continue / fork | stream-json 输出项目内部 LoopEvent，输入读到 EOF 后执行；不是完整双向协议；缺少官方结构化输出 Schema、预算参数等；不能认为官方 Agent SDK 可直接使用。[O1] | 第二批 |
| 长期记忆 | 有项目 JSONL 记忆、退出提取和子代理 MEMORY.md | 子代理 `memory: user` 实际存储在项目目录，是 project 别名；没有真正跨项目用户记忆；主记忆组织与官方 auto memory 的索引、主题文件和 worktree 共享语义不同。[O-memory、O-subagents] | 第二批 |
| 语言语义能力 | 已有可复用的长期运行 tsserver；支持诊断与补全 | 是 TypeScript / JavaScript 专用实现，尚未形成官方插件式多语言 LSP、编辑后自动诊断与按符号导航生态。[O-lsp] | 第二批 |
| 持续目标与动态工作流 | `/goal` 将目标写入提示；Workflow 执行声明式 JSON 计划；cron / wakeup 可触发后续输入 | 官方 `/goal` 有独立完成条件评估；动态 Workflow 可持有脚本分支、循环与运行状态；会话定时任务可在 resume 恢复未过期任务，项目目前只持久化 durable cron。[O-runtime] | 第二至三批 |
| 团队与后台任务 | Task / Agent / Team / Workflow 与后台通知都有 | Team、结构化任务、job 等主要是进程内状态；缺少官方独立后台会话管理入口 `--bg` / `claude agents`，后台任务不等于可跨进程恢复的会话。[O1、O4] | 第三批 |
| 交互询问 | 已有选项说明、单选、多选、自定义回答与近期面板优化 | 一次调用只支持一个问题；官方公开工具契约支持 1–4 个问题及选项 preview；仍有批量问题、预览和协议差距。[O3] | 第三批 |
| IDE / 浏览器 / 远程 / 语音 | 主要是 CLI 与 Ink TUI | 未见官方 IDE 上下文与 diff 联动、Chrome 集成、Remote Control、云端移交或语音输入。各能力有账号与平台条件，例如 Remote Control 和语音不能直接以第三方 API key 使用。[O1、O-ecosystem] | 按需求 |
| 可编程界面扩展 | TUI 提供内置面板、主题和键绑定 | 官方滚动文档另有 Mods 可程序化修改提问框、面板、spinner 等；项目没有对应界面插件运行时。[O-mods] | 按需求 |
| 账号 / 云端 / 企业 | 原生 Anthropic API 和多第三方模型；有云网关 URL 路由 | 没有官方订阅登录与服务端产品链路；网关不提供 AWS 签名或 GCP 凭据刷新；本地 telemetry 为 JSONL，没有完整企业网关与统一观测入口。[O1、O4] | 按需求 |
| WebSearch | DuckDuckGo HTML / Lite，Bing HTML 回退；支持域名与时效条件 | HTML 解析受验证码与页面结构影响；参数不是官方 `allowed_domains` / `blocked_domains` 契约，可靠性与官方搜索结果不可凭名称推断。[O3] | 按需求 |
| 效果评估 | 有单元测试、模拟集成、CI、启动冒烟和可选真实 provider 冒烟 | 未见与官方同模型、同任务、同预算的任务成功率、成本、修复质量和长会话评估；大量测试通过不能单独证明实际编码效果相同 | 持续建设 |

### 配置、扩展和自动化的具体证据

- 指令：[cli-config.ts](../src/cli-config.ts#L295)。配置：[hooks-config.ts](../src/hooks-config.ts#L117)，已消费键在同文件 `KNOWN_SETTINGS_KEYS`。
- Skills：[loadSkillsDir.ts](../src/skills/loadSkillsDir.ts#L53)、[字段映射](../src/skills/loadSkillsDir.ts#L87)。子代理：[loadAgentsDir.ts](../src/agents/loadAgentsDir.ts#L40)、[字段映射](../src/agents/loadAgentsDir.ts#L73)。Agent 调用时的模型覆盖已经实现：[agent.ts](../src/tools/extended/agent.ts#L307)，不能把这项误写成完全缺失。
- 代理工具映射还有直接迁移障碍：官方示例的 `tools: Read, Grep` 保留大写名称，当前 resolver 使用大小写敏感的精确查找；省略 `tools` 又被加载器转成空列表，而官方语义是继承可用工具。[resolveSubagentTools](../src/subagents.ts#L144) 本次直接调用 resolver 核验：`Read` 匹配 0 个，空列表匹配 0 个，项目的 `read` 匹配 1 个；没有执行读取工具。
- 插件：[plugins.ts](../src/plugins.ts#L54)、[组件装配](../src/cli-tools.ts#L56)。组件加载没有插件名命名空间，同名注册可能覆盖。
- MCP：[配置发现](../src/mcp/index.ts#L911)。OAuth 与动态工具、询问能力已经存在，不能列为缺失。
- 非交互模式：[cli-args.ts](../src/cli-args.ts)、[stdin 与 stdout 分支](../src/cli.ts#L397)。此外，该分支执行后直接返回，没有交互路径的 `persistence.save`；有磁盘 Skills 或 MCP 时，初始化 `console.log` 还可能混入机器可读 stdout。应为纯 JSON 输出和 print 会话恢复建立完整流程验证。
- `--safe-mode` 也存在同名异义：项目用它强制 plan；本机官方 CLI 的帮助将其定义为禁用自定义指令、扩展、Hooks 和 MCP 等用于排障。[cli-config.ts](../src/cli-config.ts#L99)、[O1]。属于兼容性差异，不能单靠参数同名判断已经对齐。
- 记忆：[agent-memory.ts](../src/agent-memory.ts#L47)、[memory-extract.ts](../src/memory-extract.ts)。语言服务：[lsp.ts](../src/lsp.ts)。团队与任务：[team.ts](../src/team.ts#L102)、[structured-tasks.ts](../src/structured-tasks.ts#L26)。
- 询问：[interactive.ts](../src/tools/breadth/interactive.ts#L120)。云网关：[cloud-gateway.ts](../src/cloud-gateway.ts)。搜索：[web-search.ts](../src/tools/extended/web-search.ts)。观测：[telemetry.ts](../src/telemetry.ts)。
- 持续工作：[goal.ts](../src/commands/goal.ts)、[workflow-dsl.ts](../src/workflow-dsl.ts)、[cron 持久化过滤](../src/tools/extended/cron-shared.ts#L281)。声明式 Workflow 是为解决旧 VM 隔离漏洞而采用的收窄方案；扩展条件执行和恢复能力时，应保持这个安全边界，不建议重新开放不受隔离的任意 JavaScript。
- 评估边界：[CI](../.github/workflows/ci.yml) 跑静态检查、测试和启动冒烟；[provider-smoke.mjs](../scripts/provider-smoke.mjs) 的真实模型检查是“回复 OK”，[benchmark-baseline.ts](../scripts/benchmark-baseline.ts) 测 token 估算性能，都不是端到端编码任务质量对照。

### Hooks 需要专门补齐协议

当前支持 11 个配置事件，且配置解析器只接受 `type: "command"`。PreToolUse / PostToolUse / Stop 主要解释 `decision: "block"`；没有完整消费官方事件专用 JSON 输出。其他事件调用 `runSpecs()` 后不处理其返回结果。例如 UserPromptSubmit 即使返回阻断信息，也不能按官方语义改变本次输入处理。

这里应补的是事件语义和协议：`hookSpecificOutput.permissionDecision`、`updatedInput`、`additionalContext`、HTTP / MCP tool / prompt / agent 等 Hook 类型，以及 PermissionRequest、PostToolUseFailure、SubagentStart、TaskCompleted 等事件。不能把“会运行 Hook 命令”当成“官方 Hook 配置完全兼容”。[O-hooks]

源码：[事件与类型](../src/hooks-config.ts#L43)、[解析器](../src/hooks-config.ts#L152)、[返回值处理](../src/hooks-config.ts#L303)、[事件装配](../src/hooks-config.ts#L324)。

## 已有能力和已接受取舍

- 压缩、恢复、MCP、Skills、Agents、团队、Workflow、计划审批、询问、后台通知、定时任务都已存在；应评估深度而不是列为“未实现”。
- 定时任务支持 session-only、durable 和忙时排队。官方安装包的 CronCreate 也有 durable 字段。[O3] 本次不把“没有常驻系统守护进程”单独算作缺失的官方 CLI cron 能力。
- Shell 修改不进入文件 checkpoint。官方也明确不追踪 Bash 文件修改；普通和后台子代理修改通常也不在官方 rewind 范围内。[官方 checkpointing](https://code.claude.com/docs/en/checkpointing) 项目已有代码、会话、两者一起回退的 TUI 选项；当前主要体验差距是官方指定点前后局部摘要，不能声称这三种回退都缺失。
- 磁盘模板与插件 MCP 的“安装即信任”、原生沙箱 best-effort 降权，是已接受的设计取舍；不重新包装成未经修复的 bug。[当前设计决策](./architecture/decisions.md)
- `--dangerously-skip-permissions` 在本项目仍保留危险操作与敏感路径的安全底线。它与官方“跳过全部权限检查”的参数语义不同，但属于有意收窄，不建议为了兼容性直接移除防护。[cli-config.ts](../src/cli-config.ts#L249)、[O1]
- 官方 shell OS 沙箱支持 macOS、Linux 和 WSL2，native Windows 命令也不在该沙箱中；项目的 Windows best-effort 降权不能直接与官方其他平台的隔离能力当作同环境对照。[官方 sandboxing](https://code.claude.com/docs/en/sandboxing)
- 官方 Agent teams 标注 experimental，云 Routines 标注 research preview，Linux Desktop 标注 beta；这些不能作为所有环境都具备的稳定能力要求。
- 全面配置中心化、统一 IR、追加式会话存储和 Agent / Task 合并曾被暂缓。此次评估不要求先启动这些大重构。
- [局限性说明](./局限性说明.md) 中“没有长期 LSP”“1,117 个测试”等口径已经过时；本报告以源码和当前文档为准，不沿用旧对齐比例。

## 推荐推进顺序

1. **先保证成果和限制不丢失**：Fork Skill 执行约束、worktree 成果保留、文件工具与 Shell 的工作区一致性。
2. **再让现有官方资产可迁移**：项目指令发现、配置层级、官方 Skills / agents 字段、插件命名空间、MCP 配置适配。沿用自己的配置根也可以，通过显式导入或兼容模式完成，不必直接读取用户的官方凭据。
3. **再做自动化契约**：stdout / stderr 分离、事件 Schema、实时输入、结构化输出、预算及 print 会话恢复；用真实客户端验证 SDK 兼容性。
4. **再增强长任务与代码理解**：记忆作用域、任务恢复、通用 LSP 与语言插件；用固定任务集持续测量成功率、成本和恢复质量。
5. **最后按产品目标选集成**：IDE、Chrome、Remote Control、订阅账号、企业云与可观测性。保留第三方模型支持，不需要为外观一致而放弃这个优势。

## 核验范围与来源

本次审阅源码与公开契约，没有运行真实模型对照测试，没有访问官方账号、用户设置、真实会话或凭据。文档记录的 2,159 个测试是此前全量运行结果，本次没有重跑全套。

本次执行了隔离模拟验证：Fork Skill 三个约束检查失败；现有委派约束 13 项通过。另核验了代理工具名映射，确认大小写与省略字段的兼容性差异。临时探针已移除，不保留失败测试或修改运行时代码。worktree 风险根据控制流和 Git 参数确认，没有执行真实删除操作。

| 引用 | 一手来源 | 本次用途 |
|---|---|---|
| O1 | 本机官方 `claude --help`，版本 2.1.202；[官方 CLI 文档](https://code.claude.com/docs/en/cli-reference) | 可公开调用的参数、SDK / 非交互入口、IDE / Chrome / Remote Control、safe-mode 语义 |
| O2 | 官方 npm 包 `@anthropic-ai/claude-code/README.md`；[官方仓库](https://github.com/anthropics/claude-code) | 产品定位和 IDE / GitHub 入口 |
| O3 | 官方 npm 包随附 `sdk-tools.d.ts`，版本 2.1.202 | AgentInput、AskUserQuestionInput、CronCreateInput、EnterWorktreeInput、ExitWorktreeInput、WebSearchInput 的公开工具契约 |
| O4 | 本机官方 `claude agents --help`、`claude mcp --help`、`claude plugin --help`、`claude auth --help` | 后台会话、MCP / 插件管理、账号能力；仅运行 help，未连接服务器或读账号状态 |
| O-memory | [官方 Memory 文档](https://code.claude.com/docs/en/memory) | 指令层级、导入、路径规则、主代理与子代理记忆 |
| O-settings | [官方 Settings 文档](https://code.claude.com/docs/en/settings)、[Managed settings](https://code.claude.com/docs/en/managed-settings) | 用户、项目、本地、CLI 与管理策略层级 |
| O-skills | [官方 Skills 文档](https://code.claude.com/docs/en/skills) | 标准字段、调用控制、工具授权、模型与 Hooks、插件命名空间 |
| O-subagents | [官方 Subagents 文档](https://code.claude.com/docs/en/sub-agents) | 磁盘代理配置、用户记忆、工具继承、无修改时清理 worktree；插件代理限制 |
| O-hooks | [官方 Hooks 文档](https://code.claude.com/docs/en/hooks) | 完整事件、五种执行类型和事件专用 JSON 输出 |
| O-plugins / O-lsp | [Plugins](https://code.claude.com/docs/en/plugins/overview)、[Code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence) | 清单布局、安装作用域、LSP 自动诊断和符号导航 |
| O-runtime | [Goal](https://code.claude.com/docs/en/goal)、[Workflows](https://code.claude.com/docs/en/workflows)、[Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) | 独立目标评估、动态脚本编排、未过期定时任务随 resume 恢复 |
| O-ecosystem | [Remote Control](https://code.claude.com/docs/en/remote-control)、[VS Code](https://code.claude.com/docs/en/vs-code)、[Chrome](https://code.claude.com/docs/en/chrome)、[Voice](https://code.claude.com/docs/en/voice-dictation)、[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 产品集成、Python / TypeScript SDK 与账号、平台边界 |
| O-mods | [Mods](https://code.claude.com/docs/en/plugins/mods/overview) | 程序化界面扩展 |

官方页面的补充逐项来源见 [官方能力调研](./research/20261002-claude-code-official-capabilities.md)。官方公开文档与本机安装版本可能存在发布节奏差异；表中未实测的集成不代表所有账号、地区和平台都能直接使用。
