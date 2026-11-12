# 独立生态与配置规则

更新：2026-11-12，适用 v1.6.1 工作区增量。此页描述本项目实际消费的格式；不承诺直接运行官方扩展或读取官方账号凭据。第三方模型继续使用本项目的 provider/路由和 `LLM_*` 配置。

## 根目录与来源

| 来源 | 默认位置 | 覆盖与边界 |
|---|---|---|
| 用户根 | `~/.claude-code-replica/` | `CCR_USER_CONFIG_DIR` 可显式重定向，建议绝对路径 |
| 项目根 | `<workspace>/.claude/` | 本项目沿用这个目录名；目录内格式以本文为准 |
| 显式旧位置开关 | `CCR_COMPAT_CLAUDE=1` | 未指定用户根时改用 `~/.claude/`，并允许发现项目 `.mcp.json`；默认关闭，不应当作独立部署的必需配置 |
| 用户扩展独立重定向 | `CCR_USER_SKILLS_DIR`、`CCR_USER_AGENTS_DIR`、`CCR_USER_COMMANDS_DIR` | 分别覆盖对应用户扩展目录，不改变设置或其他扩展的根 |

默认 MCP 使用用户 `mcp.json`、项目 `.claude/mcp.json` 和已安装插件配置。不会自动发现 `~/.claude.json`，也不读取官方订阅登录令牌。项目指令保留 `CLAUDE.md` / `AGENTS.md` 文件名，不代表与官方用户目录或完整语义共用。

## 设置合并与凭据

常规设置从低到高合并：用户 `settings.json` → 项目 `.claude/settings.json` → 本地 `.claude/settings.local.json` → `--settings <文件或内联 JSON>` → `CCR_MANAGED_SETTINGS` 指定文件。

对象递归合并；数组累积并去重；标量由高优先级覆盖。因此空数组不会清除较低层数组。`--setting-sources user,project,local` 或 `CCR_SETTING_SOURCES` 选择前三种来源，顺序始终固定，不按参数排列改变；空字符串关闭前三层，显式和 managed 层仍会读取。写入命令按键所属的活动磁盘层选择目标，managed 和内联 CLI 覆盖不等于可写持久目标。

`env` 单独限制来源：只允许活动 user 层、显式 `--settings`、managed 层；项目/local 的 env 不注入进程。字段只接受字符串值。优先级为现有进程环境 > managed env > 显式 settings env > 活动 user env；设置只填补未定义环境变量，不覆盖已有值。启动时 dotenv 已按进程环境、当前目录 `.env`、安装目录 `.env` 的顺序补值，因此这些值也高于 settings env。

凭据可以只保存在信任的 settings env，交互启动与 `loadConfig` 使用同一个读取规则，无需额外创建 `.env`。不要提交含凭据的设置文件。停用 user 设置来源也会停用其中的 env，但该开关仅选择设置文件，不是关闭用户 skills、agents 或指令的总开关。

当前识别的顶层设置如下。未列出的顶层键在启动时报告 `unsupported settings key ignored`；这不是完整 schema 校验，嵌套的未知字段可能仍被忽略。

| 顶层键 | 实际用途 |
|---|---|
| `model` | 模型名字符串，或模型对象的 `provider` / `name`；CLI / 环境选择还会参与最终路由 |
| `env` | 上述受限来源的字符串环境变量 |
| `permissions`、`permissionMode` | allow/deny/ask、默认权限模式；项目授权放宽另经内容指纹信任，deny 保留 |
| `hooks` | 本项目 hook 配置与执行协议；项目/local 可执行配置经指纹信任 |
| `telemetry` | 本地记录开关 `enabled`；不向网络上传 |
| `screenReader` | `axScreenReader` 显示与交互行为 |
| `disableAgentView` | 后台代理视图功能开关 |
| `memory` | `requireApproval` 用户记忆写入确认；采用只能收紧的层级规则 |
| `subagents` | `thinking`、`sidechainMode`（`audit` / `report`） |
| `disabledMcpjsonServers` | 按配置中的原始 server 名禁用文件和插件内联 MCP；不是包名或包装后的工具名 |

损坏 JSON 会告警后忽略该文件；这会同时丢弃其中的权限规则，不是 fail-closed 配置校验。切换命令拒绝覆盖损坏的设置文件。`--safe-mode` / `--bare` 抑制扩展等定制加载，不等于删除所有权限与 managed 约束。

## 指令发现

顺序为：本项目用户根的 `CLAUDE.md` 与 `.claude/rules/` → 从文件系统祖先到 workspace 的逐层指令和 rules → 访问文件时加载 workspace 内路径上的子目录指令/匹配 rules → `CCR_MANAGED_INSTRUCTIONS`。

每层按 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 查找；没有找到这些文件时退回 `AGENTS.md`。`CCR_INSTRUCTION_FILES=both` 会同时读取 AGENTS。规则文件位于每层 `.claude/rules/**/*.md`；frontmatter `paths` 以该层目录为基准匹配。用户根的规则路径因此是 `<user-root>/.claude/rules/`，不是 `<user-root>/rules/`。

指令中的 `@file.md` 导入默认不能越出所属目录的信任根，代码围栏内的示例不导入；递归深度和单文件体积有上限。`CCR_TRUST_INSTRUCTION_IMPORTS=1` 显式放宽导入边界。safe/bare 仅保留显式 managed 指令。路径指令的注入、已读去重与已有内容变化由 `instructionAttachment` 管理。

## 磁盘扩展

| 类型 | 文件布局 | 注册/调用规则 |
|---|---|---|
| Skill | 用户/项目 `skills/<目录名>/SKILL.md` | 用户先、项目后；同名大小写不敏感，后注册覆盖；模型仅看发现目录，调用时展开正文 |
| Command | 用户/项目 `commands/**/*.md` | 递归，注册名来自文件名，后注册覆盖；正文按提示词模板执行 |
| Agent | 用户/项目 `agents/**/*.md` | 递归，frontmatter name 可改注册名；用户先、项目后；CLI 内联代理最后覆盖 |

Skill 实际读取的字段：`name`、`description`、`group`、`whenToUse`、`context`（inline/fork）、`agent`、`model`、`effort`（low/medium/high/xhigh/max）、`hooks`、`allowed-tools`/`allowedTools`、`disallowed-tools`/`disallowedTools`、`disable-model-invocation`、`user-invocable`。用户来源才可提供自动授权 grant 和 hooks；项目的工具列表在 fork 中作为限制。模板的 shell/env 展开沿用安装即信任策略，模型触发项目 shell 模板另有审批门。

Agent 实际读取的字段：`name`、`description`、`whenToUse`、`tools`、`disallowedTools`/`disallowed-tools`、`model`、`effort`、`thinking`、`skills`、`permissionMode`、`hooks`、`background`、`isolation`（worktree）、`omitClaudeMd`/`omit-claude-md`、`mcpServers`、`maxTurns`、`memory`（user/project/local）。工具缺省时继承；委派仍保留父级权限限制。项目 agent hooks / 预加载 skill 的可执行配置另经信任门。

Command 的前置元数据目前只消费 `description`，名称来自文件名。`model`、`allowed-tools`、`argument-hint` 等字段当前不改变执行行为；正文中的参数和 shell 模板仍会展开。扩展 frontmatter 的未知字段没有统一告警，不能把解析成功当成字段已支持。

workspace 切换会重建磁盘 command/skill/custom-agent 注册表：移除旧项目内容，重新读取用户和新项目，重新应用会话内联 agents。模型与 CLI 的发现列表来自注册表。

## 插件与 MCP

插件从用户 `plugins/` → 项目 `.claude/plugins/` → 显式 `--plugin-dir` 读取。manifest 为 `.claude-plugin/plugin.json`，否则 `plugin.json`；安装器以 `name` 创建目录。要求安全名称和 semver，组件路径不能绝对定位或包含 `..`。

manifest 消费 `name`、`version`、`description`、`dependencies`、`skills`、`commands`、`agents`、`hooks`、`mcp`、`mcpServers`、`lspServers`、`disabled`。组件依次读取 `.claude/<kind>`、`<kind>`、manifest 声明路径，去重后按后者覆盖。技能/命令/代理注册为 `pluginName:name`，MCP server 包装为 `pluginName__server`。同名插件当前按组件注册顺序覆盖，不承诺整个旧插件被完整遮蔽；dependencies 用于依赖检查，不自动安装依赖。

MCP 文件发现顺序为：显式 `--mcp-config` → 用户 `mcp.json` → opt-in 的项目 `.mcp.json` → 项目 `.claude/mcp.json` → 插件文件；同 server 名已连接时保留先连接者并告警。插件文件可来自 manifest `mcp` / 字符串 `mcpServers`、`.mcp.json`、`mcp.json`、`.claude/mcp.json`。插件对象形式 `mcpServers` 在文件之后加载，使用同一条目校验、disabled 和全局名称禁用规则。

`--strict-mcp-config` 只加载显式 MCP 配置，包含禁止自动插件内联配置；safe/bare 不加载任何 MCP。MCP `disabled:true` 跳过该条目，不会为后续配置预留该名字；全局禁用名单则对所有来源的原始名字生效。项目配置需内容指纹信任，插件配置保留安装即信任取舍。transport 支持 stdio/http/sse/ws，command 形式可推断 stdio。单个 server 的工具权限审批仍独立存在。

## 验收与后续

固定入口：`npm run test:core` 中的 `ecosystem-contract.test.ts`。覆盖独立根、设置合并/来源、env、项目覆盖、插件命名空间、workspace 重建、指令、未知顶层设置，以及真实 MCP 子进程禁用与正向工具往返。发布包烟测另验证只用 settings 凭据进入交互 CLI。

尚未完成的生态矩阵包括：嵌套/扩展未知字段的统一诊断、同名插件整包语义、插件依赖/LSP/marketplace 的组合验收及运行中配置热更新。完整编码任务效果和多模型质量继续使用独立任务套件衡量，以上配置验收不等于整体目标完成。
