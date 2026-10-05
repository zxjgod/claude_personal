# 当前项目与官方 Claude Code 的差距评估

> 此报告固定升级前基线。后续实现与剩余边界见 [v1.6.0 全面升级](更新日志/20261002-comprehensive-upgrade.md)，不能把下文升级前的问题继续当成当前未修复状态。
>
> 补：官方工具参数名（`file_path` 等 snake_case）此前不可用，已于同日修复，见 [官方工具参数名对齐](更新日志/20261002-official-param-parity.md)。

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
| 团队与后台任务 | Task / Agent / Team / Workflow 与后台通知都有 | Team、结构化任务、job 等主要是进程内状态；官方独立后台会话入口 `--bg` / `claude agents`、commander 之前的隐藏 fast-path 层（内部 worker / Remote-Control 桥接别名 / `--cloud`）、以及 12 个顶层子命令（`agents`/`auth`/`doctor`/`mcp`/`plugin`/`update` 等）的**判定层均已复刻**（2026-10-03），但其运行时（daemon、可跨进程恢复的会话、chrome native host、桥接、cloud 后端、账户/自更新/管理 CLI）未实现，后台任务不等于可跨进程恢复的会话。[O1、O4] | 第三批 |
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

### 2026-10-02 增量核验：会话级 CLI 开关

以本机官方 `claude --help`（2.1.202）为基准逐项核对后，**已补齐**官方会话级开关中的 `--tools`、`--effort`、`-n/--name`、`--debug`、`--debug-file`、`--fallback-model`、`--disable-slash-commands`（[日志](更新日志/20261002-session-cli-flags.md)），以及 `-w/--worktree`、`--agent`、`--agents <json>`（[日志](更新日志/20261002-worktree-agent-flags.md)）；此前这些开关在本项目会被静默忽略（不报错也不生效），是优先修掉的原因。逐条语义、明确偏差与验证结果见对应日志。

### 2026-10-03 增量核验：stream-json 消费方契约

**已补齐** `--include-hook-events` 与 `--prompt-suggestions`（[日志](更新日志/20261003-hook-events-prompt-suggestions.md)）。两项均按官方二进制中的实际实现对齐，而非按帮助文本推测：`hook_started` / `hook_progress` / `hook_response` 三种 subtype 的字段名、31 个事件名白名单、"SessionStart 与 Setup 无条件上报、其余需开关"的门控、`hook_name` 的 `${event}:${matcher}` 规则，以及 `prompt_suggestion` 帧排在 `result` 之后。

两点明确偏差：**只上报 settings.json 声明的 hook**（进程内回调没有独立进程可观测，与官方不为 `callback` 类 hook 发帧一致）；**预测复用会话模型**而非官方专用 suggestion 端点，代价是每轮多一次小模型调用（已计入 `--max-budget-usd`），且未实现官方"同一条预测不重复输出"的去重。

### 2026-10-03 增量核验：`--brief` 简报通道

**已补齐** `--brief`（[日志](更新日志/20261003-brief-send-user-message.md)）。官方的 flag 描述只有一句 "Enable SendUserMessage tool for agent-to-user communication"——**工具本身就是该开关的全部内容**；从 240MB 二进制里进一步定位到常量池（`BRIEF_TOOL_NAME` / `DESCRIPTION` / `BRIEF_TOOL_PROMPT` / `BRIEF_PROACTIVE_SECTION` / `BRIEF_ENFORCE_SENTINEL`，以及已被取代的 `LEGACY_BRIEF_TOOL_NAME = "Brief"`），据此实现了工具、参数（`message` / `attachments` / `status`）与提示段。

三点需要如实说明的偏差：

1. **`attachments` 只接受路径形式。** 官方还接受 `{file_uuid, file_name, size, is_image}` 对象，那指向设备端上传通道，本项目没有对应物，模型也不可能合法持有这种引用——因此**报错点名拒绝**而不是静默丢弃。
2. **提示段没有照抄官方的可见性断言。** 官方原文说工具外的文字 "visible if the user expands the detail view, but most won't"；那是官方 chat view 的事实，本终端里普通助手文字完全可见。照抄会教模型不信任用户真正读得到的输出，因此保留了行为内核（ack → work → result、相位边界才发 checkpoint、第二人称、消息要短），去掉了那条断言。测试对此有专门断言。
3. **官方同名能力还有几块未实现**：settings 里的 `briefView.defaultView`（chat = 只看 SendUserMessage 检查点 / transcript = 全量）属 TUI 视图层，本轮未做；`status:"proactive"` 在本项目不触发任何特殊路由，因为那是 `--bg` 后台会话的地盘。另外二进制里还有 `BRIEF_ENFORCE_SENTINEL`（"You ended the turn without calling SendUserMessage."）与 `PEWTER_OWL_TOOL_PROMPT` / `SendUserFile` 两组常量，本轮均未实现——前者是漏调工具时的兜底提醒，后二者服务于官方的手机/桌面投递通道。

### 2026-10-03 增量核验：`--file` 启动文件资源

**已补齐** `--file <specs...>`（[日志](更新日志/20261003-file-startup-resources.md）。help 文本只说 "File resources to download at startup. Format: file_id:relative_path"，**落地目录、重试预算、API 不通时的行为一概看不出**；这三项同样从二进制取实：`<cwd>/<sessionId>/uploads/<relativePath>`、3 次重试 + `500ms·2^(n-1)` 退避（除 401/403/404 外一律重试，含 5xx）、并发 5、顺序保持、**从不抛出**（逐文件 `{success:false,error}`，会话照常启动）。

其中一处极易写错：官方用 axios `validateStatus: s => s < 500`，≥500 是抛进 catch 的、catch 同样产出可重试结果；所以**不能**把"可重试"简化成 `status < 500`。首版即栽在这里，被 503 用例当场抓住。

三点需要如实说明的偏差：

1. **畸形 spec 一律告警。** 官方对无 `:` 的 spec 是静默 `continue`、对半空的只 log 一行；本项目对两种形状都告警并点名，且裸 `--file` 直接报错。理由一致：一条没下载的 spec 绝不能看起来像下载成功了。失败项还会进系统提示的 `[STARTUP FILES]` 块——否则用户追问"我刚发的那份 PDF 呢"时，模型会凭空作答。
2. **凭据来源不同。** 官方用 Claude.ai OAuth token 打自家网关；本项目无 OAuth 流程，改用已配置的 provider key / base URL。第三方网关多半没有 Files API，表现为逐文件报错而非启动失败。已实现 base URL 的 `/v1` 归一，避免请求 `/v1/v1/files/...`。
3. **只做下载方向。** 同一模块的上传（`POST /v1/files`）、`api_files_download` 遥测三态、以及产生 `file_id` 的设备端上传入口（本项目无此入口）均未实现。也正因如此，**本轮未实机跑通一次 200 成功下载**（所配网关 OpenRouter 不提供 Files API）；真实 HTTP 往返本身已实机确认（404 打到正确 URL 并被映射为具名错误），但成功落盘路径仅由测试替身覆盖。

### 2026-10-03 增量核验：`--betas` 用户可请求的 API beta 头

**已补齐** `--betas <betas...>`（[日志](更新日志/20261003-betas-flag.md)）。本轮有一条方法论教训值得单独记：**读二进制源码得到的"纯字符串透传"结论是错的**。help 只有一句 "Beta headers to include in API requests (API key users only)"，二进制的选项注册也确实是裸 variadic、无 `argParser`（对比 `--effort` 明确带校验并写 `Warning:`），照源码读该直接实现成透传。三次实机探针否掉了这个读法：

```
$ claude -p "hi" --betas made-up-beta-xyz --output-format json
Warning: Beta header 'made-up-beta-xyz' is not allowed. Only the following betas are supported: context-1m-2025-08-07

$ claude -p "hi" --betas long_context context-1m-2025-08-07 --output-format json
Warning: Beta header 'long_context' is not allowed. Only the following betas are supported: context-1m-2025-08-07
```

回二进制取确切实现后确认六条语义：**允许清单是硬编码的单条** `context-1m-2025-08-07`（`f9s = new Set([WX])`）；**按 header 匹配而非短名**（`M_s` 以 `e.header` 为键，所以看起来"正确"的 `long_context` 被拒，而探针专门验了这条）；**逐条告警**、措辞逐字照抄；**拒绝即丢弃而非失败**，会话照常跑；**API-key 门触发时只告警一次**并全丢；旁边那张 28 条的 `PDd` 注册表是官方**自己**按模型派生的，不给用户选。

因此上一轮"以官方二进制为事实来源"的规矩要加一条更硬的：**注册表/常量只能用来定位，运行时行为必须实跑确认**。

三点偏差：

1. **beta 承载方式不同。** 官方在 Messages 请求上把它放进**请求体字段** `anthropic_beta`（数组），Files 资源才用 `anthropic-beta` 头；本项目走 Anthropic SDK，其 `messages` body 类型没有 `betas` 字段、beta 被建模为 header param，所以这里用**头**。服务端是同一个 beta 通道，但不是同一条 HTTP 线路，不假装一致。
2. **官方那道 API-key 门在本项目永不触发**（无 OAuth 登录态，全是 API key）。分支仍实现并测试了，以免将来接 OAuth 时要临时去猜官方文案。
3. **不发 `init` 帧的 `betas` 字段。** 官方 `init` 帧的 `betas` 来自 `Ob()` → `Ft.sdkBetas`，那是 **Agent SDK 宿主注入**的路径，与 `--betas` 不是同一条线；本项目没有 SDK 宿主。

未实现：官方那 28 条按模型自动派生的内部 beta、非 Anthropic provider 的 beta 透传、`CLAUDE_CODE_EXTRA_BODY` 的合并逻辑。

官方会话级开关至此全部落地或处置完毕。`--help` 上**最后一个**未实现项是跨进程后台会话子系统 `--bg` / `claude agents` —— 2026-10-03 已按"判定层完整复刻 + 运行时显式拒绝"处置，见下节。

### `--bg` / `claude agents`（2026-10-03 判定层实现）

已实现：`resolveBgStartup` 完整复刻官方 fast path 的判定序（子命令/flag 检测 → 特性门 → 预检冲突）；特性门 `isAgentsFleetEnabled` + `fleetGateMessage`（默认开启，`CLAUDE_CODE_DISABLE_AGENT_VIEW` 环境变量或 `disableAgentView` 设置关闭，拒绝语 `'--bg' is disabled by …` 逐字）；预检 `checkBgConflicts`（`--cloud`/`--remote` > `--print` > bypassPermissions > auto 四项，文案逐字，序正确）；六个隐藏子命令 `logs`/`attach`/`stop`/`kill`/`respawn`/`rm` 的路由与共享 id 解析器的纯错误分支（usage / unknown option / no match / ambiguous prefix，前缀匹配逐字）；banner 构造器 `formatBackgroundedBanner`。`disableAgentView` 注册进已知设置键白名单。

**`--help` 撒了三次谎**：① `Commands:` 段只列 `agents` 一个，六个子命令全部不在 —— 但 `--bg` 的 banner 却让用户去用其中三个；② `--bg` 与 `--print` 是硬冲突，带专属文案，注册表里只字未提；③ `claude rm --help` 自称 "works on already-exited sessions"，实测对 `done` 任务**永远失败**（先 stop 再删，done 无法 stop → "couldn't confirm … was stopped" → 状态永远删不掉）。

**运行时半未实现，显式拒绝**：本项目没有 background service 守护进程，所有会触碰进程或文件系统的路径都以点名缺口的拒绝收尾，exit 1。三条对照组已验证（`--bg` exit 1、`--tmux` exit 1、纯 prompt 走正常 agent）。未实现：daemon、PTY roster、`~/.claude/jobs/` 任务存储、attach 复用器、`agents` 交互视图、daemon 冷启动提示、`--cloud`/`--remote` 后端。详见 `docs/更新日志/20261003-bg-flag.md`。

### 隐藏 fast-path 层：内部 worker / 桥接别名 / `--cloud`（2026-10-03 判定层实现）

官方在 commander **之前**还分发一层隐藏入口（offset ~249994200），是 claude 启动**自己子进程**的通道，不是用户命令：7 个内部 worker 入口（`--claude-in-chrome-mcp`、`--chrome-native-host`、`--computer-use-mcp`、`--daemon-worker`、`--bg-pty-host`、`--bg-spare`、`--preload`），5 个 Remote-Control 桥接别名（`remote-control`/`rc`/`remote`/`sync`/`bridge`），以及 `--cloud`/`--remote` 后端旗标。误敲时本 CLI 绝不把它当 prompt 喂给模型。

已实现 `src/fast-path.ts`（纯判定，不 spawn / 不读 stdin / 不开管道），在 `cli.ts` 置于 bg 判定块**之前**（匹配官方 fast-path 先于一切的顺序）：内部 worker 仅按首位置参数匹配 → 点名缺口拒绝（官方有裸跑文案的 `--bg-spare`/`--daemon-worker` 逐字附注）；桥接别名 → 逐字复刻官方**登录门**（`Error: You must be logged in to use Remote Control. …`，账户门，非舰队门，`CLAUDE_CODE_DISABLE_AGENT_VIEW` 不改变它）；`--cloud`/`--remote` 非 TTY 逐字复刻官方 `--cloud requires an interactive terminal`、TTY 点名缺口，`--bg` 同现时让位给 bg 解析器的 "different backends" 冲突。

**甄别**：`remote`（裸词，首位置）= 桥接别名 → 登录门；`--remote`（旗标）= cloud 后端 → TTY 拒绝。二者不同路。运行时未实现（无 chrome native host、无 PTY host、无桥接、无 cloud 后端），全部命名拒绝。详见 `docs/更新日志/20261003-fast-path.md`。

### 顶层子命令（2026-10-03 判定层实现）

官方 commander 层注册 12 个顶层子命令，此前本项目对它们全部 fail-open（未识别的首位置参数被静默丢弃或当 prompt 喂模型）。已实现 `src/cli-commands.ts`（纯判定），在 `cli.ts` 置于 bg 判定块之后、会话构建之前：`agents` / `auth` / `auto-mode` / `doctor` / `gateway` / `install` / `mcp` / `plugin|plugins` / `project` / `setup-token` / `ultrareview` / `update|upgrade`（14 个拼写）全部命名拒绝，文案点名缺口并指向本项目实际机制（`auth`→.env、`mcp`→.claude/mcp.json、`update`→npm、`plugin`→会话内 /plugin）。**仅按首位置参数匹配**（可变参 flag 会吞掉后一个词，不做 commander 级解析就无法区分"子命令"与"flag 值"，首词匹配零误伤）。

**甄别**：bare `agents`（舰队视图）不在 bg-startup 的 6 个隐藏 job 子命令里，实测会落到交互启动挂起——既有 fail-open，本轮一并纳入。运行时未实现（无 OAuth 账户、无自更新器、无原生安装器、无企业网关、无 cloud 评审、无 mcp/plugin/project 管理 CLI），全部命名拒绝。详见 `docs/更新日志/20261003-top-level-subcommands.md`。

### `--ax-screen-reader`（2026-10-03 部分实现）

已实现：官方四级判定级联的完整复刻（`--ax-screen-reader` flag > `CLAUDE_AX_SCREEN_READER` 环境变量 > `screenReader.axScreenReader` 设置键），包括官方那套完整的 argv 扫描规则（精确元素匹配、`--` 截断、跳过 21 个带值 flag 的取值）；两处 `render()` 传入 Ink 的 `isScreenReaderEnabled`（扁平文本树、无边框、无颜色、无帧节流）；`--fullscreen` 在该模式下被显式丢弃并告警；交互 TTY 启动时打印官方原句 `[Accessible screen reader mode: on]`；`screenReader` 注册进已知设置键白名单。

**关键实测结论**：这个 flag 是**纯 TUI 开关**。官方九个消费者全部挂在 Ink 渲染器 / 备用屏判定 / TUI 命令面上，`--print` 路径上一个都不经过。实机对比 `claude --ax-screen-reader -p … --output-format json|stream-json|text`，除模型自身的 token 数与费用抖动外**没有任何可观测差异**。本项目行为与之一致。

偏差两条：① `--ax-screen-reader=false` 本项目**静默忽略**（结果正确 = 不启用），官方 commander 直接报 `error: unknown option` —— 这是官方无值声明的副作用，与本项目全局容忍未知 flag 的既有行为一致（`--fullscreen=false` / `--debug=maybe` 同样被容忍），不为此单开一条特例；② 官方那几个本项目不存在的消费者（强制颜色谓词、强制原生光标、DECSTBM、`/tui` 命令封锁、全屏 upsell 抑制、子进程环境变量注入）在本项目**没有对应物**，因此未实现也未声称。

未实现：官方 `Coe`/`zao` 的强制颜色与强制原生光标（Ink 模式下由扁平文本树自然覆盖，不另加谓词）、DECSTBM 滚动区域控制、`/tui` 渲染器切换封锁、全屏 upsell 抑制、向子进程（subagent / MCP）注入 `CLAUDE_AX_SCREEN_READER=1`。详见 `docs/更新日志/20261003-ax-screen-reader-flag.md`。

### `--tmux`（2026-10-03 部分实现）

已实现：argv 解析（裸 flag 与 `--tmux=<v>` 两种形状）、官方四段判定级联的完整复刻 —— 无 worktree flag → `Error: --tmux requires --worktree`；`--tmux=<v>` 且无 worktree flag → commander 风格的 `error: unknown option '--tmux=<v>'`；Windows → `Error: --tmux is not supported on Windows`；非 Windows 且 tmux 缺失 → `Error: tmux is not installed.` + 官方逐字的分平台安装指引（brew / apt+dnf / WSL / 通用）。校验发生在 worktree 创建之前，被拒的 `--tmux` 不会在磁盘上留下任何东西。

偏差三条：① 官方在 worktree flag 之后、平台判定之前插了一道 workspace trust 门（`hasTrustDialogAccepted`），本项目不复刻 —— 本项目的 trust 模型是"项目 ALLOW 规则指纹"（`confirmProjectAllowRules`），与官方那种整目录信任对话框不同源，借用官方的文案等于宣告一个本项目没有的对话框；本项目自己的 trust 门仍在原位运行。② 平台判定之前会先探一次 `tmux -V` 的分支已短路：Windows 上不会为了告知"tmux 无关"而白 spawn 一个进程（官方也是平台门先于探测）。③ 非 Windows 且 tmux 已装时，明确报"缺的是 pane 会话创建本身"而不是静默忽略。

未实现：tmux pane 会话创建（官方 `createTmuxSessionForWorktree`）、iTerm2 原生 pane 后端（官方默认在检测到 iTerm2 + `it2` CLI 时走这条）、agent swarms 的 pane 编排与 `teammateMode` 后端选择（官方 BackendRegistry 的 8 分支级联）。本项目在这三条上都是**显式失败**，不存在静默降级。详见 `docs/更新日志/20261003-tmux-flag.md`。

### `--from-pr [value]`（2026-10-03 部分实现）

已实现：`--from-pr <PR 号 | PR URL>` 解析、`gh pr view` 往返（缺 `gh` / 失败 / 非法 URL 都是具名硬错误）、按 `prNumber` + `prRepository` 查已链接会话并恢复、PR linkage 落盘到会话元数据。

偏差三条：① 官方在查不到链接会话时**静默开新会话**（两次实机 `claude -p` 确认），本项目改为打印提示并把新会话链到该 PR；② 裸 `--from-pr`（交互式选择器）本项目直接报错退出，不静默开新会话；③ linkage 由用户显式建立，不像官方那样从当前分支自动推断（官方靠自己的 GitHub 集成打标）。

未实现：交互式 PR 选择器、按分支自动建立 linkage、`gh pr list`/richer PR 字段（title / state / draft / reviewDecision / statusCheckRollup）。详见 `docs/更新日志/20261003-from-pr-flag.md`。

### 初次核验（历史记录）

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
