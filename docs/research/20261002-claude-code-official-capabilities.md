# Claude Code 官方公开能力核对

核对日期：2026-10-02（Asia/Shanghai）。范围：本次实际读取的 Anthropic 一手公开文档；这是官方能力证据清单，本地代码差距由主审查报告另行对照。

状态说明：下列能力均已从相应官方页面正文确认。文档是在线滚动更新版本，没有安装官方 CLI，也没有确认官方 npm 发布的最新版本；不能将文档提到的最低版本或截图中的版本当成最新版本。官方 `anthropics/claude-code` 的 raw GitHub README/CHANGELOG 本次读取因 Windows 证书吊销检查错误 `CRYPT_E_NO_REVOCATION_CHECK` 失败，未据此作任何更新日志结论。

主审查补充：工作区所在机器已安装官方 CLI，`claude --version` 返回 **2.1.202**；已读取其公开 `--help`、随安装包发布的 README 和 `sdk-tools.d.ts`。这只确认本机版本和公开契约，没有确认官方最新发布版本，也没有读取账号、用户配置或会话。详见 [差距评估](../claude-code差距评估-20261002.md)。

## 核心规则、记忆与配置

| 已确认能力 | 一手来源及短证据 | 边界／核对要点 |
| --- | --- | --- |
| 用户、项目、本地、组织 CLAUDE.md 层级 | [Memory](https://code.claude.com/docs/en/memory)：`Managed policy`、`User instructions`、`Project instructions`、`Local instructions` | `~/.claude/CLAUDE.md`、`CLAUDE.md`／`.claude/CLAUDE.md`、`CLAUDE.local.md`，以及系统级组织文件。 |
| 祖先目录加载、子目录按需加载 | [Memory](https://code.claude.com/docs/en/memory)：“Files in subdirectories load on demand when Claude reads files in those directories.” | 指令拼接而非配置覆盖；近目录内容排在后面。 |
| CLAUDE.md 导入 | [Memory](https://code.claude.com/docs/en/memory)：“using `@path/to/import` syntax”；“maximum depth of four hops” | 相对导入按包含它的文件目录解析；项目外部导入有信任处理。 |
| 路径规则 | [Memory](https://code.claude.com/docs/en/memory)：“.claude/rules/”；“`paths` field” | 无路径规则启动加载；有 glob 路径的规则按匹配文件工作时加载。 |
| AGENTS.md 直接读取 | [Memory](https://code.claude.com/docs/en/memory)：“confirm v2.1.277 or later”；“Claude reads it instead of AGENTS.md unless you set ... `claude-md-and-agents-md`” | 默认在项目路径没有 CLAUDE.md／CLAUDE.local.md 时读取 AGENTS.md；具体行为可配置。不能笼统认为官方始终不读 AGENTS.md。 |
| 自动长期记忆 | [Memory](https://code.claude.com/docs/en/memory)：“first 200 lines ... or the first 25KB, whichever comes first”；“topic files ... on demand” | `~/.claude/projects/<project>/memory/MEMORY.md` 是索引，首 200 行或 25KB 注入，详情文件按需读取。相同 git repo 的 worktrees／子目录共享；本机存储、不跨机器同步。 |
| 自动记忆类别与配置 | [Memory](https://code.claude.com/docs/en/memory)：“user”；“feedback”；“project”；“reference”；“autoMemoryEnabled” | 保存偏好、反馈、代码不可直接推导的项目事实、外部参考。不要用“全会话历史永久记忆”描述。 |
| 配置层级与优先级 | [Settings](https://code.claude.com/docs/en/settings)：“highest first: managed settings, command line, project local, shared project, user” | `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、CLI、managed；权限规则有独立合并语义及更严格安全值例外。 |
| Managed policy 多种分发 | [Managed settings](https://code.claude.com/docs/en/managed-settings)：“no user, project, local, or `--settings` value overrides them”；[Settings](https://code.claude.com/docs/en/settings)：“MDM or OS-level policies”；“claude.ai console” | 系统文件、操作系统策略／MDM、服务端组织策略及嵌入宿主。与简单加载一个用户 JSON 的行为不同。 |
| Auto 与 dontAsk 权限模式 | [Permission modes](https://code.claude.com/docs/en/permission-modes)：“a second model, the classifier, reviews actions instead of you”；`dontAsk`：“anything that would prompt is denied” | 官方有 default／acceptEdits／plan／auto／dontAsk／bypassPermissions。auto 使用独立风险分类模型，和绕过权限、预先同意编辑不同；可用性依赖模型及组织策略。文档称 v2.1.283 起 terminal／VS Code 内置默认 auto，但没有因此确认当前最新版本。 |

## 扩展与执行

| 已确认能力 | 一手来源及短证据 | 边界／核对要点 |
| --- | --- | --- |
| Skills 与旧 commands 兼容 | [Skills](https://code.claude.com/docs/en/skills)：“Custom commands have been merged into skills.” | `.claude/commands/name.md` 与 `.claude/skills/name/SKILL.md` 都产生 `/name`；skills 还支持辅助文件目录。 |
| Skills 精细 frontmatter | [Skills](https://code.claude.com/docs/en/skills)：`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context` | 支持手动／模型调用可见性、参数及命名替换、调用时工具与模型控制、`context: fork`。需要核对运行语义，不能仅凭解析字段算完整支持。 |
| Subagents 深度配置 | [Subagents](https://code.claude.com/docs/en/sub-agents)：`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`isolation` | 用户／项目／本地持久记忆、预加载技能、子代理 hooks 与 MCP、后台运行、worktree 隔离。plugin subagents 有部分字段不生效的明确限制。 |
| 子代理的独立记忆边界 | [Memory](https://code.claude.com/docs/en/memory)：“main conversation's auto memory isn't loaded into subagents”；“A subagent's own auto memory ... is a separate directory” | fork 继承对话是例外；普通子代理不能被视为自动继承父所有长期记忆。 |
| Plugins 与 marketplace | [Plugins](https://code.claude.com/docs/en/plugins/overview)：“skills, agents, hooks, MCP servers ... as one unit”；“`.claude-plugin/plugin.json`”；“`.claude-plugin/marketplace.json`” | 版本化包／市场发现、不同安装作用域、更新／禁用／卸载与加载语义；不等同于磁盘加载单个 skill。 |
| 插件驱动 LSP | [Code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence)：“Diagnostics after edits”；“an `LSP` tool ... symbols ... instead of searching text” | 编辑后实时诊断与按符号导航；插件和语言服务器 binary 均需安装；云会话不启动这些 LSP。 |
| 完整 hooks 生命周期和执行形式 | [Hooks](https://code.claude.com/docs/en/hooks)：“shell commands, HTTP endpoints, MCP tool calls, LLM prompts, or subagents” | 事件包含 PreToolUse／PostToolUse／PostToolUseFailure、PermissionRequest／PermissionDenied、SessionStart／End、InstructionsLoaded、SubagentStart／Stop、TaskCreated／Completed、CwdChanged、FileChanged、WorktreeCreate／Remove、PreCompact／PostCompact、Elicitation 等；支持 JSON 输入输出、匹配、异步。 |
| MCP 传输、鉴权、动态刷新 | [MCP](https://code.claude.com/docs/en/mcp)：“HTTP supports OAuth”；“`list_changed` notifications”；“tools, prompts, and resources” | stdio、HTTP、兼容 SSE，另有 WebSocket 配置；OAuth 按端点存储，动态发现更新失败保留上次能力。不能只比较 tools/list。 |
| MCP elicitation 和工具搜索 | [MCP](https://code.claude.com/docs/en/mcp)：“request structured input ... interactive dialog”；“With tool search, the default” | 服务器可在任务中请求用户结构化输入；大型工具目录按需发现。对自定义 API base URL／某些模型存在 tool search 可用性边界。 |
| Mods 程序化界面扩展 | [Mods](https://code.claude.com/docs/en/plugins/mods/overview)：“Draw an interface you can use”；“Redraw Claude Code's own interface”；“Run your own code on a command” | JS／TS 插件可画面板、按钮、输入，重画提问框／spinner／tool rows，并干预调用；在 CLI 和 Desktop Code tab 运行，其他界面有不同限制。 |

## 隔离、会话、持续工作

| 已确认能力 | 一手来源及短证据 | 边界／核对要点 |
| --- | --- | --- |
| OS 级 shell 沙箱 | [Sandboxing](https://code.claude.com/docs/en/sandboxing)：“macOS, Linux, and WSL2”；“On native Windows ... unsandboxed” | **官方也没有 native Windows 的此类沙箱**。macOS Seatbelt；Linux／WSL2 bubblewrap 与 socat。官方 shell 沙箱覆盖 shell 命令，文件工具、hooks、MCP 在它之外，不应描述为所有工具统一 OS 隔离。 |
| 文件系统与网络沙箱及严格不可用处理 | [Sandboxing](https://code.claude.com/docs/en/sandboxing)：“`sandbox.failIfUnavailable` ... `true`”；“network isolation” | 可配置路径、网络域名／代理等；缺依赖／不支持平台时默认未隔离运行，严格部署可要求启动失败。 |
| Checkpoints 持久与恢复 | [Checkpointing](https://code.claude.com/docs/en/checkpointing)：“100 most recent checkpoints”；“saves checkpoints with the conversation” | 每个启动 turn 的 prompt 自动建立；resume 后仍可 rewind；默认约 30 天 retention sweep，可配置。 |
| 多种 rewind／局部压缩 | [Checkpointing](https://code.claude.com/docs/en/checkpointing)：“Restore code and conversation”；“Restore conversation”；“Restore code”；“Summarize from here”；“Summarize up to here” | Esc 双击或 `/rewind`；输入非空时双 Esc 清空；支持指定点前／后压缩和引导摘要。 |
| Rewind 的真实范围 | [Checkpointing](https://code.claude.com/docs/en/checkpointing)：“Bash command changes not tracked”；“Subagent edits not restored”；“Symlinked and hard-linked paths not restored” | **Bash 改文件也不是官方 rewind 可恢复内容**。普通／后台子代理修改通常不恢复，前台 `context: fork` skill 是例外；外部改动和 symlink／hardlink 有限制。不要将这些相同限制算成本地独有差距。 |
| 会话定时任务可恢复 | [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)：“When you resume ... restores tasks that haven't expired”；“seven-day expiry” | `/loop`／cron 是 session-scoped，当前文档明确 resume 会恢复未过期任务，但存在限制；运行仍需会话保持开启。不能套用旧版本“重启永远丢失”描述。 |
| 长期目标与独立评估 | [Goal](https://code.claude.com/docs/en/goal)：“After each turn, a small fast model checks whether the condition holds.” | `/goal` 用独立模型判定 completion condition，未满足则继续 turn；不是单纯重复定时发提示。 |
| Dynamic workflows | [Workflows](https://code.claude.com/docs/en/workflows)：“JavaScript script ... runtime executes ... in the background”；“Dozens to hundreds of agents per run” | 可复用脚本持有分支、循环和中间结果；与模型逐 turn 协调区别明确；官方文档列 paid／API／cloud providers 可用，Pro 从 config 开启。 |
| Agent teams | [Agent teams](https://code.claude.com/docs/en/agent-teams)：“experimental and disabled by default”；“`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`” | **实验性**，独立 peers、共享 task list 与直接消息；session resume、task coordination、shutdown 有已知限制。 |

## SDK、集成与账号生态

| 已确认能力 | 一手来源及短证据 | 边界／核对要点 |
| --- | --- | --- |
| Headless CLI | [Headless](https://code.claude.com/docs/en/headless)：“`-p` (or `--print`)”；“`--output-format`”；“`--bare`” | 非交互脚本／stdin／CI、JSON 与 streaming、session resume；bare 跳过自动加载以保证脚本环境可控，当前文档仍非 `-p` 默认。 |
| Agent SDK Python／TypeScript | [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)：“same tools, agent loop, and context management”；“programmable in Python and TypeScript” | 嵌入库运行官方 CLI binary，提供 sessions、permissions、hooks、subagents、MCP、plugins；不是直接调用模型 Client SDK 的同义词。 |
| IDE 集成 | [VS Code](https://code.claude.com/docs/en/vs-code)：“inline diffs, @-mentions, plan review”；“automatically sees your selected text”；[Plugins](https://code.claude.com/docs/en/plugins/overview)：“VS Code extension or the JetBrains plugin” | 官方 VS Code 扩展／JetBrains 插件；选择上下文、逐改动 diff 审批和界面联动。终端运行在 IDE 内不代表实现此能力。 |
| Chrome 浏览器连接 | [Chrome](https://code.claude.com/docs/en/chrome)：“Google Chrome and Microsoft Edge”；“isn't supported in ... WSL” | 浏览器自动化、页面交互、console 与表单流程；native Windows 可用，WSL 不支持。 |
| Remote Control | [Remote Control](https://code.claude.com/docs/en/remote-control)：“code execution and filesystem access stay on your machine”；“API keys are not supported” | 从手机／浏览器接入本地会话；需 Pro／Max／Team／Enterprise claude.ai 登录、机器与进程在线；不支持 Bedrock／Google／Foundry、自定义 API base URL／enterprise gateway。 |
| 云端 Web／移动会话 | [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)：“keeps running after you close your laptop”；“`--cloud` and `--teleport`” | 托管或组织 self-hosted 云环境；Browser／mobile／Desktop／CLI 均可进入，支持本地与云移交，账号套餐条件明确。 |
| Desktop 完整工作区 | [Desktop](https://code.claude.com/docs/en/desktop)：“parallel sessions with Git isolation ... integrated terminal and file editor ... visual diff review ... app previews ... PR monitoring” | 独立产品界面与后端会话体系；支持 Local、Cloud、SSH、Windows WSL。Linux Desktop 标注 **beta**。 |
| GitHub Actions／GitLab CI | [GitHub Actions](https://code.claude.com/docs/en/github-actions)：“respond to @claude mentions ... turn issues into pull requests”；[官方文档索引](https://code.claude.com/docs/llms.txt)：“Claude Code GitLab CI/CD” | GitHub Actions 全文已读取；GitLab 此次只从官方索引确认页面与能力概述，没有深度验证集成细节。 |
| Cloud Routines | [Routines](https://code.claude.com/docs/en/routines)：“research preview”；“Scheduled”；“API”；“GitHub” | **研究预览**，运行独立于打开的本地会话；saved prompt／repos／connectors，多触发方式，Pro／Max／Team／Enterprise。 |
| 语音输入 | [Voice dictation](https://code.claude.com/docs/en/voice-dictation)：“hold-to-record or tap-to-record”；“A Claude.ai account”；“Audio is not processed locally.” | CLI 与 VS Code 支持麦克风实时转文字；native Windows 支持，WSL 要 WSLg；API key／Bedrock／Google／Foundry、cloud／SSH 不支持。不是模型端实时双向语音。 |
| 账号与云认证 | [Authentication](https://code.claude.com/docs/en/authentication)：“claude.ai account”；“Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry”；“corporate SSO” | 官方订阅／Console OAuth 与 API keys、云身份链和 enterprise gateway；本地多模型 API key 适配无法等同订阅计费／权限生态。 |
| 第三方 SDK 登录边界 | [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)：“Unless previously approved ... does not allow third party developers to offer claude.ai login or rate limits for their products” | 属于官方服务接入限制；不能把订阅登录简单列为复制一个 CLI 登录流程即可获得的功能。 |

## 不应凭本次研究下结论的事项

- 最新官方发布版本、所有 CHANGELOG 中变更：官方 raw GitHub 文件不可访问，未核实。
- 官方私有实现架构、内部提示词或可靠性优势的百分比：文档不构成源码、基准或实测证据。
- 所有套餐／平台始终拥有每个功能：已确认的条件应跟随对应能力描述；agent teams 为 experimental，routines 为 research preview，Linux Desktop 为 beta。
- 本项目是否缺功能：需要实际本地调用路径、状态生命周期及测试对照；仅有同名命令／文件／工具不能证明语义兼容。
