# Claude Code 源码模块详解

> 本文档针对 `cc-recovered-main`（即从 source map 逆向恢复的 Claude Code 2.1.88 工程）逐一说明每个目录（模块）的职责，以及目录下各代码文件的作用。
>
> 说明：该工程为逆向恢复版本，部分文件是兼容层 / shim / stub，仅用于保证可安装、可构建，不代表官方原始实现。

## 根目录文件

- `.gitignore` — Git 忽略规则文件。
- `package-lock.json` — npm 依赖锁定文件，固定各依赖的精确版本。
- `package.json` — npm 包清单：项目名、版本、依赖、构建脚本（`npm run build` 等）。
- `README.md` — 项目说明（英文）。
- `README.zh-CN.md` — 项目说明（中文）。

## scripts

构建脚本目录，负责用 esbuild 把 `src` 打包成可运行的 `dist/cli.js`。

- `build.mjs` — 构建脚本：用 esbuild 打包 `src` 为 `dist/cli.js`。

## src

核心源码目录，包含 CLI 入口、斜杠命令、终端/桌面交互 UI、Agent 工具、业务服务、全局状态、类型与各类工具函数。

- `commands.ts` — 命令注册表：汇总所有内置斜杠命令，提供 `getCommands`/`findCommand` 等查询与过滤接口。
- `context.ts` — 会话上下文对象：当前工作目录、配置、工具权限上下文等。
- `cost-tracker.ts` — 成本追踪：统计并展示 API 费用、Token 用量、耗时等汇总信息。
- `costHook.ts` — 成本相关的 React hook。
- `dialogLaunchers.tsx` — 对话框启动器：统一打开各类 UI 对话框。
- `history.ts` — 会话历史记录相关逻辑。
- `ink.ts` — Ink 终端渲染的入口与配置。
- `interactiveHelpers.tsx` — 交互式 UI 辅助函数与组件。
- `main.tsx` — CLI 主入口：启动 REPL / 主循环并接入全局状态。
- `projectOnboardingState.ts` — 项目新手引导（onboarding）状态管理。
- `query.ts` — 代码库查询接口定义。
- `QueryEngine.ts` — 查询引擎实现：对代码库执行检索/查询。
- `replLauncher.tsx` — REPL 启动器：初始化并进入交互式会话。
- `setup.ts` — 初始化与设置流程。
- `Task.ts` — 任务（Task）的类型 / 类定义。
- `tasks.ts` — 任务相关定义与工具。
- `Tool.ts` — 工具（Tool）基类 / 类型定义。
- `tools.ts` — 工具注册与汇总：定义各 Agent 工具。

### src/assistant

助手历史（session history）：拉取并按页加载会话的历史事件。

- `sessionHistory.ts` — 助手历史：分页拉取并展示会话历史事件。

### src/bootstrap

引导与全局运行时状态：集中保存会话 ID、工作目录、成本/时长/Token 等全局计数器与状态。

- `state.ts` — 全局运行时状态：会话 ID、工作目录、成本/时长/Token 计数器等集中存储与访问。

### src/bridge

远程控制（Remote Control）桥接层：把本地 Claude Code 会话与 claude.ai/移动端之间的消息、权限、凭据和轮询连接起来。

- `bridgeApi.ts` — Bridge API 客户端：校验 bridge id、封装请求、定义过期/403 等错误类型。
- `bridgeConfig.ts` — Bridge 配置读取：token / baseUrl 覆盖与 access token。
- `bridgeDebug.ts` — Bridge 调试钩子：注册调试句柄、注入故障、包装请求以便测试。
- `bridgeEnabled.ts` — 判断 Bridge 是否启用及禁用原因（含环境变量、版本、CSE shim 检查）。
- `bridgeMain.ts` — Bridge 主循环：轮询工作、解析参数、处理连接/服务错误，支持 headless 运行。
- `bridgeMessaging.ts` — Bridge 消息处理：SDK 消息校验、入站消息处理、控制请求/响应路由。
- `bridgePermissionCallbacks.ts` — Bridge 权限回调的类型定义。
- `bridgePointer.ts` — Bridge 指针：跨 worktree 读写 bridge pointer。
- `bridgeStatusUtil.ts` — Bridge 状态展示工具：状态文本、闪烁段、连接/会话 URL、页脚文本。
- `bridgeUI.ts` — Bridge UI 日志器：状态指示、spinner 等。
- `capacityWake.ts` — 容量唤醒信号（capacity wake）的实现。
- `codeSessionApi.ts` — 远程凭据获取与 code session 创建 API。
- `createSession.ts` — 创建 / 获取 / 归档 / 更新标题的 bridge 会话。
- `debugUtils.ts` — 调试工具：脱敏、截断、错误描述、日志。
- `envLessBridgeConfig.ts` — 无环境变量 Bridge 配置与最低版本检查。
- `flushGate.ts` — FlushGate：批量 flush 门控。
- `inboundAttachments.ts` — 入站附件提取与解析（下载/路径引用）。
- `inboundMessages.ts` — 入站消息字段提取与图片块规范化。
- `initReplBridge.ts` — 初始化 REPL Bridge（策略检查后启动）。
- `jwtUtils.ts` — JWT 解码、过期检查与令牌刷新调度。
- `pollConfig.ts` — 轮询间隔配置读取。
- `pollConfigDefaults.ts` — 轮询间隔默认配置常量。
- `remoteBridgeCore.ts` — 无环境变量 Bridge 核心初始化与远程凭据获取。
- `replBridge.ts` — REPL Bridge 核心句柄与状态（initBridgeCore）。
- `replBridgeHandle.ts` — REPL Bridge 句柄的读写与自兼容 ID。
- `replBridgeTransport.ts` — REPL Bridge 传输层（v1/v2 传输实现）。
- `sessionIdCompat.ts` — 会话 ID 兼容转换（CSE shim / infra 会话 ID）。
- `sessionRunner.ts` — 会话 spawner：安全文件名、权限请求与 spawn 逻辑。
- `trustedDevice.ts` — 受信设备令牌的获取、缓存清理、注销与注册。
- `types.ts` — Bridge 类型定义：WorkData、SessionHandle、BridgeConfig、SessionSpawner 等。
- `workSecret.ts` — work secret 解码、SDK URL 构造与 worker 注册。

### src/buddy

桌面版“伙伴”宠物动画（Companion Sprite）：输入框旁的小动物像素动画与提示气泡。

- `companion.ts` — 伙伴实例：随机 roll / 带种子 roll 并获取当前 companion。
- `CompanionSprite.tsx` — 伙伴像素动画组件与浮动气泡（CompanionFloatingBubble）。
- `prompt.ts` — 伙伴介绍文本与 intro attachment。
- `sprites.ts` — 精灵渲染：各物种的像素帧与表情。
- `types.ts` — 伙伴物种、稀有度、表情等类型定义。
- `useBuddyNotification.tsx` — 伙伴通知 hook 与触发位置检测。

### src/cli

CLI 输出与传输层：结构化输出（JSON/NDJSON）、远程 IO、SSE/WebSocket 等传输，以及 auth/mcp/plugins/agents 等 CLI 子命令处理器。

- `exit.ts` — 退出工具：`cliError`/`cliOk` 打印结果并退出进程。
- `ndjsonSafeStringify.ts` — NDJSON 安全序列化（转义 U+2028/U+2029 行结束符）。
- `print.ts` — 输出打印与 headless 运行辅助（权限提示、MCP 服务器管理、消息整理）。
- `remoteIO.ts` — 远程 IO（RemoteIO）封装：会话状态/元数据变更监听。
- `structuredIO.ts` — 结构化 IO：结构化输出与 MCP JSON-RPC 消息处理。
- `update.ts` — 更新逻辑：检查最新版本并安装全局包。

#### src/cli/handlers

CLI 子命令处理器：`agents`、`auth`、`autoMode`、`mcp`、`plugins` 及通用 `util`（setup-token/doctor/install）的处理逻辑。

- `agents.ts` — agentsHandler：列出并按来源/名称比较可用代理。
- `auth.ts` — 认证处理器：OAuth 令牌安装、登录、状态、登出。
- `autoMode.ts` — 自动模式处理器：defaults / config / critique。
- `mcp.tsx` — MCP 处理器：serve / remove / list / get / add / resetChoices。
- `plugins.ts` — 插件处理器：marketplace 与 plugin 的增删查改、安装、启停、更新、校验。
- `util.tsx` — 通用处理器：setupToken / doctor / install。

#### src/cli/transports

CLI 传输层：SSE、WebSocket、混合传输以及 CCR 客户端、事件批量上传器、Worker 状态上报器。

- `ccrClient.ts` — CCR 客户端：流累积、事件解析（远程客户端）。
- `HybridTransport.ts` — 混合传输（组合 WebSocket / SSE 等）。
- `SerialBatchEventUploader.ts` — 串行批量事件上传器（带重试与重试延迟）。
- `SSETransport.ts` — SSE 传输与帧解析（带重连/退避）。
- `transportUtils.ts` — 根据 URL 选择对应传输。
- `WebSocketTransport.ts` — WebSocket 传输实现。
- `WorkerStateUploader.ts` — Worker 状态上报器（带延迟/重试）。

### src/commands

斜杠命令（`/`）集合：每个子目录或文件对应一个用户可执行的命令，如 `/config`、`/model`、`/review`、`/mcp`、`/plugin` 等。

- `advisor.ts` — `/advisor` 命令：配置顾问（advisor）模型。
- `bridge-kick.ts` — `/bridge-kick` 调试命令：模拟 bridge 关闭或下一次轮询错误。
- `brief.ts` — `/brief` 命令：生成 / 查看 brief。
- `commit-push-pr.ts` — `/commit-push-pr` 命令：提交、推送并创建 PR。
- `commit.ts` — `/commit` 命令：生成并创建 git commit。
- `createMovedToPluginCommand.ts` — 辅助函数：创建“已迁移到插件”的占位命令。
- `init-verifiers.ts` — `/init-verifiers` 命令：初始化 verifiers（prompt 型命令）。
- `init.ts` — `/init` 命令：分析代码库并生成 `CLAUDE.md`。
- `insights.ts` — insights / 用量报告：构建导出数据、检测多开、生成使用报告。
- `install.tsx` — `/install` 命令：安装向导。
- `review.ts` — `/review` 命令：代码审查（含 ultrareview）。
- `security-review.ts` — `/security-review` 命令：安全审查。
- `statusline.tsx` — `/statusline` 命令：状态栏相关。
- `ultraplan.tsx` — `/ultraplan` 命令：ultraplan 计划。
- `version.ts` — `/version` 命令：显示版本号。

#### src/commands/add-dir

`/add-dir` 命令：把额外工作目录加入当前会话的工作区。

- `add-dir.tsx` — `/add-dir` 命令的实现代码。
- `index.ts` — `/add-dir` 命令的定义与注册入口。
- `validation.ts` — `/add-dir` 命令的实现代码。

#### src/commands/agents

`/agents` 命令：查看 / 选择可用的子代理（subagent）。

- `agents.tsx` — `/agents` 命令的实现代码。
- `index.ts` — `/agents` 命令的定义与注册入口。

#### src/commands/ant-trace

`/ant-trace` 命令（ANT 专用追踪）。

- `index.js` — `/ant-trace` 命令的定义与注册入口。

#### src/commands/autofix-pr

`/autofix-pr` 命令：自动修复 PR。

- `index.js` — `/autofix-pr` 命令的定义与注册入口。

#### src/commands/backfill-sessions

`/backfill-sessions` 命令：回填会话数据。

- `index.js` — `/backfill-sessions` 命令的定义与注册入口。

#### src/commands/branch

`/branch` 命令：基于当前会话创建 / 管理代码分支。

- `branch.ts` — `/branch` 命令的实现代码。
- `index.ts` — `/branch` 命令的定义与注册入口。

#### src/commands/break-cache

`/break-cache` 命令：破坏/清理缓存。

- `index.js` — `/break-cache` 命令的定义与注册入口。

#### src/commands/bridge

`/bridge` 命令：远程控制（Bridge）相关设置与连接。

- `bridge.tsx` — `/bridge` 命令的实现代码。
- `index.ts` — `/bridge` 命令的定义与注册入口。

#### src/commands/btw

`/btw` 命令：临时插入一个问题/指令。

- `btw.tsx` — `/btw` 命令的实现代码。
- `index.ts` — `/btw` 命令的定义与注册入口。

#### src/commands/bughunter

`/bughunter` 命令：Bug 猎人（BugHunter）相关。

- `index.js` — `/bughunter` 命令的定义与注册入口。

#### src/commands/chrome

`/chrome` 命令：Claude in Chrome 相关设置。

- `chrome.tsx` — `/chrome` 命令的实现代码。
- `index.ts` — `/chrome` 命令的定义与注册入口。

#### src/commands/clear

`/clear` 命令：清空当前会话 / 缓存。

- `caches.ts` — `/clear` 命令的实现代码。
- `clear.ts` — `/clear` 命令的实现代码。
- `conversation.ts` — `/clear` 命令的实现代码。
- `index.ts` — `/clear` 命令的定义与注册入口。

#### src/commands/color

`/color` 命令：设置代理（Agent）的颜色。

- `color.ts` — `/color` 命令的实现代码。
- `index.ts` — `/color` 命令的定义与注册入口。

#### src/commands/compact

`/compact` 命令：压缩当前会话上下文。

- `compact.ts` — `/compact` 命令的实现代码。
- `index.ts` — `/compact` 命令的定义与注册入口。

#### src/commands/config

`/config`（别名 `/settings`）命令：打开设置界面。

- `config.tsx` — `/config` 命令的实现代码。
- `index.ts` — `/config` 命令的定义与注册入口。

#### src/commands/context

`/context` 命令：以彩色网格可视化当前上下文占用。

- `context-noninteractive.ts` — `/context` 命令的实现代码。
- `context.tsx` — `/context` 命令的实现代码。
- `index.ts` — `/context` 命令的定义与注册入口。

#### src/commands/copy

`/copy` 命令：把最近的助手输出复制到临时文件。

- `copy.tsx` — `/copy` 命令的实现代码。
- `index.ts` — `/copy` 命令的定义与注册入口。

#### src/commands/cost

`/cost` 命令：查看当前会话的费用 / 用量。

- `cost.ts` — `/cost` 命令的实现代码。
- `index.ts` — `/cost` 命令的定义与注册入口。

#### src/commands/ctx_viz

`/ctx-viz` 命令：上下文可视化。

- `index.js` — `/ctx_viz` 命令的定义与注册入口。

#### src/commands/debug-tool-call

`/debug-tool-call` 命令：调试工具调用。

- `index.js` — `/debug-tool-call` 命令的定义与注册入口。

#### src/commands/desktop

`/desktop` 命令：桌面版切换 / 交接（Desktop Handoff）。

- `desktop.tsx` — `/desktop` 命令的实现代码。
- `index.ts` — `/desktop` 命令的定义与注册入口。

#### src/commands/diff

`/diff` 命令：查看未提交改动与每轮 diff。

- `diff.tsx` — `/diff` 命令的实现代码。
- `index.ts` — `/diff` 命令的定义与注册入口。

#### src/commands/doctor

`/doctor` 命令：诊断并校验 Claude Code 安装与设置。

- `doctor.tsx` — `/doctor` 命令的实现代码。
- `index.ts` — `/doctor` 命令的定义与注册入口。

#### src/commands/effort

`/effort` 命令：设置模型使用的 effort 级别。

- `effort.tsx` — `/effort` 命令的实现代码。
- `index.ts` — `/effort` 命令的定义与注册入口。

#### src/commands/env

`/env` 命令：查看环境相关。

- `index.js` — `/env` 命令的定义与注册入口。

#### src/commands/exit

`/exit` 命令：退出会话。

- `exit.tsx` — `/exit` 命令的实现代码。
- `index.ts` — `/exit` 命令的定义与注册入口。

#### src/commands/export

`/export` 命令：导出会话 / 内容。

- `export.tsx` — `/export` 命令的实现代码。
- `index.ts` — `/export` 命令的定义与注册入口。

#### src/commands/extra-usage

`/extra-usage` 命令：申请 / 查看额外用量（extra usage）。

- `extra-usage-core.ts` — `/extra-usage` 命令的实现代码。
- `extra-usage-noninteractive.ts` — `/extra-usage` 命令的实现代码。
- `extra-usage.tsx` — `/extra-usage` 命令的实现代码。
- `index.ts` — `/extra-usage` 命令的定义与注册入口。

#### src/commands/fast

`/fast` 命令：切换快速模式（Fast Mode）。

- `fast.tsx` — `/fast` 命令的实现代码。
- `index.ts` — `/fast` 命令的定义与注册入口。

#### src/commands/feedback

`/feedback`（别名 `/bug`）命令：提交反馈。

- `feedback.tsx` — `/feedback` 命令的实现代码。
- `index.ts` — `/feedback` 命令的定义与注册入口。

#### src/commands/files

`/files` 命令：查看会话涉及的文件。

- `files.ts` — `/files` 命令的实现代码。
- `index.ts` — `/files` 命令的定义与注册入口。

#### src/commands/good-claude

`/good-claude` 命令：彩蛋/趣味命令。

- `index.js` — `/good-claude` 命令的定义与注册入口。

#### src/commands/heapdump

`/heapdump` 命令：生成堆转储用于排查。

- `heapdump.ts` — `/heapdump` 命令的实现代码。
- `index.ts` — `/heapdump` 命令的定义与注册入口。

#### src/commands/help

`/help` 命令：显示帮助。

- `help.tsx` — `/help` 命令的实现代码。
- `index.ts` — `/help` 命令的定义与注册入口。

#### src/commands/hooks

`/hooks` 命令：查看 / 配置 hooks。

- `hooks.tsx` — `/hooks` 命令的实现代码。
- `index.ts` — `/hooks` 命令的定义与注册入口。

#### src/commands/ide

`/ide` 命令：连接 IDE。

- `ide.tsx` — `/ide` 命令的实现代码。
- `index.ts` — `/ide` 命令的定义与注册入口。

#### src/commands/install-github-app

`/install-github-app` 命令：引导安装 GitHub App 与 GitHub Actions。

- `ApiKeyStep.tsx` — `/install-github-app` 命令的实现代码。
- `CheckExistingSecretStep.tsx` — `/install-github-app` 命令的实现代码。
- `CheckGitHubStep.tsx` — `/install-github-app` 命令的实现代码。
- `ChooseRepoStep.tsx` — `/install-github-app` 命令的实现代码。
- `CreatingStep.tsx` — `/install-github-app` 命令的实现代码。
- `ErrorStep.tsx` — `/install-github-app` 命令的实现代码。
- `ExistingWorkflowStep.tsx` — `/install-github-app` 命令的实现代码。
- `index.ts` — `/install-github-app` 命令的定义与注册入口。
- `install-github-app.tsx` — `/install-github-app` 命令的实现代码。
- `InstallAppStep.tsx` — `/install-github-app` 命令的实现代码。
- `OAuthFlowStep.tsx` — `/install-github-app` 命令的实现代码。
- `setupGitHubActions.ts` — `/install-github-app` 命令的实现代码。
- `SuccessStep.tsx` — `/install-github-app` 命令的实现代码。
- `WarningsStep.tsx` — `/install-github-app` 命令的实现代码。

#### src/commands/install-slack-app

`/install-slack-app` 命令：引导安装 Slack App。

- `index.ts` — `/install-slack-app` 命令的定义与注册入口。
- `install-slack-app.ts` — `/install-slack-app` 命令的实现代码。

#### src/commands/issue

`/issue` 命令：打开 / 创建 issue。

- `index.js` — `/issue` 命令的定义与注册入口。

#### src/commands/keybindings

`/keybindings` 命令：打开或创建按键绑定配置文件。

- `index.ts` — `/keybindings` 命令的定义与注册入口。
- `keybindings.ts` — `/keybindings` 命令的实现代码。

#### src/commands/login

`/login` 命令：登录 Anthropic 账号。

- `index.ts` — `/login` 命令的定义与注册入口。
- `login.tsx` — `/login` 命令的实现代码。

#### src/commands/logout

`/logout` 命令：退出登录。

- `index.ts` — `/logout` 命令的定义与注册入口。
- `logout.tsx` — `/logout` 命令的实现代码。

#### src/commands/mcp

`/mcp` 命令：管理 MCP 服务器。

- `addCommand.ts` — `/mcp` 命令的实现代码。
- `index.ts` — `/mcp` 命令的定义与注册入口。
- `mcp.tsx` — `/mcp` 命令的实现代码。
- `xaaIdpCommand.ts` — `/mcp` 命令的实现代码。

#### src/commands/memory

`/memory` 命令：管理会话记忆。

- `index.ts` — `/memory` 命令的定义与注册入口。
- `memory.tsx` — `/memory` 命令的实现代码。

#### src/commands/mobile

`/mobile` 命令：连接移动端。

- `index.ts` — `/mobile` 命令的定义与注册入口。
- `mobile.tsx` — `/mobile` 命令的实现代码。

#### src/commands/mock-limits

`/mock-limits` 命令：模拟限额（调试用）。

- `index.js` — `/mock-limits` 命令的定义与注册入口。

#### src/commands/model

`/model` 命令：切换模型。

- `index.ts` — `/model` 命令的定义与注册入口。
- `model.tsx` — `/model` 命令的实现代码。

#### src/commands/oauth-refresh

`/oauth-refresh` 命令：刷新 OAuth 令牌。

- `index.js` — `/oauth-refresh` 命令的定义与注册入口。

#### src/commands/onboarding

`/onboarding` 命令：引导 / 新手引导流程。

- `index.js` — `/onboarding` 命令的定义与注册入口。

#### src/commands/output-style

`/output-style` 命令：设置输出样式（已弃用，引导到 `/config`）。

- `index.ts` — `/output-style` 命令的定义与注册入口。
- `output-style.tsx` — `/output-style` 命令的实现代码。

#### src/commands/passes

`/passes` 命令：查看 Passes（订阅权益）。

- `index.ts` — `/passes` 命令的定义与注册入口。
- `passes.tsx` — `/passes` 命令的实现代码。

#### src/commands/perf-issue

`/perf-issue` 命令：报告性能问题。

- `index.js` — `/perf-issue` 命令的定义与注册入口。

#### src/commands/permissions

`/permissions` 命令：管理权限规则。

- `index.ts` — `/permissions` 命令的定义与注册入口。
- `permissions.tsx` — `/permissions` 命令的实现代码。

#### src/commands/plan

`/plan` 命令：计划模式（Plan Mode）。

- `index.ts` — `/plan` 命令的定义与注册入口。
- `plan.tsx` — `/plan` 命令的实现代码。

#### src/commands/plugin

`/plugin` 命令：管理插件与市场（marketplace）。

- `AddMarketplace.tsx` — `/plugin` 命令的实现代码。
- `BrowseMarketplace.tsx` — `/plugin` 命令的实现代码。
- `DiscoverPlugins.tsx` — `/plugin` 命令的实现代码。
- `index.tsx` — `/plugin` 命令的定义与注册入口。
- `ManageMarketplaces.tsx` — `/plugin` 命令的实现代码。
- `ManagePlugins.tsx` — `/plugin` 命令的实现代码。
- `parseArgs.ts` — `/plugin` 命令的实现代码。
- `plugin.tsx` — `/plugin` 命令的实现代码。
- `pluginDetailsHelpers.tsx` — `/plugin` 命令的实现代码。
- `PluginErrors.tsx` — `/plugin` 命令的实现代码。
- `PluginOptionsDialog.tsx` — `/plugin` 命令的实现代码。
- `PluginOptionsFlow.tsx` — `/plugin` 命令的实现代码。
- `PluginSettings.tsx` — `/plugin` 命令的实现代码。
- `PluginTrustWarning.tsx` — `/plugin` 命令的实现代码。
- `UnifiedInstalledCell.tsx` — `/plugin` 命令的实现代码。
- `usePagination.ts` — `/plugin` 命令的实现代码。
- `ValidatePlugin.tsx` — `/plugin` 命令的实现代码。

#### src/commands/pr_comments

`/pr-comments` 命令：获取 GitHub PR 评论。

- `index.ts` — `/pr_comments` 命令的定义与注册入口。

#### src/commands/privacy-settings

`/privacy-settings` 命令：隐私设置。

- `index.ts` — `/privacy-settings` 命令的定义与注册入口。
- `privacy-settings.tsx` — `/privacy-settings` 命令的实现代码。

#### src/commands/rate-limit-options

`/rate-limit-options` 命令：速率限制选项（升级/额外用量/取消）。

- `index.ts` — `/rate-limit-options` 命令的定义与注册入口。
- `rate-limit-options.tsx` — `/rate-limit-options` 命令的实现代码。

#### src/commands/release-notes

`/release-notes` 命令：查看发布说明。

- `index.ts` — `/release-notes` 命令的定义与注册入口。
- `release-notes.ts` — `/release-notes` 命令的实现代码。

#### src/commands/reload-plugins

`/reload-plugins` 命令：重新加载插件。

- `index.ts` — `/reload-plugins` 命令的定义与注册入口。
- `reload-plugins.ts` — `/reload-plugins` 命令的实现代码。

#### src/commands/remote-env

`/remote-env` 命令：配置 teleport 会话的默认远程环境。

- `index.ts` — `/remote-env` 命令的定义与注册入口。
- `remote-env.tsx` — `/remote-env` 命令的实现代码。

#### src/commands/remote-setup

`/web-setup` 命令：远程环境（BYOC）设置向导。

- `api.ts` — `/remote-setup` 命令的实现代码。
- `index.ts` — `/remote-setup` 命令的定义与注册入口。
- `remote-setup.tsx` — `/remote-setup` 命令的实现代码。

#### src/commands/rename

`/rename` 命令：重命名会话。

- `generateSessionName.ts` — `/rename` 命令的实现代码。
- `index.ts` — `/rename` 命令的定义与注册入口。
- `rename.ts` — `/rename` 命令的实现代码。

#### src/commands/reset-limits

`/reset-limits` 命令：重置限额（调试用）。

- `index.js` — `/reset-limits` 命令的定义与注册入口。

#### src/commands/resume

`/resume` 命令：恢复历史会话。

- `index.ts` — `/resume` 命令的定义与注册入口。
- `resume.tsx` — `/resume` 命令的实现代码。

#### src/commands/review

`/review` 命令：代码审查（含 ultrareview 远程审查）。

- `reviewRemote.ts` — `/review` 命令的实现代码。
- `ultrareviewCommand.tsx` — `/review` 命令的实现代码。
- `ultrareviewEnabled.ts` — `/review` 命令的实现代码。
- `UltrareviewOverageDialog.tsx` — `/review` 命令的实现代码。

#### src/commands/rewind

`/rewind` 命令：回退到之前的会话节点。

- `index.ts` — `/rewind` 命令的定义与注册入口。
- `rewind.ts` — `/rewind` 命令的实现代码。

#### src/commands/sandbox-toggle

`/sandbox-toggle` 命令：切换沙箱模式。

- `index.ts` — `/sandbox-toggle` 命令的定义与注册入口。
- `sandbox-toggle.tsx` — `/sandbox-toggle` 命令的实现代码。

#### src/commands/session

`/session` 命令：会话管理。

- `index.ts` — `/session` 命令的定义与注册入口。
- `session.tsx` — `/session` 命令的实现代码。

#### src/commands/share

`/share` 命令：分享会话。

- `index.js` — `/share` 命令的定义与注册入口。

#### src/commands/skills

`/skills` 命令：查看技能。

- `index.ts` — `/skills` 命令的定义与注册入口。
- `skills.tsx` — `/skills` 命令的实现代码。

#### src/commands/stats

`/stats` 命令：查看统计。

- `index.ts` — `/stats` 命令的定义与注册入口。
- `stats.tsx` — `/stats` 命令的实现代码。

#### src/commands/status

`/status` 命令：查看状态。

- `index.ts` — `/status` 命令的定义与注册入口。
- `status.tsx` — `/status` 命令的实现代码。

#### src/commands/stickers

`/stickers` 命令：贴纸（趣味）。

- `index.ts` — `/stickers` 命令的定义与注册入口。
- `stickers.ts` — `/stickers` 命令的实现代码。

#### src/commands/summary

`/summary` 命令：生成会话摘要。

- `index.js` — `/summary` 命令的定义与注册入口。

#### src/commands/tag

`/tag` 命令：给会话打标签。

- `index.ts` — `/tag` 命令的定义与注册入口。
- `tag.tsx` — `/tag` 命令的实现代码。

#### src/commands/tasks

`/tasks` 命令：查看任务。

- `index.ts` — `/tasks` 命令的定义与注册入口。
- `tasks.tsx` — `/tasks` 命令的实现代码。

#### src/commands/teleport

`/teleport` 命令：远程环境（teleport）。

- `index.js` — `/teleport` 命令的定义与注册入口。

#### src/commands/terminalSetup

`/terminal-setup` 命令：终端设置引导。

- `index.ts` — `/terminalSetup` 命令的定义与注册入口。
- `terminalSetup.tsx` — `/terminalSetup` 命令的实现代码。

#### src/commands/theme

`/theme` 命令：切换主题。

- `index.ts` — `/theme` 命令的定义与注册入口。
- `theme.tsx` — `/theme` 命令的实现代码。

#### src/commands/thinkback

`/thinkback` 命令：回顾（thinkback）交互。

- `index.ts` — `/thinkback` 命令的定义与注册入口。
- `thinkback.tsx` — `/thinkback` 命令的实现代码。

#### src/commands/thinkback-play

`/thinkback-play` 命令：回放思考过程。

- `index.ts` — `/thinkback-play` 命令的定义与注册入口。
- `thinkback-play.ts` — `/thinkback-play` 命令的实现代码。

#### src/commands/upgrade

`/upgrade` 命令：升级 Claude Code。

- `index.ts` — `/upgrade` 命令的定义与注册入口。
- `upgrade.tsx` — `/upgrade` 命令的实现代码。

#### src/commands/usage

`/usage` 命令：查看用量。

- `index.ts` — `/usage` 命令的定义与注册入口。
- `usage.tsx` — `/usage` 命令的实现代码。

#### src/commands/vim

`/vim` 命令：切换 Vim 模式。

- `index.ts` — `/vim` 命令的定义与注册入口。
- `vim.ts` — `/vim` 命令的实现代码。

#### src/commands/voice

`/voice` 命令：语音模式。

- `index.ts` — `/voice` 命令的定义与注册入口。
- `voice.ts` — `/voice` 命令的实现代码。

### src/components

React UI 组件库：消息渲染、权限弹窗、设置界面、Prompt 输入框、Diff 视图等桌面/终端 UI 组件。

- `AgentProgressLine.tsx` — AgentProgressLine 的 React UI 组件。
- `App.tsx` — App 的 React UI 组件。
- `ApproveApiKey.tsx` — ApproveApiKey 的 React UI 组件。
- `AutoModeOptInDialog.tsx` — AutoModeOptInDialog 的 React UI 组件。
- `AutoUpdater.tsx` — AutoUpdater 的 React UI 组件。
- `AutoUpdaterWrapper.tsx` — AutoUpdaterWrapper 的 React UI 组件。
- `AwsAuthStatusBox.tsx` — AwsAuthStatusBox 的 React UI 组件。
- `BaseTextInput.tsx` — BaseTextInput 的 React UI 组件。
- `BashModeProgress.tsx` — BashModeProgress 的 React UI 组件。
- `BridgeDialog.tsx` — BridgeDialog 的 React UI 组件。
- `BypassPermissionsModeDialog.tsx` — BypassPermissionsModeDialog 的 React UI 组件。
- `ChannelDowngradeDialog.tsx` — ChannelDowngradeDialog 的 React UI 组件。
- `ClaudeInChromeOnboarding.tsx` — ClaudeInChromeOnboarding 的 React UI 组件。
- `ClaudeMdExternalIncludesDialog.tsx` — ClaudeMdExternalIncludesDialog 的 React UI 组件。
- `ClickableImageRef.tsx` — ClickableImageRef 的 React UI 组件。
- `CompactSummary.tsx` — CompactSummary 的 React UI 组件。
- `ConfigurableShortcutHint.tsx` — ConfigurableShortcutHint 的 React UI 组件。
- `ConsoleOAuthFlow.tsx` — ConsoleOAuthFlow 的 React UI 组件。
- `ContextSuggestions.tsx` — ContextSuggestions 的 React UI 组件。
- `ContextVisualization.tsx` — ContextVisualization 的 React UI 组件。
- `CoordinatorAgentStatus.tsx` — CoordinatorAgentStatus 的 React UI 组件。
- `CostThresholdDialog.tsx` — CostThresholdDialog 的 React UI 组件。
- `CtrlOToExpand.tsx` — CtrlOToExpand 的 React UI 组件。
- `DesktopHandoff.tsx` — DesktopHandoff 的 React UI 组件。
- `DevBar.tsx` — DevBar 的 React UI 组件。
- `DevChannelsDialog.tsx` — DevChannelsDialog 的 React UI 组件。
- `DiagnosticsDisplay.tsx` — DiagnosticsDisplay 的 React UI 组件。
- `EffortCallout.tsx` — EffortCallout 的 React UI 组件。
- `EffortIndicator.ts` — EffortIndicator 的 React UI 组件。
- `ExitFlow.tsx` — ExitFlow 的 React UI 组件。
- `ExportDialog.tsx` — ExportDialog 的 React UI 组件。
- `FallbackToolUseErrorMessage.tsx` — FallbackToolUseErrorMessage 的 React UI 组件。
- `FallbackToolUseRejectedMessage.tsx` — FallbackToolUseRejectedMessage 的 React UI 组件。
- `FastIcon.tsx` — FastIcon 的 React UI 组件。
- `Feedback.tsx` — Feedback 的 React UI 组件。
- `FileEditToolDiff.tsx` — FileEditToolDiff 的 React UI 组件。
- `FileEditToolUpdatedMessage.tsx` — FileEditToolUpdatedMessage 的 React UI 组件。
- `FileEditToolUseRejectedMessage.tsx` — FileEditToolUseRejectedMessage 的 React UI 组件。
- `FilePathLink.tsx` — FilePathLink 的 React UI 组件。
- `FullscreenLayout.tsx` — FullscreenLayout 的 React UI 组件。
- `GlobalSearchDialog.tsx` — GlobalSearchDialog 的 React UI 组件。
- `HighlightedCode.tsx` — HighlightedCode 的 React UI 组件。
- `HistorySearchDialog.tsx` — HistorySearchDialog 的 React UI 组件。
- `IdeAutoConnectDialog.tsx` — IdeAutoConnectDialog 的 React UI 组件。
- `IdeOnboardingDialog.tsx` — IdeOnboardingDialog 的 React UI 组件。
- `IdeStatusIndicator.tsx` — IdeStatusIndicator 的 React UI 组件。
- `IdleReturnDialog.tsx` — IdleReturnDialog 的 React UI 组件。
- `InterruptedByUser.tsx` — InterruptedByUser 的 React UI 组件。
- `InvalidConfigDialog.tsx` — InvalidConfigDialog 的 React UI 组件。
- `InvalidSettingsDialog.tsx` — InvalidSettingsDialog 的 React UI 组件。
- `KeybindingWarnings.tsx` — KeybindingWarnings 的 React UI 组件。
- `LanguagePicker.tsx` — LanguagePicker 的 React UI 组件。
- `LogSelector.tsx` — LogSelector 的 React UI 组件。
- `Markdown.tsx` — Markdown 的 React UI 组件。
- `MarkdownTable.tsx` — MarkdownTable 的 React UI 组件。
- `MCPServerApprovalDialog.tsx` — MCPServerApprovalDialog 的 React UI 组件。
- `MCPServerDesktopImportDialog.tsx` — MCPServerDesktopImportDialog 的 React UI 组件。
- `MCPServerDialogCopy.tsx` — MCPServerDialogCopy 的 React UI 组件。
- `MCPServerMultiselectDialog.tsx` — MCPServerMultiselectDialog 的 React UI 组件。
- `MemoryUsageIndicator.tsx` — MemoryUsageIndicator 的 React UI 组件。
- `Message.tsx` — Message 的 React UI 组件。
- `messageActions.tsx` — messageActions 的 React UI 组件。
- `MessageModel.tsx` — MessageModel 的 React UI 组件。
- `MessageResponse.tsx` — MessageResponse 的 React UI 组件。
- `MessageRow.tsx` — MessageRow 的 React UI 组件。
- `Messages.tsx` — Messages 的 React UI 组件。
- `MessageSelector.tsx` — MessageSelector 的 React UI 组件。
- `MessageTimestamp.tsx` — MessageTimestamp 的 React UI 组件。
- `ModelPicker.tsx` — ModelPicker 的 React UI 组件。
- `NativeAutoUpdater.tsx` — NativeAutoUpdater 的 React UI 组件。
- `NotebookEditToolUseRejectedMessage.tsx` — NotebookEditToolUseRejectedMessage 的 React UI 组件。
- `OffscreenFreeze.tsx` — OffscreenFreeze 的 React UI 组件。
- `Onboarding.tsx` — Onboarding 的 React UI 组件。
- `OutputStylePicker.tsx` — OutputStylePicker 的 React UI 组件。
- `PackageManagerAutoUpdater.tsx` — PackageManagerAutoUpdater 的 React UI 组件。
- `PrBadge.tsx` — PrBadge 的 React UI 组件。
- `PressEnterToContinue.tsx` — PressEnterToContinue 的 React UI 组件。
- `QuickOpenDialog.tsx` — QuickOpenDialog 的 React UI 组件。
- `RemoteCallout.tsx` — RemoteCallout 的 React UI 组件。
- `RemoteEnvironmentDialog.tsx` — RemoteEnvironmentDialog 的 React UI 组件。
- `ResumeTask.tsx` — ResumeTask 的 React UI 组件。
- `SandboxViolationExpandedView.tsx` — SandboxViolationExpandedView 的 React UI 组件。
- `ScrollKeybindingHandler.tsx` — ScrollKeybindingHandler 的 React UI 组件。
- `SearchBox.tsx` — SearchBox 的 React UI 组件。
- `SentryErrorBoundary.ts` — SentryErrorBoundary 的 React UI 组件。
- `SessionBackgroundHint.tsx` — SessionBackgroundHint 的 React UI 组件。
- `SessionPreview.tsx` — SessionPreview 的 React UI 组件。
- `ShowInIDEPrompt.tsx` — ShowInIDEPrompt 的 React UI 组件。
- `SkillImprovementSurvey.tsx` — SkillImprovementSurvey 的 React UI 组件。
- `Spinner.tsx` — Spinner 的 React UI 组件。
- `Stats.tsx` — Stats 的 React UI 组件。
- `StatusLine.tsx` — StatusLine 的 React UI 组件。
- `StatusNotices.tsx` — StatusNotices 的 React UI 组件。
- `StructuredDiff.tsx` — StructuredDiff 的 React UI 组件。
- `StructuredDiffList.tsx` — StructuredDiffList 的 React UI 组件。
- `TagTabs.tsx` — TagTabs 的 React UI 组件。
- `TaskListV2.tsx` — TaskListV2 的 React UI 组件。
- `TeammateViewHeader.tsx` — TeammateViewHeader 的 React UI 组件。
- `TeleportError.tsx` — TeleportError 的 React UI 组件。
- `TeleportProgress.tsx` — TeleportProgress 的 React UI 组件。
- `TeleportRepoMismatchDialog.tsx` — TeleportRepoMismatchDialog 的 React UI 组件。
- `TeleportResumeWrapper.tsx` — TeleportResumeWrapper 的 React UI 组件。
- `TeleportStash.tsx` — TeleportStash 的 React UI 组件。
- `TextInput.tsx` — TextInput 的 React UI 组件。
- `ThemePicker.tsx` — ThemePicker 的 React UI 组件。
- `ThinkingToggle.tsx` — ThinkingToggle 的 React UI 组件。
- `TokenWarning.tsx` — TokenWarning 的 React UI 组件。
- `ToolUseLoader.tsx` — ToolUseLoader 的 React UI 组件。
- `ValidationErrorsList.tsx` — ValidationErrorsList 的 React UI 组件。
- `VimTextInput.tsx` — VimTextInput 的 React UI 组件。
- `VirtualMessageList.tsx` — VirtualMessageList 的 React UI 组件。
- `WorkflowMultiselectDialog.tsx` — WorkflowMultiselectDialog 的 React UI 组件。
- `WorktreeExitDialog.tsx` — WorktreeExitDialog 的 React UI 组件。

#### src/components/agents

代理（agents）相关组件。

- `AgentDetail.tsx` — AgentDetail 的 React UI 组件。
- `AgentEditor.tsx` — AgentEditor 的 React UI 组件。
- `agentFileUtils.ts` — agentFileUtils 的 React UI 组件。
- `AgentNavigationFooter.tsx` — AgentNavigationFooter 的 React UI 组件。
- `AgentsList.tsx` — AgentsList 的 React UI 组件。
- `AgentsMenu.tsx` — AgentsMenu 的 React UI 组件。
- `ColorPicker.tsx` — ColorPicker 的 React UI 组件。
- `generateAgent.ts` — generateAgent 的 React UI 组件。
- `ModelSelector.tsx` — ModelSelector 的 React UI 组件。
- `ToolSelector.tsx` — ToolSelector 的 React UI 组件。
- `types.ts` — types 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。
- `validateAgent.ts` — validateAgent 的 React UI 组件。

##### src/components/agents/new-agent-creation

新建代理向导组件。

- `CreateAgentWizard.tsx` — CreateAgentWizard 的 React UI 组件。

###### src/components/agents/new-agent-creation/wizard-steps

新建代理向导的各个步骤组件。

- `ColorStep.tsx` — ColorStep 的 React UI 组件。
- `ConfirmStep.tsx` — ConfirmStep 的 React UI 组件。
- `ConfirmStepWrapper.tsx` — ConfirmStepWrapper 的 React UI 组件。
- `DescriptionStep.tsx` — DescriptionStep 的 React UI 组件。
- `GenerateStep.tsx` — GenerateStep 的 React UI 组件。
- `LocationStep.tsx` — LocationStep 的 React UI 组件。
- `MemoryStep.tsx` — MemoryStep 的 React UI 组件。
- `MethodStep.tsx` — MethodStep 的 React UI 组件。
- `ModelStep.tsx` — ModelStep 的 React UI 组件。
- `PromptStep.tsx` — PromptStep 的 React UI 组件。
- `ToolsStep.tsx` — ToolsStep 的 React UI 组件。
- `TypeStep.tsx` — TypeStep 的 React UI 组件。

#### src/components/ClaudeCodeHint

Claude Code 提示组件（桌面端提示语/引导）。

- `PluginHintMenu.tsx` — PluginHintMenu 的 React UI 组件。

#### src/components/CustomSelect

自定义下拉选择组件。

- `index.ts` — index 的 React UI 组件。
- `option-map.ts` — option-map 的 React UI 组件。
- `select-input-option.tsx` — select-input-option 的 React UI 组件。
- `select-option.tsx` — select-option 的 React UI 组件。
- `select.tsx` — select 的 React UI 组件。
- `SelectMulti.tsx` — SelectMulti 的 React UI 组件。
- `use-multi-select-state.ts` — use-multi-select-state 的 React UI 组件。
- `use-select-input.ts` — use-select-input 的 React UI 组件。
- `use-select-navigation.ts` — use-select-navigation 的 React UI 组件。
- `use-select-state.ts` — use-select-state 的 React UI 组件。

#### src/components/design-system

设计系统基础组件（按钮、表单、排版等）。

- `Byline.tsx` — Byline 的 React UI 组件。
- `color.ts` — color 的 React UI 组件。
- `Dialog.tsx` — Dialog 的 React UI 组件。
- `Divider.tsx` — Divider 的 React UI 组件。
- `FuzzyPicker.tsx` — FuzzyPicker 的 React UI 组件。
- `KeyboardShortcutHint.tsx` — KeyboardShortcutHint 的 React UI 组件。
- `ListItem.tsx` — ListItem 的 React UI 组件。
- `LoadingState.tsx` — LoadingState 的 React UI 组件。
- `Pane.tsx` — Pane 的 React UI 组件。
- `ProgressBar.tsx` — ProgressBar 的 React UI 组件。
- `Ratchet.tsx` — Ratchet 的 React UI 组件。
- `StatusIcon.tsx` — StatusIcon 的 React UI 组件。
- `Tabs.tsx` — Tabs 的 React UI 组件。
- `ThemedBox.tsx` — ThemedBox 的 React UI 组件。
- `ThemedText.tsx` — ThemedText 的 React UI 组件。
- `ThemeProvider.tsx` — ThemeProvider 的 React UI 组件。

#### src/components/DesktopUpsell

桌面版升级引导组件。

- `DesktopUpsellStartup.tsx` — DesktopUpsellStartup 的 React UI 组件。

#### src/components/diff

diff 视图组件。

- `DiffDetailView.tsx` — DiffDetailView 的 React UI 组件。
- `DiffDialog.tsx` — DiffDialog 的 React UI 组件。
- `DiffFileList.tsx` — DiffFileList 的 React UI 组件。

#### src/components/FeedbackSurvey

反馈问卷组件。

- `FeedbackSurvey.tsx` — FeedbackSurvey 的 React UI 组件。
- `FeedbackSurveyView.tsx` — FeedbackSurveyView 的 React UI 组件。
- `submitTranscriptShare.ts` — submitTranscriptShare 的 React UI 组件。
- `TranscriptSharePrompt.tsx` — TranscriptSharePrompt 的 React UI 组件。
- `useDebouncedDigitInput.ts` — useDebouncedDigitInput 的 React UI 组件。
- `useFeedbackSurvey.tsx` — useFeedbackSurvey 的 React UI 组件。
- `useMemorySurvey.tsx` — useMemorySurvey 的 React UI 组件。
- `usePostCompactSurvey.tsx` — usePostCompactSurvey 的 React UI 组件。
- `useSurveyState.tsx` — useSurveyState 的 React UI 组件。

#### src/components/grove

Grove 相关组件。

- `Grove.tsx` — Grove 的 React UI 组件。

#### src/components/HelpV2

帮助（Help）第二版组件。

- `Commands.tsx` — Commands 的 React UI 组件。
- `General.tsx` — General 的 React UI 组件。
- `HelpV2.tsx` — HelpV2 的 React UI 组件。

#### src/components/HighlightedCode

代码高亮组件。

- `Fallback.tsx` — Fallback 的 React UI 组件。

#### src/components/hooks

组件内部使用的 hooks。

- `HooksConfigMenu.tsx` — HooksConfigMenu 的 React UI 组件。
- `PromptDialog.tsx` — PromptDialog 的 React UI 组件。
- `SelectEventMode.tsx` — SelectEventMode 的 React UI 组件。
- `SelectHookMode.tsx` — SelectHookMode 的 React UI 组件。
- `SelectMatcherMode.tsx` — SelectMatcherMode 的 React UI 组件。
- `ViewHookMode.tsx` — ViewHookMode 的 React UI 组件。

#### src/components/LogoV2

Logo 第二版组件。

- `AnimatedAsterisk.tsx` — AnimatedAsterisk 的 React UI 组件。
- `AnimatedClawd.tsx` — AnimatedClawd 的 React UI 组件。
- `ChannelsNotice.tsx` — ChannelsNotice 的 React UI 组件。
- `Clawd.tsx` — Clawd 的 React UI 组件。
- `CondensedLogo.tsx` — CondensedLogo 的 React UI 组件。
- `EmergencyTip.tsx` — EmergencyTip 的 React UI 组件。
- `Feed.tsx` — Feed 的 React UI 组件。
- `FeedColumn.tsx` — FeedColumn 的 React UI 组件。
- `feedConfigs.tsx` — feedConfigs 的 React UI 组件。
- `GuestPassesUpsell.tsx` — GuestPassesUpsell 的 React UI 组件。
- `LogoV2.tsx` — LogoV2 的 React UI 组件。
- `Opus1mMergeNotice.tsx` — Opus1mMergeNotice 的 React UI 组件。
- `OverageCreditUpsell.tsx` — OverageCreditUpsell 的 React UI 组件。
- `VoiceModeNotice.tsx` — VoiceModeNotice 的 React UI 组件。
- `WelcomeV2.tsx` — WelcomeV2 的 React UI 组件。

#### src/components/LspRecommendation

LSP 推荐提示组件。

- `LspRecommendationMenu.tsx` — LspRecommendationMenu 的 React UI 组件。

#### src/components/ManagedSettingsSecurityDialog

受管设置的安全提示对话框。

- `ManagedSettingsSecurityDialog.tsx` — ManagedSettingsSecurityDialog 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。

#### src/components/mcp

MCP 相关组件。

- `CapabilitiesSection.tsx` — CapabilitiesSection 的 React UI 组件。
- `ElicitationDialog.tsx` — ElicitationDialog 的 React UI 组件。
- `index.ts` — index 的 React UI 组件。
- `MCPAgentServerMenu.tsx` — MCPAgentServerMenu 的 React UI 组件。
- `MCPListPanel.tsx` — MCPListPanel 的 React UI 组件。
- `McpParsingWarnings.tsx` — McpParsingWarnings 的 React UI 组件。
- `MCPReconnect.tsx` — MCPReconnect 的 React UI 组件。
- `MCPRemoteServerMenu.tsx` — MCPRemoteServerMenu 的 React UI 组件。
- `MCPSettings.tsx` — MCPSettings 的 React UI 组件。
- `MCPStdioServerMenu.tsx` — MCPStdioServerMenu 的 React UI 组件。
- `MCPToolDetailView.tsx` — MCPToolDetailView 的 React UI 组件。
- `MCPToolListView.tsx` — MCPToolListView 的 React UI 组件。

##### src/components/mcp/utils

MCP 组件辅助工具。

- `reconnectHelpers.tsx` — reconnectHelpers 的 React UI 组件。

#### src/components/memory

记忆（memory）相关组件。

- `MemoryFileSelector.tsx` — MemoryFileSelector 的 React UI 组件。
- `MemoryUpdateNotification.tsx` — MemoryUpdateNotification 的 React UI 组件。

#### src/components/messages

消息渲染组件。

- `AdvisorMessage.tsx` — AdvisorMessage 的 React UI 组件。
- `AssistantRedactedThinkingMessage.tsx` — AssistantRedactedThinkingMessage 的 React UI 组件。
- `AssistantTextMessage.tsx` — AssistantTextMessage 的 React UI 组件。
- `AssistantThinkingMessage.tsx` — AssistantThinkingMessage 的 React UI 组件。
- `AssistantToolUseMessage.tsx` — AssistantToolUseMessage 的 React UI 组件。
- `AttachmentMessage.tsx` — AttachmentMessage 的 React UI 组件。
- `CollapsedReadSearchContent.tsx` — CollapsedReadSearchContent 的 React UI 组件。
- `CompactBoundaryMessage.tsx` — CompactBoundaryMessage 的 React UI 组件。
- `GroupedToolUseContent.tsx` — GroupedToolUseContent 的 React UI 组件。
- `HighlightedThinkingText.tsx` — HighlightedThinkingText 的 React UI 组件。
- `HookProgressMessage.tsx` — HookProgressMessage 的 React UI 组件。
- `nullRenderingAttachments.ts` — nullRenderingAttachments 的 React UI 组件。
- `PlanApprovalMessage.tsx` — PlanApprovalMessage 的 React UI 组件。
- `RateLimitMessage.tsx` — RateLimitMessage 的 React UI 组件。
- `ShutdownMessage.tsx` — ShutdownMessage 的 React UI 组件。
- `SystemAPIErrorMessage.tsx` — SystemAPIErrorMessage 的 React UI 组件。
- `SystemTextMessage.tsx` — SystemTextMessage 的 React UI 组件。
- `TaskAssignmentMessage.tsx` — TaskAssignmentMessage 的 React UI 组件。
- `teamMemCollapsed.tsx` — teamMemCollapsed 的 React UI 组件。
- `teamMemSaved.ts` — teamMemSaved 的 React UI 组件。
- `UserAgentNotificationMessage.tsx` — UserAgentNotificationMessage 的 React UI 组件。
- `UserBashInputMessage.tsx` — UserBashInputMessage 的 React UI 组件。
- `UserBashOutputMessage.tsx` — UserBashOutputMessage 的 React UI 组件。
- `UserChannelMessage.tsx` — UserChannelMessage 的 React UI 组件。
- `UserCommandMessage.tsx` — UserCommandMessage 的 React UI 组件。
- `UserImageMessage.tsx` — UserImageMessage 的 React UI 组件。
- `UserLocalCommandOutputMessage.tsx` — UserLocalCommandOutputMessage 的 React UI 组件。
- `UserMemoryInputMessage.tsx` — UserMemoryInputMessage 的 React UI 组件。
- `UserPlanMessage.tsx` — UserPlanMessage 的 React UI 组件。
- `UserPromptMessage.tsx` — UserPromptMessage 的 React UI 组件。
- `UserResourceUpdateMessage.tsx` — UserResourceUpdateMessage 的 React UI 组件。
- `UserTeammateMessage.tsx` — UserTeammateMessage 的 React UI 组件。
- `UserTextMessage.tsx` — UserTextMessage 的 React UI 组件。

##### src/components/messages/UserToolResultMessage

用户工具结果消息组件。

- `RejectedPlanMessage.tsx` — RejectedPlanMessage 的 React UI 组件。
- `RejectedToolUseMessage.tsx` — RejectedToolUseMessage 的 React UI 组件。
- `UserToolCanceledMessage.tsx` — UserToolCanceledMessage 的 React UI 组件。
- `UserToolErrorMessage.tsx` — UserToolErrorMessage 的 React UI 组件。
- `UserToolRejectMessage.tsx` — UserToolRejectMessage 的 React UI 组件。
- `UserToolResultMessage.tsx` — UserToolResultMessage 的 React UI 组件。
- `UserToolSuccessMessage.tsx` — UserToolSuccessMessage 的 React UI 组件。
- `utils.tsx` — utils 的 React UI 组件。

#### src/components/Passes

Passes（订阅权益）组件。

- `Passes.tsx` — Passes 的 React UI 组件。

#### src/components/permissions

权限请求相关组件。

- `FallbackPermissionRequest.tsx` — FallbackPermissionRequest 的 React UI 组件。
- `hooks.ts` — hooks 的 React UI 组件。
- `PermissionDecisionDebugInfo.tsx` — PermissionDecisionDebugInfo 的 React UI 组件。
- `PermissionDialog.tsx` — PermissionDialog 的 React UI 组件。
- `PermissionExplanation.tsx` — PermissionExplanation 的 React UI 组件。
- `PermissionPrompt.tsx` — PermissionPrompt 的 React UI 组件。
- `PermissionRequest.tsx` — PermissionRequest 的 React UI 组件。
- `PermissionRequestTitle.tsx` — PermissionRequestTitle 的 React UI 组件。
- `PermissionRuleExplanation.tsx` — PermissionRuleExplanation 的 React UI 组件。
- `SandboxPermissionRequest.tsx` — SandboxPermissionRequest 的 React UI 组件。
- `shellPermissionHelpers.tsx` — shellPermissionHelpers 的 React UI 组件。
- `useShellPermissionFeedback.ts` — useShellPermissionFeedback 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。
- `WorkerBadge.tsx` — WorkerBadge 的 React UI 组件。
- `WorkerPendingPermission.tsx` — WorkerPendingPermission 的 React UI 组件。

##### src/components/permissions/AskUserQuestionPermissionRequest

「询问用户问题」权限请求组件。

- `AskUserQuestionPermissionRequest.tsx` — AskUserQuestionPermissionRequest 的 React UI 组件。
- `PreviewBox.tsx` — PreviewBox 的 React UI 组件。
- `PreviewQuestionView.tsx` — PreviewQuestionView 的 React UI 组件。
- `QuestionNavigationBar.tsx` — QuestionNavigationBar 的 React UI 组件。
- `QuestionView.tsx` — QuestionView 的 React UI 组件。
- `SubmitQuestionsView.tsx` — SubmitQuestionsView 的 React UI 组件。
- `use-multiple-choice-state.ts` — use-multiple-choice-state 的 React UI 组件。

##### src/components/permissions/BashPermissionRequest

Bash 命令权限请求组件。

- `BashPermissionRequest.tsx` — BashPermissionRequest 的 React UI 组件。
- `bashToolUseOptions.tsx` — bashToolUseOptions 的 React UI 组件。

##### src/components/permissions/ComputerUseApproval

计算机使用（Computer Use）审批组件。

- `ComputerUseApproval.tsx` — ComputerUseApproval 的 React UI 组件。

##### src/components/permissions/EnterPlanModePermissionRequest

进入计划模式权限请求组件。

- `EnterPlanModePermissionRequest.tsx` — EnterPlanModePermissionRequest 的 React UI 组件。

##### src/components/permissions/ExitPlanModePermissionRequest

退出计划模式权限请求组件。

- `ExitPlanModePermissionRequest.tsx` — ExitPlanModePermissionRequest 的 React UI 组件。

##### src/components/permissions/FileEditPermissionRequest

文件编辑权限请求组件。

- `FileEditPermissionRequest.tsx` — FileEditPermissionRequest 的 React UI 组件。

##### src/components/permissions/FilePermissionDialog

文件权限对话框组件。

- `FilePermissionDialog.tsx` — FilePermissionDialog 的 React UI 组件。
- `ideDiffConfig.ts` — ideDiffConfig 的 React UI 组件。
- `permissionOptions.tsx` — permissionOptions 的 React UI 组件。
- `useFilePermissionDialog.ts` — useFilePermissionDialog 的 React UI 组件。
- `usePermissionHandler.ts` — usePermissionHandler 的 React UI 组件。

##### src/components/permissions/FilesystemPermissionRequest

文件系统权限请求组件。

- `FilesystemPermissionRequest.tsx` — FilesystemPermissionRequest 的 React UI 组件。

##### src/components/permissions/FileWritePermissionRequest

文件写入权限请求组件。

- `FileWritePermissionRequest.tsx` — FileWritePermissionRequest 的 React UI 组件。
- `FileWriteToolDiff.tsx` — FileWriteToolDiff 的 React UI 组件。

##### src/components/permissions/NotebookEditPermissionRequest

Notebook 编辑权限请求组件。

- `NotebookEditPermissionRequest.tsx` — NotebookEditPermissionRequest 的 React UI 组件。
- `NotebookEditToolDiff.tsx` — NotebookEditToolDiff 的 React UI 组件。

##### src/components/permissions/PowerShellPermissionRequest

PowerShell 权限请求组件。

- `PowerShellPermissionRequest.tsx` — PowerShellPermissionRequest 的 React UI 组件。
- `powershellToolUseOptions.tsx` — powershellToolUseOptions 的 React UI 组件。

##### src/components/permissions/rules

权限规则相关组件。

- `AddPermissionRules.tsx` — AddPermissionRules 的 React UI 组件。
- `AddWorkspaceDirectory.tsx` — AddWorkspaceDirectory 的 React UI 组件。
- `PermissionRuleDescription.tsx` — PermissionRuleDescription 的 React UI 组件。
- `PermissionRuleInput.tsx` — PermissionRuleInput 的 React UI 组件。
- `PermissionRuleList.tsx` — PermissionRuleList 的 React UI 组件。
- `RecentDenialsTab.tsx` — RecentDenialsTab 的 React UI 组件。
- `RemoveWorkspaceDirectory.tsx` — RemoveWorkspaceDirectory 的 React UI 组件。
- `WorkspaceTab.tsx` — WorkspaceTab 的 React UI 组件。

##### src/components/permissions/SedEditPermissionRequest

Sed 编辑权限请求组件。

- `SedEditPermissionRequest.tsx` — SedEditPermissionRequest 的 React UI 组件。

##### src/components/permissions/SkillPermissionRequest

技能（Skill）权限请求组件。

- `SkillPermissionRequest.tsx` — SkillPermissionRequest 的 React UI 组件。

##### src/components/permissions/WebFetchPermissionRequest

网页抓取权限请求组件。

- `WebFetchPermissionRequest.tsx` — WebFetchPermissionRequest 的 React UI 组件。

#### src/components/PromptInput

Prompt 输入框组件（核心输入交互）。

- `HistorySearchInput.tsx` — HistorySearchInput 的 React UI 组件。
- `inputModes.ts` — inputModes 的 React UI 组件。
- `inputPaste.ts` — inputPaste 的 React UI 组件。
- `IssueFlagBanner.tsx` — IssueFlagBanner 的 React UI 组件。
- `Notifications.tsx` — Notifications 的 React UI 组件。
- `PromptInput.tsx` — PromptInput 的 React UI 组件。
- `PromptInputFooter.tsx` — PromptInputFooter 的 React UI 组件。
- `PromptInputFooterLeftSide.tsx` — PromptInputFooterLeftSide 的 React UI 组件。
- `PromptInputFooterSuggestions.tsx` — PromptInputFooterSuggestions 的 React UI 组件。
- `PromptInputHelpMenu.tsx` — PromptInputHelpMenu 的 React UI 组件。
- `PromptInputModeIndicator.tsx` — PromptInputModeIndicator 的 React UI 组件。
- `PromptInputQueuedCommands.tsx` — PromptInputQueuedCommands 的 React UI 组件。
- `PromptInputStashNotice.tsx` — PromptInputStashNotice 的 React UI 组件。
- `SandboxPromptFooterHint.tsx` — SandboxPromptFooterHint 的 React UI 组件。
- `ShimmeredInput.tsx` — ShimmeredInput 的 React UI 组件。
- `useMaybeTruncateInput.ts` — useMaybeTruncateInput 的 React UI 组件。
- `usePromptInputPlaceholder.ts` — usePromptInputPlaceholder 的 React UI 组件。
- `useShowFastIconHint.ts` — useShowFastIconHint 的 React UI 组件。
- `useSwarmBanner.ts` — useSwarmBanner 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。
- `VoiceIndicator.tsx` — VoiceIndicator 的 React UI 组件。

#### src/components/sandbox

沙箱相关组件。

- `SandboxConfigTab.tsx` — SandboxConfigTab 的 React UI 组件。
- `SandboxDependenciesTab.tsx` — SandboxDependenciesTab 的 React UI 组件。
- `SandboxDoctorSection.tsx` — SandboxDoctorSection 的 React UI 组件。
- `SandboxOverridesTab.tsx` — SandboxOverridesTab 的 React UI 组件。
- `SandboxSettings.tsx` — SandboxSettings 的 React UI 组件。

#### src/components/Settings

设置界面组件。

- `Config.tsx` — Config 的 React UI 组件。
- `Settings.tsx` — Settings 的 React UI 组件。
- `Status.tsx` — Status 的 React UI 组件。
- `Usage.tsx` — Usage 的 React UI 组件。

#### src/components/shell

shell 相关组件。

- `ExpandShellOutputContext.tsx` — ExpandShellOutputContext 的 React UI 组件。
- `OutputLine.tsx` — OutputLine 的 React UI 组件。
- `ShellProgressMessage.tsx` — ShellProgressMessage 的 React UI 组件。
- `ShellTimeDisplay.tsx` — ShellTimeDisplay 的 React UI 组件。

#### src/components/skills

技能相关组件。

- `SkillsMenu.tsx` — SkillsMenu 的 React UI 组件。

#### src/components/Spinner

加载动画（Spinner）组件。

- `FlashingChar.tsx` — FlashingChar 的 React UI 组件。
- `GlimmerMessage.tsx` — GlimmerMessage 的 React UI 组件。
- `index.ts` — index 的 React UI 组件。
- `ShimmerChar.tsx` — ShimmerChar 的 React UI 组件。
- `SpinnerAnimationRow.tsx` — SpinnerAnimationRow 的 React UI 组件。
- `SpinnerGlyph.tsx` — SpinnerGlyph 的 React UI 组件。
- `teammateSelectHint.ts` — teammateSelectHint 的 React UI 组件。
- `TeammateSpinnerLine.tsx` — TeammateSpinnerLine 的 React UI 组件。
- `TeammateSpinnerTree.tsx` — TeammateSpinnerTree 的 React UI 组件。
- `useShimmerAnimation.ts` — useShimmerAnimation 的 React UI 组件。
- `useStalledAnimation.ts` — useStalledAnimation 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。

#### src/components/StructuredDiff

结构化 diff 展示组件。

- `colorDiff.ts` — colorDiff 的 React UI 组件。
- `Fallback.tsx` — Fallback 的 React UI 组件。

#### src/components/tasks

任务相关组件。

- `AsyncAgentDetailDialog.tsx` — AsyncAgentDetailDialog 的 React UI 组件。
- `BackgroundTask.tsx` — BackgroundTask 的 React UI 组件。
- `BackgroundTasksDialog.tsx` — BackgroundTasksDialog 的 React UI 组件。
- `BackgroundTaskStatus.tsx` — BackgroundTaskStatus 的 React UI 组件。
- `DreamDetailDialog.tsx` — DreamDetailDialog 的 React UI 组件。
- `InProcessTeammateDetailDialog.tsx` — InProcessTeammateDetailDialog 的 React UI 组件。
- `RemoteSessionDetailDialog.tsx` — RemoteSessionDetailDialog 的 React UI 组件。
- `RemoteSessionProgress.tsx` — RemoteSessionProgress 的 React UI 组件。
- `renderToolActivity.tsx` — renderToolActivity 的 React UI 组件。
- `ShellDetailDialog.tsx` — ShellDetailDialog 的 React UI 组件。
- `ShellProgress.tsx` — ShellProgress 的 React UI 组件。
- `taskStatusUtils.tsx` — taskStatusUtils 的 React UI 组件。

#### src/components/teams

团队（teams）相关组件。

- `TeamsDialog.tsx` — TeamsDialog 的 React UI 组件。
- `TeamStatus.tsx` — TeamStatus 的 React UI 组件。

#### src/components/TrustDialog

信任 / 授权对话框。

- `TrustDialog.tsx` — TrustDialog 的 React UI 组件。
- `utils.ts` — utils 的 React UI 组件。

#### src/components/ui

基础 UI 组件。

- `OrderedList.tsx` — OrderedList 的 React UI 组件。
- `OrderedListItem.tsx` — OrderedListItem 的 React UI 组件。
- `TreeSelect.tsx` — TreeSelect 的 React UI 组件。

#### src/components/wizard

向导（wizard）组件。

- `index.ts` — index 的 React UI 组件。
- `useWizard.ts` — useWizard 的 React UI 组件。
- `WizardDialogLayout.tsx` — WizardDialogLayout 的 React UI 组件。
- `WizardNavigationFooter.tsx` — WizardNavigationFooter 的 React UI 组件。
- `WizardProvider.tsx` — WizardProvider 的 React UI 组件。

### src/constants

全局常量定义：产品 URL、文案、品牌标识、环境与配置常量。

- `apiLimits.ts` — apiLimits 相关常量定义。
- `betas.ts` — betas 相关常量定义。
- `common.ts` — common 相关常量定义。
- `cyberRiskInstruction.ts` — cyberRiskInstruction 相关常量定义。
- `errorIds.ts` — errorIds 相关常量定义。
- `figures.ts` — figures 相关常量定义。
- `files.ts` — files 相关常量定义。
- `github-app.ts` — github-app 相关常量定义。
- `keys.ts` — keys 相关常量定义。
- `messages.ts` — messages 相关常量定义。
- `oauth.ts` — oauth 相关常量定义。
- `outputStyles.ts` — outputStyles 相关常量定义。
- `product.ts` — product 相关常量定义。
- `prompts.ts` — prompts 相关常量定义。
- `spinnerVerbs.ts` — spinnerVerbs 相关常量定义。
- `system.ts` — system 相关常量定义。
- `systemPromptSections.ts` — systemPromptSections 相关常量定义。
- `toolLimits.ts` — toolLimits 相关常量定义。
- `tools.ts` — tools 相关常量定义。
- `turnCompletionVerbs.ts` — turnCompletionVerbs 相关常量定义。
- `xml.ts` — xml 相关常量定义。

### src/context

React Context 提供者集合：模态框、通知、覆盖层、统计、语音、排队消息等全局 UI 状态。

- `fpsMetrics.tsx` — FPS 指标 React context。
- `mailbox.tsx` — 邮箱（mailbox）React context。
- `modalContext.tsx` — 模态框 React context。
- `notifications.tsx` — 通知 React context。
- `overlayContext.tsx` — 覆盖层 React context。
- `promptOverlayContext.tsx` — prompt 覆盖层 React context。
- `QueuedMessageContext.tsx` — 排队消息 React context。
- `stats.tsx` — 统计 React context。
- `voice.tsx` — 语音 React context。

### src/coordinator

协调器（Coordinator）：编排多智能体 / 子任务的工作流。

- `coordinatorMode.ts` — 协调器模式逻辑。

### src/entrypoints

程序入口：CLI 主入口、SDK 入口以及 SDK/控制相关类型定义。

- `agentSdkTypes.ts` — Agent SDK 类型定义。
- `cli.tsx` — CLI 入口组件。
- `init.ts` — 初始化入口。
- `mcp.ts` — MCP 入口。
- `sandboxTypes.ts` — 沙箱类型定义。

#### src/entrypoints/sdk

Agent SDK 入口与类型：SDK 初始化、控制类型（controlTypes）等。

- `controlSchemas.ts` — SDK 控制 schema。
- `coreSchemas.ts` — SDK 核心 schema。
- `coreTypes.ts` — SDK 核心类型。

### src/hooks

React hooks 集合：通知、工具权限等核心 hook 逻辑。

- `fileSuggestions.ts` — fileSuggestions 相关的 React hook / 逻辑。
- `renderPlaceholder.ts` — renderPlaceholder 相关的 React hook / 逻辑。
- `unifiedSuggestions.ts` — unifiedSuggestions 相关的 React hook / 逻辑。
- `useAfterFirstRender.ts` — useAfterFirstRender 相关的 React hook / 逻辑。
- `useApiKeyVerification.ts` — useApiKeyVerification 相关的 React hook / 逻辑。
- `useArrowKeyHistory.tsx` — useArrowKeyHistory 相关的 React hook / 逻辑。
- `useAssistantHistory.ts` — useAssistantHistory 相关的 React hook / 逻辑。
- `useAwaySummary.ts` — useAwaySummary 相关的 React hook / 逻辑。
- `useBackgroundTaskNavigation.ts` — useBackgroundTaskNavigation 相关的 React hook / 逻辑。
- `useBlink.ts` — useBlink 相关的 React hook / 逻辑。
- `useCancelRequest.ts` — useCancelRequest 相关的 React hook / 逻辑。
- `useCanUseTool.tsx` — useCanUseTool 相关的 React hook / 逻辑。
- `useChromeExtensionNotification.tsx` — useChromeExtensionNotification 相关的 React hook / 逻辑。
- `useClaudeCodeHintRecommendation.tsx` — useClaudeCodeHintRecommendation 相关的 React hook / 逻辑。
- `useClipboardImageHint.ts` — useClipboardImageHint 相关的 React hook / 逻辑。
- `useCommandKeybindings.tsx` — useCommandKeybindings 相关的 React hook / 逻辑。
- `useCommandQueue.ts` — useCommandQueue 相关的 React hook / 逻辑。
- `useCopyOnSelect.ts` — useCopyOnSelect 相关的 React hook / 逻辑。
- `useDeferredHookMessages.ts` — useDeferredHookMessages 相关的 React hook / 逻辑。
- `useDiffData.ts` — useDiffData 相关的 React hook / 逻辑。
- `useDiffInIDE.ts` — useDiffInIDE 相关的 React hook / 逻辑。
- `useDirectConnect.ts` — useDirectConnect 相关的 React hook / 逻辑。
- `useDoublePress.ts` — useDoublePress 相关的 React hook / 逻辑。
- `useDynamicConfig.ts` — useDynamicConfig 相关的 React hook / 逻辑。
- `useElapsedTime.ts` — useElapsedTime 相关的 React hook / 逻辑。
- `useExitOnCtrlCD.ts` — useExitOnCtrlCD 相关的 React hook / 逻辑。
- `useExitOnCtrlCDWithKeybindings.ts` — useExitOnCtrlCDWithKeybindings 相关的 React hook / 逻辑。
- `useFileHistorySnapshotInit.ts` — useFileHistorySnapshotInit 相关的 React hook / 逻辑。
- `useGlobalKeybindings.tsx` — useGlobalKeybindings 相关的 React hook / 逻辑。
- `useHistorySearch.ts` — useHistorySearch 相关的 React hook / 逻辑。
- `useIdeAtMentioned.ts` — useIdeAtMentioned 相关的 React hook / 逻辑。
- `useIdeConnectionStatus.ts` — useIdeConnectionStatus 相关的 React hook / 逻辑。
- `useIDEIntegration.tsx` — useIDEIntegration 相关的 React hook / 逻辑。
- `useIdeLogging.ts` — useIdeLogging 相关的 React hook / 逻辑。
- `useIdeSelection.ts` — useIdeSelection 相关的 React hook / 逻辑。
- `useInboxPoller.ts` — useInboxPoller 相关的 React hook / 逻辑。
- `useInputBuffer.ts` — useInputBuffer 相关的 React hook / 逻辑。
- `useIssueFlagBanner.ts` — useIssueFlagBanner 相关的 React hook / 逻辑。
- `useLogMessages.ts` — useLogMessages 相关的 React hook / 逻辑。
- `useLspPluginRecommendation.tsx` — useLspPluginRecommendation 相关的 React hook / 逻辑。
- `useMailboxBridge.ts` — useMailboxBridge 相关的 React hook / 逻辑。
- `useMainLoopModel.ts` — useMainLoopModel 相关的 React hook / 逻辑。
- `useManagePlugins.ts` — useManagePlugins 相关的 React hook / 逻辑。
- `useMemoryUsage.ts` — useMemoryUsage 相关的 React hook / 逻辑。
- `useMergedClients.ts` — useMergedClients 相关的 React hook / 逻辑。
- `useMergedCommands.ts` — useMergedCommands 相关的 React hook / 逻辑。
- `useMergedTools.ts` — useMergedTools 相关的 React hook / 逻辑。
- `useMinDisplayTime.ts` — useMinDisplayTime 相关的 React hook / 逻辑。
- `useNotifyAfterTimeout.ts` — useNotifyAfterTimeout 相关的 React hook / 逻辑。
- `useOfficialMarketplaceNotification.tsx` — useOfficialMarketplaceNotification 相关的 React hook / 逻辑。
- `usePasteHandler.ts` — usePasteHandler 相关的 React hook / 逻辑。
- `usePluginRecommendationBase.tsx` — usePluginRecommendationBase 相关的 React hook / 逻辑。
- `usePromptsFromClaudeInChrome.tsx` — usePromptsFromClaudeInChrome 相关的 React hook / 逻辑。
- `usePromptSuggestion.ts` — usePromptSuggestion 相关的 React hook / 逻辑。
- `usePrStatus.ts` — usePrStatus 相关的 React hook / 逻辑。
- `useQueueProcessor.ts` — useQueueProcessor 相关的 React hook / 逻辑。
- `useRemoteSession.ts` — useRemoteSession 相关的 React hook / 逻辑。
- `useReplBridge.tsx` — useReplBridge 相关的 React hook / 逻辑。
- `useScheduledTasks.ts` — useScheduledTasks 相关的 React hook / 逻辑。
- `useSearchInput.ts` — useSearchInput 相关的 React hook / 逻辑。
- `useSessionBackgrounding.ts` — useSessionBackgrounding 相关的 React hook / 逻辑。
- `useSettings.ts` — useSettings 相关的 React hook / 逻辑。
- `useSettingsChange.ts` — useSettingsChange 相关的 React hook / 逻辑。
- `useSkillImprovementSurvey.ts` — useSkillImprovementSurvey 相关的 React hook / 逻辑。
- `useSkillsChange.ts` — useSkillsChange 相关的 React hook / 逻辑。
- `useSSHSession.ts` — useSSHSession 相关的 React hook / 逻辑。
- `useSwarmInitialization.ts` — useSwarmInitialization 相关的 React hook / 逻辑。
- `useSwarmPermissionPoller.ts` — useSwarmPermissionPoller 相关的 React hook / 逻辑。
- `useTaskListWatcher.ts` — useTaskListWatcher 相关的 React hook / 逻辑。
- `useTasksV2.ts` — useTasksV2 相关的 React hook / 逻辑。
- `useTeammateViewAutoExit.ts` — useTeammateViewAutoExit 相关的 React hook / 逻辑。
- `useTeleportResume.tsx` — useTeleportResume 相关的 React hook / 逻辑。
- `useTerminalSize.ts` — useTerminalSize 相关的 React hook / 逻辑。
- `useTextInput.ts` — useTextInput 相关的 React hook / 逻辑。
- `useTimeout.ts` — useTimeout 相关的 React hook / 逻辑。
- `useTurnDiffs.ts` — useTurnDiffs 相关的 React hook / 逻辑。
- `useTypeahead.tsx` — useTypeahead 相关的 React hook / 逻辑。
- `useUpdateNotification.ts` — useUpdateNotification 相关的 React hook / 逻辑。
- `useVimInput.ts` — useVimInput 相关的 React hook / 逻辑。
- `useVirtualScroll.ts` — useVirtualScroll 相关的 React hook / 逻辑。
- `useVoice.ts` — useVoice 相关的 React hook / 逻辑。
- `useVoiceEnabled.ts` — useVoiceEnabled 相关的 React hook / 逻辑。
- `useVoiceIntegration.tsx` — useVoiceIntegration 相关的 React hook / 逻辑。

#### src/hooks/notifs

通知相关 hooks。

- `useAutoModeUnavailableNotification.ts` — useAutoModeUnavailableNotification 相关的 React hook / 逻辑。
- `useCanSwitchToExistingSubscription.tsx` — useCanSwitchToExistingSubscription 相关的 React hook / 逻辑。
- `useDeprecationWarningNotification.tsx` — useDeprecationWarningNotification 相关的 React hook / 逻辑。
- `useFastModeNotification.tsx` — useFastModeNotification 相关的 React hook / 逻辑。
- `useIDEStatusIndicator.tsx` — useIDEStatusIndicator 相关的 React hook / 逻辑。
- `useInstallMessages.tsx` — useInstallMessages 相关的 React hook / 逻辑。
- `useLspInitializationNotification.tsx` — useLspInitializationNotification 相关的 React hook / 逻辑。
- `useMcpConnectivityStatus.tsx` — useMcpConnectivityStatus 相关的 React hook / 逻辑。
- `useModelMigrationNotifications.tsx` — useModelMigrationNotifications 相关的 React hook / 逻辑。
- `useNpmDeprecationNotification.tsx` — useNpmDeprecationNotification 相关的 React hook / 逻辑。
- `usePluginAutoupdateNotification.tsx` — usePluginAutoupdateNotification 相关的 React hook / 逻辑。
- `usePluginInstallationStatus.tsx` — usePluginInstallationStatus 相关的 React hook / 逻辑。
- `useRateLimitWarningNotification.tsx` — useRateLimitWarningNotification 相关的 React hook / 逻辑。
- `useSettingsErrors.tsx` — useSettingsErrors 相关的 React hook / 逻辑。
- `useStartupNotification.ts` — useStartupNotification 相关的 React hook / 逻辑。
- `useTeammateShutdownNotification.ts` — useTeammateShutdownNotification 相关的 React hook / 逻辑。

#### src/hooks/toolPermission

工具权限相关 hooks。

- `PermissionContext.ts` — PermissionContext 相关的 React hook / 逻辑。
- `permissionLogging.ts` — permissionLogging 相关的 React hook / 逻辑。

##### src/hooks/toolPermission/handlers

工具权限处理器逻辑。

- `coordinatorHandler.ts` — coordinatorHandler 相关的 React hook / 逻辑。
- `interactiveHandler.ts` — interactiveHandler 相关的 React hook / 逻辑。
- `swarmWorkerHandler.ts` — swarmWorkerHandler 相关的 React hook / 逻辑。

### src/ink

Ink（基于 React 的终端渲染库）封装：终端 UI 的组件、事件、布局与 termio 输入输出。

- `Ansi.tsx` — Ink 终端渲染：Ansi。
- `bidi.ts` — Ink 终端渲染：bidi。
- `clearTerminal.ts` — Ink 终端渲染：clearTerminal。
- `colorize.ts` — Ink 终端渲染：colorize。
- `constants.ts` — Ink 终端渲染：constants。
- `dom.ts` — Ink 终端渲染：dom。
- `focus.ts` — Ink 终端渲染：focus。
- `frame.ts` — Ink 终端渲染：frame。
- `get-max-width.ts` — Ink 终端渲染：get-max-width。
- `hit-test.ts` — Ink 终端渲染：hit-test。
- `ink.tsx` — Ink 终端渲染：ink。
- `instances.ts` — Ink 终端渲染：instances。
- `line-width-cache.ts` — Ink 终端渲染：line-width-cache。
- `log-update.ts` — Ink 终端渲染：log-update。
- `measure-element.ts` — Ink 终端渲染：measure-element。
- `measure-text.ts` — Ink 终端渲染：measure-text。
- `node-cache.ts` — Ink 终端渲染：node-cache。
- `optimizer.ts` — Ink 终端渲染：optimizer。
- `output.ts` — Ink 终端渲染：output。
- `parse-keypress.ts` — Ink 终端渲染：parse-keypress。
- `reconciler.ts` — Ink 终端渲染：reconciler。
- `render-border.ts` — Ink 终端渲染：render-border。
- `render-node-to-output.ts` — Ink 终端渲染：render-node-to-output。
- `render-to-screen.ts` — Ink 终端渲染：render-to-screen。
- `renderer.ts` — Ink 终端渲染：renderer。
- `root.ts` — Ink 终端渲染：root。
- `screen.ts` — Ink 终端渲染：screen。
- `searchHighlight.ts` — Ink 终端渲染：searchHighlight。
- `selection.ts` — Ink 终端渲染：selection。
- `squash-text-nodes.ts` — Ink 终端渲染：squash-text-nodes。
- `stringWidth.ts` — Ink 终端渲染：stringWidth。
- `styles.ts` — Ink 终端渲染：styles。
- `supports-hyperlinks.ts` — Ink 终端渲染：supports-hyperlinks。
- `tabstops.ts` — Ink 终端渲染：tabstops。
- `terminal-focus-state.ts` — Ink 终端渲染：terminal-focus-state。
- `terminal-querier.ts` — Ink 终端渲染：terminal-querier。
- `terminal.ts` — Ink 终端渲染：terminal。
- `termio.ts` — Ink 终端渲染：termio。
- `useTerminalNotification.ts` — Ink 终端渲染：useTerminalNotification。
- `warn.ts` — Ink 终端渲染：warn。
- `widest-line.ts` — Ink 终端渲染：widest-line。
- `wrap-text.ts` — Ink 终端渲染：wrap-text。
- `wrapAnsi.ts` — Ink 终端渲染：wrapAnsi。

#### src/ink/components

Ink 终端 UI 组件。

- `AlternateScreen.tsx` — Ink 终端渲染：AlternateScreen。
- `App.tsx` — Ink 终端渲染：App。
- `AppContext.ts` — Ink 终端渲染：AppContext。
- `Box.tsx` — Ink 终端渲染：Box。
- `Button.tsx` — Ink 终端渲染：Button。
- `ClockContext.tsx` — Ink 终端渲染：ClockContext。
- `CursorDeclarationContext.ts` — Ink 终端渲染：CursorDeclarationContext。
- `ErrorOverview.tsx` — Ink 终端渲染：ErrorOverview。
- `Link.tsx` — Ink 终端渲染：Link。
- `Newline.tsx` — Ink 终端渲染：Newline。
- `NoSelect.tsx` — Ink 终端渲染：NoSelect。
- `RawAnsi.tsx` — Ink 终端渲染：RawAnsi。
- `ScrollBox.tsx` — Ink 终端渲染：ScrollBox。
- `Spacer.tsx` — Ink 终端渲染：Spacer。
- `StdinContext.ts` — Ink 终端渲染：StdinContext。
- `TerminalFocusContext.tsx` — Ink 终端渲染：TerminalFocusContext。
- `TerminalSizeContext.tsx` — Ink 终端渲染：TerminalSizeContext。
- `Text.tsx` — Ink 终端渲染：Text。

#### src/ink/events

Ink 事件处理。

- `click-event.ts` — Ink 终端渲染：click-event。
- `dispatcher.ts` — Ink 终端渲染：dispatcher。
- `emitter.ts` — Ink 终端渲染：emitter。
- `event-handlers.ts` — Ink 终端渲染：event-handlers。
- `event.ts` — Ink 终端渲染：event。
- `focus-event.ts` — Ink 终端渲染：focus-event。
- `input-event.ts` — Ink 终端渲染：input-event。
- `keyboard-event.ts` — Ink 终端渲染：keyboard-event。
- `terminal-event.ts` — Ink 终端渲染：terminal-event。
- `terminal-focus-event.ts` — Ink 终端渲染：terminal-focus-event。

#### src/ink/hooks

Ink 相关 hooks。

- `use-animation-frame.ts` — Ink 终端渲染：use-animation-frame。
- `use-app.ts` — Ink 终端渲染：use-app。
- `use-declared-cursor.ts` — Ink 终端渲染：use-declared-cursor。
- `use-input.ts` — Ink 终端渲染：use-input。
- `use-interval.ts` — Ink 终端渲染：use-interval。
- `use-search-highlight.ts` — Ink 终端渲染：use-search-highlight。
- `use-selection.ts` — Ink 终端渲染：use-selection。
- `use-stdin.ts` — Ink 终端渲染：use-stdin。
- `use-tab-status.ts` — Ink 终端渲染：use-tab-status。
- `use-terminal-focus.ts` — Ink 终端渲染：use-terminal-focus。
- `use-terminal-title.ts` — Ink 终端渲染：use-terminal-title。
- `use-terminal-viewport.ts` — Ink 终端渲染：use-terminal-viewport。

#### src/ink/layout

Ink 布局组件。

- `engine.ts` — Ink 终端渲染：engine。
- `geometry.ts` — Ink 终端渲染：geometry。
- `node.ts` — Ink 终端渲染：node。
- `yoga.ts` — Ink 终端渲染：yoga。

#### src/ink/termio

Ink termio 输入输出封装。

- `ansi.ts` — Ink 终端渲染：ansi。
- `csi.ts` — Ink 终端渲染：csi。
- `dec.ts` — Ink 终端渲染：dec。
- `esc.ts` — Ink 终端渲染：esc。
- `osc.ts` — Ink 终端渲染：osc。
- `parser.ts` — Ink 终端渲染：parser。
- `sgr.ts` — Ink 终端渲染：sgr。
- `tokenize.ts` — Ink 终端渲染：tokenize。
- `types.ts` — Ink 终端渲染：types。

### src/keybindings

按键绑定：加载、解析并合并用户自定义 keybindings。

- `defaultBindings.ts` — defaultBindings 按键绑定相关实现。
- `KeybindingContext.tsx` — KeybindingContext 按键绑定相关实现。
- `KeybindingProviderSetup.tsx` — KeybindingProviderSetup 按键绑定相关实现。
- `loadUserBindings.ts` — loadUserBindings 按键绑定相关实现。
- `match.ts` — match 按键绑定相关实现。
- `parser.ts` — parser 按键绑定相关实现。
- `reservedShortcuts.ts` — reservedShortcuts 按键绑定相关实现。
- `resolver.ts` — resolver 按键绑定相关实现。
- `schema.ts` — schema 按键绑定相关实现。
- `shortcutFormat.ts` — shortcutFormat 按键绑定相关实现。
- `template.ts` — template 按键绑定相关实现。
- `useKeybinding.ts` — useKeybinding 按键绑定相关实现。
- `useShortcutDisplay.ts` — useShortcutDisplay 按键绑定相关实现。
- `validate.ts` — validate 按键绑定相关实现。

### src/memdir

内存目录（MEMDIR）：发现并加载 `CLAUDE.md` 等记忆文件。

- `findRelevantMemories.ts` — findRelevantMemories 内存目录相关实现。
- `memdir.ts` — memdir 内存目录相关实现。
- `memoryAge.ts` — memoryAge 内存目录相关实现。
- `memoryScan.ts` — memoryScan 内存目录相关实现。
- `memoryTypes.ts` — memoryTypes 内存目录相关实现。
- `paths.ts` — paths 内存目录相关实现。
- `teamMemPaths.ts` — teamMemPaths 内存目录相关实现。
- `teamMemPrompts.ts` — teamMemPrompts 内存目录相关实现。

### src/migrations

配置 / 数据迁移：把旧版本配置或数据结构升级到当前版本。

- `migrateAutoUpdatesToSettings.ts` — migrateAutoUpdatesToSettings 数据迁移逻辑。
- `migrateBypassPermissionsAcceptedToSettings.ts` — migrateBypassPermissionsAcceptedToSettings 数据迁移逻辑。
- `migrateEnableAllProjectMcpServersToSettings.ts` — migrateEnableAllProjectMcpServersToSettings 数据迁移逻辑。
- `migrateFennecToOpus.ts` — migrateFennecToOpus 数据迁移逻辑。
- `migrateLegacyOpusToCurrent.ts` — migrateLegacyOpusToCurrent 数据迁移逻辑。
- `migrateOpusToOpus1m.ts` — migrateOpusToOpus1m 数据迁移逻辑。
- `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` — migrateReplBridgeEnabledToRemoteControlAtStartup 数据迁移逻辑。
- `migrateSonnet1mToSonnet45.ts` — migrateSonnet1mToSonnet45 数据迁移逻辑。
- `migrateSonnet45ToSonnet46.ts` — migrateSonnet45ToSonnet46 数据迁移逻辑。
- `resetAutoModeOptInForDefaultOffer.ts` — resetAutoModeOptInForDefaultOffer 数据迁移逻辑。
- `resetProToOpusDefault.ts` — resetProToOpusDefault 数据迁移逻辑。

### src/moreright

“更多操作”面板相关代码。

- `useMoreRight.tsx` — useMoreRight hook（更多操作面板）。

### src/native-ts

原生（native）模块的 TypeScript 封装：color-diff、file-index、yoga-layout。

#### src/native-ts/color-diff

颜色 diff 原生模块封装。

- `index.ts` — 颜色 diff 原生模块封装。

#### src/native-ts/file-index

文件索引原生模块封装。

- `index.ts` — 文件索引原生模块封装。

#### src/native-ts/yoga-layout

Yoga 布局原生模块封装。

- `enums.ts` — Yoga 布局枚举。
- `index.ts` — Yoga 布局原生模块封装。

### src/outputStyles

输出样式（output style）定义与相关逻辑。

- `loadOutputStylesDir.ts` — 加载输出样式目录。

### src/plugins

插件运行时：加载、捆绑与管理本地插件。

- `builtinPlugins.ts` — 内置插件定义。

#### src/plugins/bundled

捆绑的内置插件。

- `index.ts` — 捆绑插件入口。

### src/query

查询引擎：针对代码库的搜索 / 查询（QueryEngine）。

- `config.ts` — 查询配置。
- `deps.ts` — 查询依赖注入。
- `stopHooks.ts` — 查询停止 hooks。
- `tokenBudget.ts` — Token 预算查询。

### src/remote

远程会话相关实现。

- `remotePermissionBridge.ts` — 远程权限桥接。
- `RemoteSessionManager.ts` — 远程会话管理器。
- `sdkMessageAdapter.ts` — SDK 消息适配器。
- `SessionsWebSocket.ts` — 会话 WebSocket 连接。

### src/schemas

schema 定义。

- `hooks.ts` — hooks schema 定义。

### src/screens

终端全屏视图 / 屏幕实现。

- `Doctor.tsx` — Doctor 诊断屏幕。
- `REPL.tsx` — REPL 主屏幕。
- `ResumeConversation.tsx` — 恢复会话屏幕。

### src/server

本地服务器相关实现。

- `createDirectConnectSession.ts` — 创建直连会话。
- `directConnectManager.ts` — 直连管理器。
- `types.ts` — 服务器类型定义。

### src/services

业务服务层：分析、API、LSP、MCP、OAuth、插件、压缩、记忆提取、设置同步等面向具体能力的服务。

- `awaySummary.ts` — 离开摘要（away summary）服务。
- `claudeAiLimits.ts` — Claude AI 限额（limits）读取。
- `claudeAiLimitsHook.ts` — Claude AI 限额 hook。
- `diagnosticTracking.ts` — 诊断追踪服务。
- `internalLogging.ts` — 内部日志服务。
- `mcpServerApproval.tsx` — MCP 服务器审批服务。
- `mockRateLimits.ts` — 模拟速率限额（调试用）。
- `notifier.ts` — 通知器服务。
- `preventSleep.ts` — 防止系统休眠服务。
- `rateLimitMessages.ts` — 速率限制消息服务。
- `rateLimitMocking.ts` — 速率限制模拟服务。
- `tokenEstimation.ts` — Token 估算服务。
- `vcr.ts` — VCR（录制/回放）服务。
- `voice.ts` — 语音服务。
- `voiceKeyterms.ts` — 语音关键词服务。
- `voiceStreamSTT.ts` — 语音流式 STT（语音转文字）服务。

#### src/services/AgentSummary

代理摘要服务。

- `agentSummary.ts` — AgentSummary 服务中的 `agentSummary` 实现。

#### src/services/analytics

分析 / 遥测事件（analytics + growthbook）服务。

- `config.ts` — analytics 服务中的 `config` 实现。
- `datadog.ts` — analytics 服务中的 `datadog` 实现。
- `firstPartyEventLogger.ts` — analytics 服务中的 `firstPartyEventLogger` 实现。
- `firstPartyEventLoggingExporter.ts` — analytics 服务中的 `firstPartyEventLoggingExporter` 实现。
- `growthbook.ts` — analytics 服务中的 `growthbook` 实现。
- `index.ts` — analytics 服务的入口 / 导出。
- `metadata.ts` — analytics 服务中的 `metadata` 实现。
- `sink.ts` — analytics 服务中的 `sink` 实现。
- `sinkKillswitch.ts` — analytics 服务中的 `sinkKillswitch` 实现。

#### src/services/api

后端 API 服务：认证、referral、session 等远程接口。

- `adminRequests.ts` — api 服务中的 `adminRequests` 实现。
- `bootstrap.ts` — api 服务中的 `bootstrap` 实现。
- `claude.ts` — api 服务中的 `claude` 实现。
- `client.ts` — api 服务中的 `client` 实现。
- `dumpPrompts.ts` — api 服务中的 `dumpPrompts` 实现。
- `emptyUsage.ts` — api 服务中的 `emptyUsage` 实现。
- `errors.ts` — api 服务中的 `errors` 实现。
- `errorUtils.ts` — api 服务中的 `errorUtils` 实现。
- `filesApi.ts` — api 服务中的 `filesApi` 实现。
- `firstTokenDate.ts` — api 服务中的 `firstTokenDate` 实现。
- `grove.ts` — api 服务中的 `grove` 实现。
- `logging.ts` — api 服务中的 `logging` 实现。
- `metricsOptOut.ts` — api 服务中的 `metricsOptOut` 实现。
- `overageCreditGrant.ts` — api 服务中的 `overageCreditGrant` 实现。
- `promptCacheBreakDetection.ts` — api 服务中的 `promptCacheBreakDetection` 实现。
- `referral.ts` — api 服务中的 `referral` 实现。
- `sessionIngress.ts` — api 服务中的 `sessionIngress` 实现。
- `ultrareviewQuota.ts` — api 服务中的 `ultrareviewQuota` 实现。
- `usage.ts` — api 服务中的 `usage` 实现。
- `withRetry.ts` — api 服务中的 `withRetry` 实现。

#### src/services/autoDream

自动 Dream（后台学习）服务。

- `autoDream.ts` — autoDream 服务中的 `autoDream` 实现。
- `config.ts` — autoDream 服务中的 `config` 实现。
- `consolidationLock.ts` — autoDream 服务中的 `consolidationLock` 实现。
- `consolidationPrompt.ts` — autoDream 服务中的 `consolidationPrompt` 实现。

#### src/services/compact

上下文压缩服务。

- `apiMicrocompact.ts` — compact 服务中的 `apiMicrocompact` 实现。
- `autoCompact.ts` — compact 服务中的 `autoCompact` 实现。
- `compact.ts` — compact 服务中的 `compact` 实现。
- `compactWarningHook.ts` — compact 服务中的 `compactWarningHook` 实现。
- `compactWarningState.ts` — compact 服务中的 `compactWarningState` 实现。
- `grouping.ts` — compact 服务中的 `grouping` 实现。
- `microCompact.ts` — compact 服务中的 `microCompact` 实现。
- `postCompactCleanup.ts` — compact 服务中的 `postCompactCleanup` 实现。
- `prompt.ts` — compact 服务中的 `prompt` 实现。
- `sessionMemoryCompact.ts` — compact 服务中的 `sessionMemoryCompact` 实现。
- `timeBasedMCConfig.ts` — compact 服务中的 `timeBasedMCConfig` 实现。

#### src/services/extractMemories

记忆提取服务。

- `extractMemories.ts` — extractMemories 服务中的 `extractMemories` 实现。
- `prompts.ts` — extractMemories 服务中的 `prompts` 实现。

#### src/services/lsp

LSP（语言服务器）集成服务。

- `config.ts` — lsp 服务中的 `config` 实现。
- `LSPClient.ts` — lsp 服务中的 `LSPClient` 实现。
- `LSPDiagnosticRegistry.ts` — lsp 服务中的 `LSPDiagnosticRegistry` 实现。
- `LSPServerInstance.ts` — lsp 服务中的 `LSPServerInstance` 实现。
- `LSPServerManager.ts` — lsp 服务中的 `LSPServerManager` 实现。
- `manager.ts` — lsp 服务中的 `manager` 实现。
- `passiveFeedback.ts` — lsp 服务中的 `passiveFeedback` 实现。

#### src/services/MagicDocs

MagicDocs 服务。

- `magicDocs.ts` — MagicDocs 服务中的 `magicDocs` 实现。
- `prompts.ts` — MagicDocs 服务中的 `prompts` 实现。

#### src/services/mcp

MCP（Model Context Protocol）服务。

- `auth.ts` — mcp 服务中的 `auth` 实现。
- `channelAllowlist.ts` — mcp 服务中的 `channelAllowlist` 实现。
- `channelNotification.ts` — mcp 服务中的 `channelNotification` 实现。
- `channelPermissions.ts` — mcp 服务中的 `channelPermissions` 实现。
- `claudeai.ts` — mcp 服务中的 `claudeai` 实现。
- `client.ts` — mcp 服务中的 `client` 实现。
- `config.ts` — mcp 服务中的 `config` 实现。
- `elicitationHandler.ts` — mcp 服务中的 `elicitationHandler` 实现。
- `envExpansion.ts` — mcp 服务中的 `envExpansion` 实现。
- `headersHelper.ts` — mcp 服务中的 `headersHelper` 实现。
- `InProcessTransport.ts` — mcp 服务中的 `InProcessTransport` 实现。
- `MCPConnectionManager.tsx` — mcp 服务中的 `MCPConnectionManager` 实现。
- `mcpStringUtils.ts` — mcp 服务中的 `mcpStringUtils` 实现。
- `normalization.ts` — mcp 服务中的 `normalization` 实现。
- `oauthPort.ts` — mcp 服务中的 `oauthPort` 实现。
- `officialRegistry.ts` — mcp 服务中的 `officialRegistry` 实现。
- `SdkControlTransport.ts` — mcp 服务中的 `SdkControlTransport` 实现。
- `types.ts` — mcp 服务中的 `types` 实现。
- `useManageMCPConnections.ts` — mcp 服务中的 `useManageMCPConnections` 实现。
- `utils.ts` — mcp 服务中的 `utils` 实现。
- `vscodeSdkMcp.ts` — mcp 服务中的 `vscodeSdkMcp` 实现。
- `xaa.ts` — mcp 服务中的 `xaa` 实现。
- `xaaIdpLogin.ts` — mcp 服务中的 `xaaIdpLogin` 实现。

#### src/services/oauth

OAuth 认证服务。

- `auth-code-listener.ts` — oauth 服务中的 `auth-code-listener` 实现。
- `client.ts` — oauth 服务中的 `client` 实现。
- `crypto.ts` — oauth 服务中的 `crypto` 实现。
- `getOauthProfile.ts` — oauth 服务中的 `getOauthProfile` 实现。
- `index.ts` — oauth 服务的入口 / 导出。

#### src/services/plugins

插件服务。

- `pluginCliCommands.ts` — plugins 服务中的 `pluginCliCommands` 实现。
- `PluginInstallationManager.ts` — plugins 服务中的 `PluginInstallationManager` 实现。
- `pluginOperations.ts` — plugins 服务中的 `pluginOperations` 实现。

#### src/services/policyLimits

策略限额服务。

- `index.ts` — policyLimits 服务的入口 / 导出。
- `types.ts` — policyLimits 服务中的 `types` 实现。

#### src/services/PromptSuggestion

提示建议（Prompt Suggestion）服务。

- `promptSuggestion.ts` — PromptSuggestion 服务中的 `promptSuggestion` 实现。
- `speculation.ts` — PromptSuggestion 服务中的 `speculation` 实现。

#### src/services/remoteManagedSettings

远程受管设置服务。

- `index.ts` — remoteManagedSettings 服务的入口 / 导出。
- `securityCheck.tsx` — remoteManagedSettings 服务中的 `securityCheck` 实现。
- `syncCache.ts` — remoteManagedSettings 服务中的 `syncCache` 实现。
- `syncCacheState.ts` — remoteManagedSettings 服务中的 `syncCacheState` 实现。
- `types.ts` — remoteManagedSettings 服务中的 `types` 实现。

#### src/services/SessionMemory

会话记忆服务。

- `prompts.ts` — SessionMemory 服务中的 `prompts` 实现。
- `sessionMemory.ts` — SessionMemory 服务中的 `sessionMemory` 实现。
- `sessionMemoryUtils.ts` — SessionMemory 服务中的 `sessionMemoryUtils` 实现。

#### src/services/settingsSync

设置同步服务。

- `index.ts` — settingsSync 服务的入口 / 导出。
- `types.ts` — settingsSync 服务中的 `types` 实现。

#### src/services/teamMemorySync

团队记忆同步服务。

- `index.ts` — teamMemorySync 服务的入口 / 导出。
- `secretScanner.ts` — teamMemorySync 服务中的 `secretScanner` 实现。
- `teamMemSecretGuard.ts` — teamMemorySync 服务中的 `teamMemSecretGuard` 实现。
- `types.ts` — teamMemorySync 服务中的 `types` 实现。
- `watcher.ts` — teamMemorySync 服务中的 `watcher` 实现。

#### src/services/tips

提示（tips）服务。

- `tipHistory.ts` — tips 服务中的 `tipHistory` 实现。
- `tipRegistry.ts` — tips 服务中的 `tipRegistry` 实现。
- `tipScheduler.ts` — tips 服务中的 `tipScheduler` 实现。

#### src/services/tools

工具服务（工具发现/加载）。

- `StreamingToolExecutor.ts` — tools 服务中的 `StreamingToolExecutor` 实现。
- `toolExecution.ts` — tools 服务中的 `toolExecution` 实现。
- `toolHooks.ts` — tools 服务中的 `toolHooks` 实现。
- `toolOrchestration.ts` — tools 服务中的 `toolOrchestration` 实现。

#### src/services/toolUseSummary

工具使用摘要服务。

- `toolUseSummaryGenerator.ts` — toolUseSummary 服务中的 `toolUseSummaryGenerator` 实现。

### src/skills

技能（Skills）相关：内置技能的定义与加载。

- `bundledSkills.ts` — bundledSkills 技能相关实现。
- `loadSkillsDir.ts` — loadSkillsDir 技能相关实现。
- `mcpSkillBuilders.ts` — mcpSkillBuilders 技能相关实现。

#### src/skills/bundled

捆绑的内置技能。

- `batch.ts` — batch 技能相关实现。
- `claudeApi.ts` — claudeApi 技能相关实现。
- `claudeApiContent.ts` — claudeApiContent 技能相关实现。
- `claudeInChrome.ts` — claudeInChrome 技能相关实现。
- `debug.ts` — debug 技能相关实现。
- `index.ts` — index 技能相关实现。
- `keybindings.ts` — keybindings 技能相关实现。
- `loop.ts` — loop 技能相关实现。
- `loremIpsum.ts` — loremIpsum 技能相关实现。
- `remember.ts` — remember 技能相关实现。
- `scheduleRemoteAgents.ts` — scheduleRemoteAgents 技能相关实现。
- `simplify.ts` — simplify 技能相关实现。
- `skillify.ts` — skillify 技能相关实现。
- `stuck.ts` — stuck 技能相关实现。
- `updateConfig.ts` — updateConfig 技能相关实现。
- `verify.ts` — verify 技能相关实现。
- `verifyContent.ts` — verifyContent 技能相关实现。

### src/state

状态管理相关实现。

- `AppState.tsx` — 应用状态定义。
- `AppStateStore.ts` — 应用状态存储。
- `onChangeAppState.ts` — 应用状态变更监听。
- `selectors.ts` — 状态选择器。
- `store.ts` — 状态 store。
- `teammateViewHelpers.ts` — 队友视图辅助。

### src/tasks

任务系统：本地 / 远程 Agent 任务、Shell 任务、Dream 任务等任务类型的实现。

- `LocalMainSessionTask.ts` — 本地主会话任务。
- `pillLabel.ts` — 任务 pill 标签。
- `stopTask.ts` — 停止任务。
- `types.ts` — 任务类型定义。

#### src/tasks/DreamTask

Dream 任务（后台学习任务）。

- `DreamTask.ts` — Dream 任务实现。

#### src/tasks/InProcessTeammateTask

进程内队友任务。

- `InProcessTeammateTask.tsx` — 进程内队友任务实现。
- `types.ts` — 进程内队友任务类型。

#### src/tasks/LocalAgentTask

本地代理任务。

- `LocalAgentTask.tsx` — 本地代理任务实现。

#### src/tasks/LocalShellTask

本地 shell 任务。

- `guards.ts` — 本地 shell 任务守卫。
- `killShellTasks.ts` — 终止本地 shell 任务。
- `LocalShellTask.tsx` — 本地 shell 任务实现。

#### src/tasks/RemoteAgentTask

远程代理任务。

- `RemoteAgentTask.tsx` — 远程代理任务实现。

### src/tools

Agent 工具集：Bash、文件读写/编辑、Grep/Glob、Web 搜索/抓取、MCP、任务、团队等各类工具的实现。

- `utils.ts` — 工具汇总 / 注册辅助函数。

#### src/tools/AgentTool

AgentTool：调用子代理执行任务的工具。

- `agentColorManager.ts` — AgentTool 工具中的 `agentColorManager` 实现。
- `agentDisplay.ts` — AgentTool 工具中的 `agentDisplay` 实现。
- `agentMemory.ts` — AgentTool 工具中的 `agentMemory` 实现。
- `agentMemorySnapshot.ts` — AgentTool 工具中的 `agentMemorySnapshot` 实现。
- `AgentTool.tsx` — AgentTool 工具中的 `AgentTool` 实现。
- `agentToolUtils.ts` — AgentTool 工具的辅助函数。
- `builtInAgents.ts` — AgentTool 工具中的 `builtInAgents` 实现。
- `constants.ts` — AgentTool 工具中的 `constants` 实现。
- `forkSubagent.ts` — AgentTool 工具中的 `forkSubagent` 实现。
- `loadAgentsDir.ts` — AgentTool 工具中的 `loadAgentsDir` 实现。
- `prompt.ts` — AgentTool 工具中的 `prompt` 实现。
- `resumeAgent.ts` — AgentTool 工具中的 `resumeAgent` 实现。
- `runAgent.ts` — AgentTool 工具中的 `runAgent` 实现。
- `UI.tsx` — AgentTool 工具中的 `UI` 实现。

##### src/tools/AgentTool/built-in

AgentTool 内置子代理定义。

- `claudeCodeGuideAgent.ts` — AgentTool 工具中的 `claudeCodeGuideAgent` 实现。
- `exploreAgent.ts` — AgentTool 工具中的 `exploreAgent` 实现。
- `generalPurposeAgent.ts` — AgentTool 工具中的 `generalPurposeAgent` 实现。
- `planAgent.ts` — AgentTool 工具中的 `planAgent` 实现。
- `statuslineSetup.ts` — AgentTool 工具中的 `statuslineSetup` 实现。
- `verificationAgent.ts` — AgentTool 工具中的 `verificationAgent` 实现。

#### src/tools/AskUserQuestionTool

AskUserQuestionTool：向用户提问的工具。

- `AskUserQuestionTool.tsx` — AskUserQuestionTool 工具中的 `AskUserQuestionTool` 实现。
- `prompt.ts` — AskUserQuestionTool 工具中的 `prompt` 实现。

#### src/tools/BashTool

BashTool：执行 Bash 命令的工具。

- `bashCommandHelpers.ts` — BashTool 工具的辅助函数。
- `bashPermissions.ts` — BashTool 工具中的 `bashPermissions` 实现。
- `bashSecurity.ts` — BashTool 工具中的 `bashSecurity` 实现。
- `BashTool.tsx` — BashTool 工具中的 `BashTool` 实现。
- `BashToolResultMessage.tsx` — BashTool 工具中的 `BashToolResultMessage` 实现。
- `commandSemantics.ts` — BashTool 工具中的 `commandSemantics` 实现。
- `commentLabel.ts` — BashTool 工具中的 `commentLabel` 实现。
- `destructiveCommandWarning.ts` — BashTool 工具中的 `destructiveCommandWarning` 实现。
- `modeValidation.ts` — BashTool 工具中的 `modeValidation` 实现。
- `pathValidation.ts` — BashTool 工具中的 `pathValidation` 实现。
- `prompt.ts` — BashTool 工具中的 `prompt` 实现。
- `readOnlyValidation.ts` — BashTool 工具中的 `readOnlyValidation` 实现。
- `sedEditParser.ts` — BashTool 工具中的 `sedEditParser` 实现。
- `sedValidation.ts` — BashTool 工具中的 `sedValidation` 实现。
- `shouldUseSandbox.ts` — BashTool 工具中的 `shouldUseSandbox` 实现。
- `toolName.ts` — BashTool 工具中的 `toolName` 实现。
- `UI.tsx` — BashTool 工具中的 `UI` 实现。
- `utils.ts` — BashTool 工具的辅助函数。

#### src/tools/BriefTool

BriefTool：生成/处理 brief 的工具。

- `attachments.ts` — BriefTool 工具中的 `attachments` 实现。
- `BriefTool.ts` — BriefTool 工具中的 `BriefTool` 实现。
- `prompt.ts` — BriefTool 工具中的 `prompt` 实现。
- `UI.tsx` — BriefTool 工具中的 `UI` 实现。
- `upload.ts` — BriefTool 工具中的 `upload` 实现。

#### src/tools/ConfigTool

ConfigTool：读取/修改配置的工具。

- `ConfigTool.ts` — ConfigTool 工具中的 `ConfigTool` 实现。
- `constants.ts` — ConfigTool 工具中的 `constants` 实现。
- `prompt.ts` — ConfigTool 工具中的 `prompt` 实现。
- `supportedSettings.ts` — ConfigTool 工具中的 `supportedSettings` 实现。
- `UI.tsx` — ConfigTool 工具中的 `UI` 实现。

#### src/tools/EnterPlanModeTool

EnterPlanModeTool：进入计划模式的工具。

- `constants.ts` — EnterPlanModeTool 工具中的 `constants` 实现。
- `EnterPlanModeTool.ts` — EnterPlanModeTool 工具中的 `EnterPlanModeTool` 实现。
- `prompt.ts` — EnterPlanModeTool 工具中的 `prompt` 实现。
- `UI.tsx` — EnterPlanModeTool 工具中的 `UI` 实现。

#### src/tools/EnterWorktreeTool

EnterWorktreeTool：进入 git worktree 的工具。

- `constants.ts` — EnterWorktreeTool 工具中的 `constants` 实现。
- `EnterWorktreeTool.ts` — EnterWorktreeTool 工具中的 `EnterWorktreeTool` 实现。
- `prompt.ts` — EnterWorktreeTool 工具中的 `prompt` 实现。
- `UI.tsx` — EnterWorktreeTool 工具中的 `UI` 实现。

#### src/tools/ExitPlanModeTool

ExitPlanModeTool：退出计划模式的工具。

- `constants.ts` — ExitPlanModeTool 工具中的 `constants` 实现。
- `ExitPlanModeV2Tool.ts` — ExitPlanModeTool 工具中的 `ExitPlanModeV2Tool` 实现。
- `prompt.ts` — ExitPlanModeTool 工具中的 `prompt` 实现。
- `UI.tsx` — ExitPlanModeTool 工具中的 `UI` 实现。

#### src/tools/ExitWorktreeTool

ExitWorktreeTool：退出 git worktree 的工具。

- `constants.ts` — ExitWorktreeTool 工具中的 `constants` 实现。
- `ExitWorktreeTool.ts` — ExitWorktreeTool 工具中的 `ExitWorktreeTool` 实现。
- `prompt.ts` — ExitWorktreeTool 工具中的 `prompt` 实现。
- `UI.tsx` — ExitWorktreeTool 工具中的 `UI` 实现。

#### src/tools/FileEditTool

FileEditTool：编辑文件的工具。

- `constants.ts` — FileEditTool 工具中的 `constants` 实现。
- `FileEditTool.ts` — FileEditTool 工具中的 `FileEditTool` 实现。
- `prompt.ts` — FileEditTool 工具中的 `prompt` 实现。
- `types.ts` — FileEditTool 工具的类型定义。
- `UI.tsx` — FileEditTool 工具中的 `UI` 实现。
- `utils.ts` — FileEditTool 工具的辅助函数。

#### src/tools/FileReadTool

FileReadTool：读取文件的工具。

- `FileReadTool.ts` — FileReadTool 工具中的 `FileReadTool` 实现。
- `imageProcessor.ts` — FileReadTool 工具中的 `imageProcessor` 实现。
- `limits.ts` — FileReadTool 工具中的 `limits` 实现。
- `prompt.ts` — FileReadTool 工具中的 `prompt` 实现。
- `UI.tsx` — FileReadTool 工具中的 `UI` 实现。

#### src/tools/FileWriteTool

FileWriteTool：写入文件的工具。

- `FileWriteTool.ts` — FileWriteTool 工具中的 `FileWriteTool` 实现。
- `prompt.ts` — FileWriteTool 工具中的 `prompt` 实现。
- `UI.tsx` — FileWriteTool 工具中的 `UI` 实现。

#### src/tools/GlobTool

GlobTool：按 glob 模式查找文件的工具。

- `GlobTool.ts` — GlobTool 工具中的 `GlobTool` 实现。
- `prompt.ts` — GlobTool 工具中的 `prompt` 实现。
- `UI.tsx` — GlobTool 工具中的 `UI` 实现。

#### src/tools/GrepTool

GrepTool：在文件中搜索文本的工具。

- `GrepTool.ts` — GrepTool 工具中的 `GrepTool` 实现。
- `prompt.ts` — GrepTool 工具中的 `prompt` 实现。
- `UI.tsx` — GrepTool 工具中的 `UI` 实现。

#### src/tools/ListMcpResourcesTool

ListMcpResourcesTool：列出 MCP 资源的工具。

- `ListMcpResourcesTool.ts` — ListMcpResourcesTool 工具中的 `ListMcpResourcesTool` 实现。
- `prompt.ts` — ListMcpResourcesTool 工具中的 `prompt` 实现。
- `UI.tsx` — ListMcpResourcesTool 工具中的 `UI` 实现。

#### src/tools/LSPTool

LSPTool：查询语言服务器的工具。

- `formatters.ts` — LSPTool 工具中的 `formatters` 实现。
- `LSPTool.ts` — LSPTool 工具中的 `LSPTool` 实现。
- `prompt.ts` — LSPTool 工具中的 `prompt` 实现。
- `schemas.ts` — LSPTool 工具中的 `schemas` 实现。
- `symbolContext.ts` — LSPTool 工具中的 `symbolContext` 实现。
- `UI.tsx` — LSPTool 工具中的 `UI` 实现。

#### src/tools/McpAuthTool

McpAuthTool：MCP 认证工具。

- `McpAuthTool.ts` — McpAuthTool 工具中的 `McpAuthTool` 实现。

#### src/tools/MCPTool

MCPTool：调用 MCP 服务器的工具。

- `classifyForCollapse.ts` — MCPTool 工具中的 `classifyForCollapse` 实现。
- `MCPTool.ts` — MCPTool 工具中的 `MCPTool` 实现。
- `prompt.ts` — MCPTool 工具中的 `prompt` 实现。
- `UI.tsx` — MCPTool 工具中的 `UI` 实现。

#### src/tools/NotebookEditTool

NotebookEditTool：编辑 Jupyter notebook 的工具。

- `constants.ts` — NotebookEditTool 工具中的 `constants` 实现。
- `NotebookEditTool.ts` — NotebookEditTool 工具中的 `NotebookEditTool` 实现。
- `prompt.ts` — NotebookEditTool 工具中的 `prompt` 实现。
- `UI.tsx` — NotebookEditTool 工具中的 `UI` 实现。

#### src/tools/PowerShellTool

PowerShellTool：执行 PowerShell 命令的工具。

- `clmTypes.ts` — PowerShellTool 工具的类型定义。
- `commandSemantics.ts` — PowerShellTool 工具中的 `commandSemantics` 实现。
- `commonParameters.ts` — PowerShellTool 工具中的 `commonParameters` 实现。
- `destructiveCommandWarning.ts` — PowerShellTool 工具中的 `destructiveCommandWarning` 实现。
- `gitSafety.ts` — PowerShellTool 工具中的 `gitSafety` 实现。
- `modeValidation.ts` — PowerShellTool 工具中的 `modeValidation` 实现。
- `pathValidation.ts` — PowerShellTool 工具中的 `pathValidation` 实现。
- `powershellPermissions.ts` — PowerShellTool 工具中的 `powershellPermissions` 实现。
- `powershellSecurity.ts` — PowerShellTool 工具中的 `powershellSecurity` 实现。
- `PowerShellTool.tsx` — PowerShellTool 工具中的 `PowerShellTool` 实现。
- `prompt.ts` — PowerShellTool 工具中的 `prompt` 实现。
- `readOnlyValidation.ts` — PowerShellTool 工具中的 `readOnlyValidation` 实现。
- `toolName.ts` — PowerShellTool 工具中的 `toolName` 实现。
- `UI.tsx` — PowerShellTool 工具中的 `UI` 实现。

#### src/tools/ReadMcpResourceTool

ReadMcpResourceTool：读取 MCP 资源的工具。

- `prompt.ts` — ReadMcpResourceTool 工具中的 `prompt` 实现。
- `ReadMcpResourceTool.ts` — ReadMcpResourceTool 工具中的 `ReadMcpResourceTool` 实现。
- `UI.tsx` — ReadMcpResourceTool 工具中的 `UI` 实现。

#### src/tools/RemoteTriggerTool

RemoteTriggerTool：远程触发工具。

- `prompt.ts` — RemoteTriggerTool 工具中的 `prompt` 实现。
- `RemoteTriggerTool.ts` — RemoteTriggerTool 工具中的 `RemoteTriggerTool` 实现。
- `UI.tsx` — RemoteTriggerTool 工具中的 `UI` 实现。

#### src/tools/REPLTool

REPLTool：交互式 REPL 工具。

- `constants.ts` — REPLTool 工具中的 `constants` 实现。
- `primitiveTools.ts` — REPLTool 工具中的 `primitiveTools` 实现。

#### src/tools/ScheduleCronTool

ScheduleCronTool：调度定时任务（cron）的工具。

- `CronCreateTool.ts` — ScheduleCronTool 工具中的 `CronCreateTool` 实现。
- `CronDeleteTool.ts` — ScheduleCronTool 工具中的 `CronDeleteTool` 实现。
- `CronListTool.ts` — ScheduleCronTool 工具中的 `CronListTool` 实现。
- `prompt.ts` — ScheduleCronTool 工具中的 `prompt` 实现。
- `UI.tsx` — ScheduleCronTool 工具中的 `UI` 实现。

#### src/tools/SendMessageTool

SendMessageTool：发送消息的工具。

- `constants.ts` — SendMessageTool 工具中的 `constants` 实现。
- `prompt.ts` — SendMessageTool 工具中的 `prompt` 实现。
- `SendMessageTool.ts` — SendMessageTool 工具中的 `SendMessageTool` 实现。
- `UI.tsx` — SendMessageTool 工具中的 `UI` 实现。

#### src/tools/shared

工具共享的辅助代码。

- `gitOperationTracking.ts` — shared 工具中的 `gitOperationTracking` 实现。
- `spawnMultiAgent.ts` — shared 工具中的 `spawnMultiAgent` 实现。

#### src/tools/SkillTool

SkillTool：调用技能的工具。

- `constants.ts` — SkillTool 工具中的 `constants` 实现。
- `prompt.ts` — SkillTool 工具中的 `prompt` 实现。
- `SkillTool.ts` — SkillTool 工具中的 `SkillTool` 实现。
- `UI.tsx` — SkillTool 工具中的 `UI` 实现。

#### src/tools/SleepTool

SleepTool：等待指定时长的工具。

- `prompt.ts` — SleepTool 工具中的 `prompt` 实现。

#### src/tools/SyntheticOutputTool

SyntheticOutputTool：生成合成输出的工具。

- `SyntheticOutputTool.ts` — SyntheticOutputTool 工具中的 `SyntheticOutputTool` 实现。

#### src/tools/TaskCreateTool

TaskCreateTool：创建任务的工具。

- `constants.ts` — TaskCreateTool 工具中的 `constants` 实现。
- `prompt.ts` — TaskCreateTool 工具中的 `prompt` 实现。
- `TaskCreateTool.ts` — TaskCreateTool 工具中的 `TaskCreateTool` 实现。

#### src/tools/TaskGetTool

TaskGetTool：获取任务的工具。

- `constants.ts` — TaskGetTool 工具中的 `constants` 实现。
- `prompt.ts` — TaskGetTool 工具中的 `prompt` 实现。
- `TaskGetTool.ts` — TaskGetTool 工具中的 `TaskGetTool` 实现。

#### src/tools/TaskListTool

TaskListTool：列出任务的工具。

- `constants.ts` — TaskListTool 工具中的 `constants` 实现。
- `prompt.ts` — TaskListTool 工具中的 `prompt` 实现。
- `TaskListTool.ts` — TaskListTool 工具中的 `TaskListTool` 实现。

#### src/tools/TaskOutputTool

TaskOutputTool：获取任务输出的工具。

- `constants.ts` — TaskOutputTool 工具中的 `constants` 实现。
- `TaskOutputTool.tsx` — TaskOutputTool 工具中的 `TaskOutputTool` 实现。

#### src/tools/TaskStopTool

TaskStopTool：停止任务的工具。

- `prompt.ts` — TaskStopTool 工具中的 `prompt` 实现。
- `TaskStopTool.ts` — TaskStopTool 工具中的 `TaskStopTool` 实现。
- `UI.tsx` — TaskStopTool 工具中的 `UI` 实现。

#### src/tools/TaskUpdateTool

TaskUpdateTool：更新任务的工具。

- `constants.ts` — TaskUpdateTool 工具中的 `constants` 实现。
- `prompt.ts` — TaskUpdateTool 工具中的 `prompt` 实现。
- `TaskUpdateTool.ts` — TaskUpdateTool 工具中的 `TaskUpdateTool` 实现。

#### src/tools/TeamCreateTool

TeamCreateTool：创建团队的工具。

- `constants.ts` — TeamCreateTool 工具中的 `constants` 实现。
- `prompt.ts` — TeamCreateTool 工具中的 `prompt` 实现。
- `TeamCreateTool.ts` — TeamCreateTool 工具中的 `TeamCreateTool` 实现。
- `UI.tsx` — TeamCreateTool 工具中的 `UI` 实现。

#### src/tools/TeamDeleteTool

TeamDeleteTool：删除团队的工具。

- `constants.ts` — TeamDeleteTool 工具中的 `constants` 实现。
- `prompt.ts` — TeamDeleteTool 工具中的 `prompt` 实现。
- `TeamDeleteTool.ts` — TeamDeleteTool 工具中的 `TeamDeleteTool` 实现。
- `UI.tsx` — TeamDeleteTool 工具中的 `UI` 实现。

#### src/tools/testing

工具测试辅助代码。

- `TestingPermissionTool.tsx` — testing 工具中的 `TestingPermissionTool` 实现。

#### src/tools/TodoWriteTool

TodoWriteTool：写待办事项的工具。

- `constants.ts` — TodoWriteTool 工具中的 `constants` 实现。
- `prompt.ts` — TodoWriteTool 工具中的 `prompt` 实现。
- `TodoWriteTool.ts` — TodoWriteTool 工具中的 `TodoWriteTool` 实现。

#### src/tools/ToolSearchTool

ToolSearchTool：搜索可用工具的工具。

- `constants.ts` — ToolSearchTool 工具中的 `constants` 实现。
- `prompt.ts` — ToolSearchTool 工具中的 `prompt` 实现。
- `ToolSearchTool.ts` — ToolSearchTool 工具中的 `ToolSearchTool` 实现。

#### src/tools/WebFetchTool

WebFetchTool：抓取网页内容的工具。

- `preapproved.ts` — WebFetchTool 工具中的 `preapproved` 实现。
- `prompt.ts` — WebFetchTool 工具中的 `prompt` 实现。
- `UI.tsx` — WebFetchTool 工具中的 `UI` 实现。
- `utils.ts` — WebFetchTool 工具的辅助函数。
- `WebFetchTool.ts` — WebFetchTool 工具中的 `WebFetchTool` 实现。

#### src/tools/WebSearchTool

WebSearchTool：网络搜索的工具。

- `prompt.ts` — WebSearchTool 工具中的 `prompt` 实现。
- `UI.tsx` — WebSearchTool 工具中的 `UI` 实现。
- `WebSearchTool.ts` — WebSearchTool 工具中的 `WebSearchTool` 实现。

### src/types

类型定义：生成的事件 / Protobuf 类型等。

- `command.ts` — 命令类型定义。
- `hooks.ts` — hooks 类型定义。
- `ids.ts` — ID 类型定义。
- `logs.ts` — 日志类型定义。
- `permissions.ts` — 权限类型定义。
- `plugin.ts` — 插件类型定义。
- `textInputTypes.ts` — 文本输入类型定义。

#### src/types/generated

生成类型（events_mono / google protobuf）。

##### src/types/generated/events_mono

生成的 events_mono 类型。

###### src/types/generated/events_mono/claude_code

Claude Code 事件类型。

###### src/types/generated/events_mono/claude_code/v1

Claude Code 事件类型 v1。

- `claude_code_internal_event.ts` — 生成的 Claude Code 内部事件类型（Protobuf/事件）。

###### src/types/generated/events_mono/common

公共事件类型。

###### src/types/generated/events_mono/common/v1

公共事件类型 v1。

- `auth.ts` — 生成的公共 auth 事件类型。

###### src/types/generated/events_mono/growthbook

GrowthBook 事件类型。

###### src/types/generated/events_mono/growthbook/v1

GrowthBook 事件类型 v1。

- `growthbook_experiment_event.ts` — 生成的 GrowthBook 实验事件类型。

##### src/types/generated/google

Google 类型。

###### src/types/generated/google/protobuf

Google Protobuf 类型。

- `timestamp.ts` — 生成的 Google Protobuf timestamp 类型。

### src/upstreamproxy

上游代理相关实现。

- `relay.ts` — relay 上游代理相关实现。
- `upstreamproxy.ts` — upstreamproxy 上游代理相关实现。

### src/utils

通用工具函数：模型、权限、shell/bash 解析、插件、设置、遥测、secure storage、swarm、teleport 等。

- `abortController.ts` — abortController 相关工具函数。
- `activityManager.ts` — activityManager 相关工具函数。
- `advisor.ts` — advisor 相关工具函数。
- `agentContext.ts` — agentContext 相关工具函数。
- `agenticSessionSearch.ts` — agenticSessionSearch 相关工具函数。
- `agentId.ts` — agentId 相关工具函数。
- `agentSwarmsEnabled.ts` — agentSwarmsEnabled 相关工具函数。
- `analyzeContext.ts` — analyzeContext 相关工具函数。
- `ansiToPng.ts` — ansiToPng 相关工具函数。
- `ansiToSvg.ts` — ansiToSvg 相关工具函数。
- `api.ts` — api 相关工具函数。
- `apiPreconnect.ts` — apiPreconnect 相关工具函数。
- `appleTerminalBackup.ts` — appleTerminalBackup 相关工具函数。
- `argumentSubstitution.ts` — argumentSubstitution 相关工具函数。
- `array.ts` — array 相关工具函数。
- `asciicast.ts` — asciicast 相关工具函数。
- `attachments.ts` — attachments 相关工具函数。
- `attribution.ts` — attribution 相关工具函数。
- `auth.ts` — auth 相关工具函数。
- `authFileDescriptor.ts` — authFileDescriptor 相关工具函数。
- `authPortable.ts` — authPortable 相关工具函数。
- `autoModeDenials.ts` — autoModeDenials 相关工具函数。
- `autoRunIssue.tsx` — autoRunIssue 相关工具函数。
- `autoUpdater.ts` — autoUpdater 相关工具函数。
- `aws.ts` — aws 相关工具函数。
- `awsAuthStatusManager.ts` — awsAuthStatusManager 相关工具函数。
- `backgroundHousekeeping.ts` — backgroundHousekeeping 相关工具函数。
- `betas.ts` — betas 相关工具函数。
- `billing.ts` — billing 相关工具函数。
- `binaryCheck.ts` — binaryCheck 相关工具函数。
- `browser.ts` — browser 相关工具函数。
- `bufferedWriter.ts` — bufferedWriter 相关工具函数。
- `bundledMode.ts` — bundledMode 相关工具函数。
- `caCerts.ts` — caCerts 相关工具函数。
- `caCertsConfig.ts` — caCertsConfig 相关工具函数。
- `cachePaths.ts` — cachePaths 相关工具函数。
- `CircularBuffer.ts` — CircularBuffer 相关工具函数。
- `classifierApprovals.ts` — classifierApprovals 相关工具函数。
- `classifierApprovalsHook.ts` — classifierApprovalsHook 相关工具函数。
- `claudeCodeHints.ts` — claudeCodeHints 相关工具函数。
- `claudeDesktop.ts` — claudeDesktop 相关工具函数。
- `claudemd.ts` — claudemd 相关工具函数。
- `cleanup.ts` — cleanup 相关工具函数。
- `cleanupRegistry.ts` — cleanupRegistry 相关工具函数。
- `cliArgs.ts` — cliArgs 相关工具函数。
- `cliHighlight.ts` — cliHighlight 相关工具函数。
- `codeIndexing.ts` — codeIndexing 相关工具函数。
- `collapseBackgroundBashNotifications.ts` — collapseBackgroundBashNotifications 相关工具函数。
- `collapseHookSummaries.ts` — collapseHookSummaries 相关工具函数。
- `collapseReadSearch.ts` — collapseReadSearch 相关工具函数。
- `collapseTeammateShutdowns.ts` — collapseTeammateShutdowns 相关工具函数。
- `combinedAbortSignal.ts` — combinedAbortSignal 相关工具函数。
- `commandLifecycle.ts` — commandLifecycle 相关工具函数。
- `commitAttribution.ts` — commitAttribution 相关工具函数。
- `completionCache.ts` — completionCache 相关工具函数。
- `concurrentSessions.ts` — concurrentSessions 相关工具函数。
- `config.ts` — config 相关工具函数。
- `configConstants.ts` — configConstants 相关工具函数。
- `contentArray.ts` — contentArray 相关工具函数。
- `context.ts` — context 相关工具函数。
- `contextAnalysis.ts` — contextAnalysis 相关工具函数。
- `contextSuggestions.ts` — contextSuggestions 相关工具函数。
- `controlMessageCompat.ts` — controlMessageCompat 相关工具函数。
- `conversationRecovery.ts` — conversationRecovery 相关工具函数。
- `cron.ts` — cron 相关工具函数。
- `cronJitterConfig.ts` — cronJitterConfig 相关工具函数。
- `cronScheduler.ts` — cronScheduler 相关工具函数。
- `cronTasks.ts` — cronTasks 相关工具函数。
- `cronTasksLock.ts` — cronTasksLock 相关工具函数。
- `crossProjectResume.ts` — crossProjectResume 相关工具函数。
- `crypto.ts` — crypto 相关工具函数。
- `Cursor.ts` — Cursor 相关工具函数。
- `cwd.ts` — cwd 相关工具函数。
- `debug.ts` — debug 相关工具函数。
- `debugFilter.ts` — debugFilter 相关工具函数。
- `desktopDeepLink.ts` — desktopDeepLink 相关工具函数。
- `detectRepository.ts` — detectRepository 相关工具函数。
- `diagLogs.ts` — diagLogs 相关工具函数。
- `diff.ts` — diff 相关工具函数。
- `directMemberMessage.ts` — directMemberMessage 相关工具函数。
- `displayTags.ts` — displayTags 相关工具函数。
- `doctorContextWarnings.ts` — doctorContextWarnings 相关工具函数。
- `doctorDiagnostic.ts` — doctorDiagnostic 相关工具函数。
- `earlyInput.ts` — earlyInput 相关工具函数。
- `editor.ts` — editor 相关工具函数。
- `effort.ts` — effort 相关工具函数。
- `embeddedTools.ts` — embeddedTools 相关工具函数。
- `env.ts` — env 相关工具函数。
- `envDynamic.ts` — envDynamic 相关工具函数。
- `envUtils.ts` — envUtils 相关工具函数。
- `envValidation.ts` — envValidation 相关工具函数。
- `errorLogSink.ts` — errorLogSink 相关工具函数。
- `errors.ts` — errors 相关工具函数。
- `exampleCommands.ts` — exampleCommands 相关工具函数。
- `execFileNoThrow.ts` — execFileNoThrow 相关工具函数。
- `execFileNoThrowPortable.ts` — execFileNoThrowPortable 相关工具函数。
- `execSyncWrapper.ts` — execSyncWrapper 相关工具函数。
- `exportRenderer.tsx` — exportRenderer 相关工具函数。
- `extraUsage.ts` — extraUsage 相关工具函数。
- `fastMode.ts` — fastMode 相关工具函数。
- `file.ts` — file 相关工具函数。
- `fileHistory.ts` — fileHistory 相关工具函数。
- `fileOperationAnalytics.ts` — fileOperationAnalytics 相关工具函数。
- `fileRead.ts` — fileRead 相关工具函数。
- `fileReadCache.ts` — fileReadCache 相关工具函数。
- `fileStateCache.ts` — fileStateCache 相关工具函数。
- `findExecutable.ts` — findExecutable 相关工具函数。
- `fingerprint.ts` — fingerprint 相关工具函数。
- `forkedAgent.ts` — forkedAgent 相关工具函数。
- `format.ts` — format 相关工具函数。
- `formatBriefTimestamp.ts` — formatBriefTimestamp 相关工具函数。
- `fpsTracker.ts` — fpsTracker 相关工具函数。
- `frontmatterParser.ts` — frontmatterParser 相关工具函数。
- `fsOperations.ts` — fsOperations 相关工具函数。
- `fullscreen.ts` — fullscreen 相关工具函数。
- `generatedFiles.ts` — generatedFiles 相关工具函数。
- `generators.ts` — generators 相关工具函数。
- `genericProcessUtils.ts` — genericProcessUtils 相关工具函数。
- `getWorktreePaths.ts` — getWorktreePaths 相关工具函数。
- `getWorktreePathsPortable.ts` — getWorktreePathsPortable 相关工具函数。
- `ghPrStatus.ts` — ghPrStatus 相关工具函数。
- `git.ts` — git 相关工具函数。
- `gitDiff.ts` — gitDiff 相关工具函数。
- `githubRepoPathMapping.ts` — githubRepoPathMapping 相关工具函数。
- `gitSettings.ts` — gitSettings 相关工具函数。
- `glob.ts` — glob 相关工具函数。
- `gracefulShutdown.ts` — gracefulShutdown 相关工具函数。
- `groupToolUses.ts` — groupToolUses 相关工具函数。
- `handlePromptSubmit.ts` — handlePromptSubmit 相关工具函数。
- `hash.ts` — hash 相关工具函数。
- `headlessProfiler.ts` — headlessProfiler 相关工具函数。
- `heapDumpService.ts` — heapDumpService 相关工具函数。
- `heatmap.ts` — heatmap 相关工具函数。
- `highlightMatch.tsx` — highlightMatch 相关工具函数。
- `hooks.ts` — hooks 相关工具函数。
- `horizontalScroll.ts` — horizontalScroll 相关工具函数。
- `http.ts` — http 相关工具函数。
- `hyperlink.ts` — hyperlink 相关工具函数。
- `ide.ts` — ide 相关工具函数。
- `idePathConversion.ts` — idePathConversion 相关工具函数。
- `idleTimeout.ts` — idleTimeout 相关工具函数。
- `imagePaste.ts` — imagePaste 相关工具函数。
- `imageResizer.ts` — imageResizer 相关工具函数。
- `imageStore.ts` — imageStore 相关工具函数。
- `imageValidation.ts` — imageValidation 相关工具函数。
- `immediateCommand.ts` — immediateCommand 相关工具函数。
- `ink.ts` — ink 相关工具函数。
- `inProcessTeammateHelpers.ts` — inProcessTeammateHelpers 相关工具函数。
- `intl.ts` — intl 相关工具函数。
- `iTermBackup.ts` — iTermBackup 相关工具函数。
- `jetbrains.ts` — jetbrains 相关工具函数。
- `json.ts` — json 相关工具函数。
- `jsonRead.ts` — jsonRead 相关工具函数。
- `keyboardShortcuts.ts` — keyboardShortcuts 相关工具函数。
- `lazySchema.ts` — lazySchema 相关工具函数。
- `listSessionsImpl.ts` — listSessionsImpl 相关工具函数。
- `localInstaller.ts` — localInstaller 相关工具函数。
- `lockfile.ts` — lockfile 相关工具函数。
- `log.ts` — log 相关工具函数。
- `logoV2Utils.ts` — logoV2Utils 相关工具函数。
- `mailbox.ts` — mailbox 相关工具函数。
- `managedEnv.ts` — managedEnv 相关工具函数。
- `managedEnvConstants.ts` — managedEnvConstants 相关工具函数。
- `markdown.ts` — markdown 相关工具函数。
- `markdownConfigLoader.ts` — markdownConfigLoader 相关工具函数。
- `mcpInstructionsDelta.ts` — mcpInstructionsDelta 相关工具函数。
- `mcpOutputStorage.ts` — mcpOutputStorage 相关工具函数。
- `mcpValidation.ts` — mcpValidation 相关工具函数。
- `mcpWebSocketTransport.ts` — mcpWebSocketTransport 相关工具函数。
- `memoize.ts` — memoize 相关工具函数。
- `memoryFileDetection.ts` — memoryFileDetection 相关工具函数。
- `messagePredicates.ts` — messagePredicates 相关工具函数。
- `messageQueueManager.ts` — messageQueueManager 相关工具函数。
- `messages.ts` — messages 相关工具函数。
- `modelCost.ts` — modelCost 相关工具函数。
- `modifiers.ts` — modifiers 相关工具函数。
- `mtls.ts` — mtls 相关工具函数。
- `notebook.ts` — notebook 相关工具函数。
- `objectGroupBy.ts` — objectGroupBy 相关工具函数。
- `pasteStore.ts` — pasteStore 相关工具函数。
- `path.ts` — path 相关工具函数。
- `pdf.ts` — pdf 相关工具函数。
- `pdfUtils.ts` — pdfUtils 相关工具函数。
- `peerAddress.ts` — peerAddress 相关工具函数。
- `planModeV2.ts` — planModeV2 相关工具函数。
- `plans.ts` — plans 相关工具函数。
- `platform.ts` — platform 相关工具函数。
- `preflightChecks.tsx` — preflightChecks 相关工具函数。
- `privacyLevel.ts` — privacyLevel 相关工具函数。
- `process.ts` — process 相关工具函数。
- `profilerBase.ts` — profilerBase 相关工具函数。
- `promptCategory.ts` — promptCategory 相关工具函数。
- `promptEditor.ts` — promptEditor 相关工具函数。
- `promptShellExecution.ts` — promptShellExecution 相关工具函数。
- `proxy.ts` — proxy 相关工具函数。
- `queryContext.ts` — queryContext 相关工具函数。
- `QueryGuard.ts` — QueryGuard 相关工具函数。
- `queryHelpers.ts` — queryHelpers 相关工具函数。
- `queryProfiler.ts` — queryProfiler 相关工具函数。
- `queueProcessor.ts` — queueProcessor 相关工具函数。
- `readEditContext.ts` — readEditContext 相关工具函数。
- `readFileInRange.ts` — readFileInRange 相关工具函数。
- `releaseNotes.ts` — releaseNotes 相关工具函数。
- `renderOptions.ts` — renderOptions 相关工具函数。
- `ripgrep.ts` — ripgrep 相关工具函数。
- `sanitization.ts` — sanitization 相关工具函数。
- `screenshotClipboard.ts` — screenshotClipboard 相关工具函数。
- `sdkEventQueue.ts` — sdkEventQueue 相关工具函数。
- `semanticBoolean.ts` — semanticBoolean 相关工具函数。
- `semanticNumber.ts` — semanticNumber 相关工具函数。
- `semver.ts` — semver 相关工具函数。
- `sequential.ts` — sequential 相关工具函数。
- `sessionActivity.ts` — sessionActivity 相关工具函数。
- `sessionEnvironment.ts` — sessionEnvironment 相关工具函数。
- `sessionEnvVars.ts` — sessionEnvVars 相关工具函数。
- `sessionFileAccessHooks.ts` — sessionFileAccessHooks 相关工具函数。
- `sessionIngressAuth.ts` — sessionIngressAuth 相关工具函数。
- `sessionRestore.ts` — sessionRestore 相关工具函数。
- `sessionStart.ts` — sessionStart 相关工具函数。
- `sessionState.ts` — sessionState 相关工具函数。
- `sessionStorage.ts` — sessionStorage 相关工具函数。
- `sessionStoragePortable.ts` — sessionStoragePortable 相关工具函数。
- `sessionTitle.ts` — sessionTitle 相关工具函数。
- `sessionUrl.ts` — sessionUrl 相关工具函数。
- `set.ts` — set 相关工具函数。
- `Shell.ts` — Shell 相关工具函数。
- `ShellCommand.ts` — ShellCommand 相关工具函数。
- `shellConfig.ts` — shellConfig 相关工具函数。
- `sideQuery.ts` — sideQuery 相关工具函数。
- `sideQuestion.ts` — sideQuestion 相关工具函数。
- `signal.ts` — signal 相关工具函数。
- `sinks.ts` — sinks 相关工具函数。
- `slashCommandParsing.ts` — slashCommandParsing 相关工具函数。
- `sleep.ts` — sleep 相关工具函数。
- `sliceAnsi.ts` — sliceAnsi 相关工具函数。
- `slowOperations.ts` — slowOperations 相关工具函数。
- `standaloneAgent.ts` — standaloneAgent 相关工具函数。
- `startupProfiler.ts` — startupProfiler 相关工具函数。
- `staticRender.tsx` — staticRender 相关工具函数。
- `stats.ts` — stats 相关工具函数。
- `statsCache.ts` — statsCache 相关工具函数。
- `status.tsx` — status 相关工具函数。
- `statusNoticeDefinitions.tsx` — statusNoticeDefinitions 相关工具函数。
- `statusNoticeHelpers.ts` — statusNoticeHelpers 相关工具函数。
- `stream.ts` — stream 相关工具函数。
- `streamJsonStdoutGuard.ts` — streamJsonStdoutGuard 相关工具函数。
- `streamlinedTransform.ts` — streamlinedTransform 相关工具函数。
- `stringUtils.ts` — stringUtils 相关工具函数。
- `subprocessEnv.ts` — subprocessEnv 相关工具函数。
- `systemDirectories.ts` — systemDirectories 相关工具函数。
- `systemPrompt.ts` — systemPrompt 相关工具函数。
- `systemPromptType.ts` — systemPromptType 相关工具函数。
- `systemTheme.ts` — systemTheme 相关工具函数。
- `taggedId.ts` — taggedId 相关工具函数。
- `tasks.ts` — tasks 相关工具函数。
- `teamDiscovery.ts` — teamDiscovery 相关工具函数。
- `teammate.ts` — teammate 相关工具函数。
- `teammateContext.ts` — teammateContext 相关工具函数。
- `teammateMailbox.ts` — teammateMailbox 相关工具函数。
- `teamMemoryOps.ts` — teamMemoryOps 相关工具函数。
- `telemetryAttributes.ts` — telemetryAttributes 相关工具函数。
- `teleport.tsx` — teleport 相关工具函数。
- `tempfile.ts` — tempfile 相关工具函数。
- `terminal.ts` — terminal 相关工具函数。
- `terminalPanel.ts` — terminalPanel 相关工具函数。
- `textHighlighting.ts` — textHighlighting 相关工具函数。
- `theme.ts` — theme 相关工具函数。
- `thinking.ts` — thinking 相关工具函数。
- `timeouts.ts` — timeouts 相关工具函数。
- `tmuxSocket.ts` — tmuxSocket 相关工具函数。
- `tokenBudget.ts` — tokenBudget 相关工具函数。
- `tokens.ts` — tokens 相关工具函数。
- `toolErrors.ts` — toolErrors 相关工具函数。
- `toolPool.ts` — toolPool 相关工具函数。
- `toolResultStorage.ts` — toolResultStorage 相关工具函数。
- `toolSchemaCache.ts` — toolSchemaCache 相关工具函数。
- `toolSearch.ts` — toolSearch 相关工具函数。
- `transcriptSearch.ts` — transcriptSearch 相关工具函数。
- `treeify.ts` — treeify 相关工具函数。
- `truncate.ts` — truncate 相关工具函数。
- `unaryLogging.ts` — unaryLogging 相关工具函数。
- `undercover.ts` — undercover 相关工具函数。
- `user.ts` — user 相关工具函数。
- `userAgent.ts` — userAgent 相关工具函数。
- `userPromptKeywords.ts` — userPromptKeywords 相关工具函数。
- `uuid.ts` — uuid 相关工具函数。
- `warningHandler.ts` — warningHandler 相关工具函数。
- `which.ts` — which 相关工具函数。
- `windowsPaths.ts` — windowsPaths 相关工具函数。
- `withResolvers.ts` — withResolvers 相关工具函数。
- `words.ts` — words 相关工具函数。
- `workloadContext.ts` — workloadContext 相关工具函数。
- `worktree.ts` — worktree 相关工具函数。
- `worktreeModeEnabled.ts` — worktreeModeEnabled 相关工具函数。
- `xdg.ts` — xdg 相关工具函数。
- `xml.ts` — xml 相关工具函数。
- `yaml.ts` — yaml 相关工具函数。
- `zodToJsonSchema.ts` — zodToJsonSchema 相关工具函数。

#### src/utils/background

后台（background）任务相关工具。

##### src/utils/background/remote

后台远程会话相关工具。

- `preconditions.ts` — preconditions 相关工具函数。
- `remoteSession.ts` — remoteSession 相关工具函数。

#### src/utils/bash

Bash 解析与命令分析工具。

- `ast.ts` — ast 相关工具函数。
- `bashParser.ts` — bashParser 相关工具函数。
- `bashPipeCommand.ts` — bashPipeCommand 相关工具函数。
- `commands.ts` — commands 相关工具函数。
- `heredoc.ts` — heredoc 相关工具函数。
- `ParsedCommand.ts` — ParsedCommand 相关工具函数。
- `parser.ts` — parser 相关工具函数。
- `prefix.ts` — prefix 相关工具函数。
- `registry.ts` — registry 相关工具函数。
- `shellCompletion.ts` — shellCompletion 相关工具函数。
- `shellPrefix.ts` — shellPrefix 相关工具函数。
- `shellQuote.ts` — shellQuote 相关工具函数。
- `shellQuoting.ts` — shellQuoting 相关工具函数。
- `ShellSnapshot.ts` — ShellSnapshot 相关工具函数。
- `treeSitterAnalysis.ts` — treeSitterAnalysis 相关工具函数。

##### src/utils/bash/specs

Bash 命令 spec（alias/nohup/pyright/sleep/srun/time/timeout）。

- `alias.ts` — alias 相关工具函数。
- `index.ts` — index 相关工具函数。
- `nohup.ts` — nohup 相关工具函数。
- `pyright.ts` — pyright 相关工具函数。
- `sleep.ts` — sleep 相关工具函数。
- `srun.ts` — srun 相关工具函数。
- `time.ts` — time 相关工具函数。
- `timeout.ts` — timeout 相关工具函数。

#### src/utils/claudeInChrome

Claude in Chrome 相关工具。

- `chromeNativeHost.ts` — chromeNativeHost 相关工具函数。
- `common.ts` — common 相关工具函数。
- `mcpServer.ts` — mcpServer 相关工具函数。
- `prompt.ts` — prompt 相关工具函数。
- `setup.ts` — setup 相关工具函数。
- `setupPortable.ts` — setupPortable 相关工具函数。
- `toolRendering.tsx` — toolRendering 相关工具函数。

#### src/utils/computerUse

计算机使用（Computer Use）相关工具。

- `appNames.ts` — appNames 相关工具函数。
- `cleanup.ts` — cleanup 相关工具函数。
- `common.ts` — common 相关工具函数。
- `computerUseLock.ts` — computerUseLock 相关工具函数。
- `drainRunLoop.ts` — drainRunLoop 相关工具函数。
- `escHotkey.ts` — escHotkey 相关工具函数。
- `executor.ts` — executor 相关工具函数。
- `gates.ts` — gates 相关工具函数。
- `hostAdapter.ts` — hostAdapter 相关工具函数。
- `inputLoader.ts` — inputLoader 相关工具函数。
- `mcpServer.ts` — mcpServer 相关工具函数。
- `setup.ts` — setup 相关工具函数。
- `swiftLoader.ts` — swiftLoader 相关工具函数。
- `toolRendering.tsx` — toolRendering 相关工具函数。
- `wrapper.tsx` — wrapper 相关工具函数。

#### src/utils/deepLink

深链（deep link）协议处理工具。

- `banner.ts` — banner 相关工具函数。
- `parseDeepLink.ts` — parseDeepLink 相关工具函数。
- `protocolHandler.ts` — protocolHandler 相关工具函数。
- `registerProtocol.ts` — registerProtocol 相关工具函数。
- `terminalLauncher.ts` — terminalLauncher 相关工具函数。
- `terminalPreference.ts` — terminalPreference 相关工具函数。

#### src/utils/dxt

dxt 相关工具（压缩/zip）。

- `helpers.ts` — helpers 相关工具函数。
- `zip.ts` — zip 相关工具函数。

#### src/utils/filePersistence

文件持久化与输出扫描工具。

- `filePersistence.ts` — filePersistence 相关工具函数。
- `outputsScanner.ts` — outputsScanner 相关工具函数。

#### src/utils/git

git 相关工具（config/文件系统/ignore）。

- `gitConfigParser.ts` — gitConfigParser 相关工具函数。
- `gitFilesystem.ts` — gitFilesystem 相关工具函数。
- `gitignore.ts` — gitignore 相关工具函数。

#### src/utils/github

GitHub 相关工具（gh auth status）。

- `ghAuthStatus.ts` — ghAuthStatus 相关工具函数。

#### src/utils/hooks

hooks 相关工具。

- `apiQueryHookHelper.ts` — apiQueryHookHelper 相关工具函数。
- `AsyncHookRegistry.ts` — AsyncHookRegistry 相关工具函数。
- `execAgentHook.ts` — execAgentHook 相关工具函数。
- `execHttpHook.ts` — execHttpHook 相关工具函数。
- `execPromptHook.ts` — execPromptHook 相关工具函数。
- `fileChangedWatcher.ts` — fileChangedWatcher 相关工具函数。
- `hookEvents.ts` — hookEvents 相关工具函数。
- `hookHelpers.ts` — hookHelpers 相关工具函数。
- `hooksConfigManager.ts` — hooksConfigManager 相关工具函数。
- `hooksConfigSnapshot.ts` — hooksConfigSnapshot 相关工具函数。
- `hooksSettings.ts` — hooksSettings 相关工具函数。
- `postSamplingHooks.ts` — postSamplingHooks 相关工具函数。
- `registerFrontmatterHooks.ts` — registerFrontmatterHooks 相关工具函数。
- `registerSkillHooks.ts` — registerSkillHooks 相关工具函数。
- `sessionHooks.ts` — sessionHooks 相关工具函数。
- `skillImprovement.ts` — skillImprovement 相关工具函数。
- `ssrfGuard.ts` — ssrfGuard 相关工具函数。

#### src/utils/mcp

MCP 相关工具。

- `dateTimeParser.ts` — dateTimeParser 相关工具函数。
- `elicitationValidation.ts` — elicitationValidation 相关工具函数。

#### src/utils/memory

记忆相关工具。

- `types.ts` — types 相关工具函数。
- `versions.ts` — versions 相关工具函数。

#### src/utils/messages

消息映射与系统提示工具。

- `mappers.ts` — mappers 相关工具函数。
- `systemInit.ts` — systemInit 相关工具函数。

#### src/utils/model

模型相关工具（别名、能力、配置、校验等）。

- `agent.ts` — agent 相关工具函数。
- `aliases.ts` — aliases 相关工具函数。
- `antModels.ts` — antModels 相关工具函数。
- `bedrock.ts` — bedrock 相关工具函数。
- `check1mAccess.ts` — check1mAccess 相关工具函数。
- `configs.ts` — configs 相关工具函数。
- `contextWindowUpgradeCheck.ts` — contextWindowUpgradeCheck 相关工具函数。
- `deprecation.ts` — deprecation 相关工具函数。
- `model.ts` — model 相关工具函数。
- `modelAllowlist.ts` — modelAllowlist 相关工具函数。
- `modelCapabilities.ts` — modelCapabilities 相关工具函数。
- `modelOptions.ts` — modelOptions 相关工具函数。
- `modelStrings.ts` — modelStrings 相关工具函数。
- `modelSupportOverrides.ts` — modelSupportOverrides 相关工具函数。
- `providers.ts` — providers 相关工具函数。
- `validateModel.ts` — validateModel 相关工具函数。

#### src/utils/nativeInstaller

原生依赖安装器。

- `download.ts` — download 相关工具函数。
- `index.ts` — index 相关工具函数。
- `installer.ts` — installer 相关工具函数。
- `packageManagers.ts` — packageManagers 相关工具函数。
- `pidLock.ts` — pidLock 相关工具函数。

#### src/utils/permissions

权限相关工具（分类器、规则、文件系统权限等）。

- `autoModeState.ts` — autoModeState 相关工具函数。
- `bashClassifier.ts` — bashClassifier 相关工具函数。
- `bypassPermissionsKillswitch.ts` — bypassPermissionsKillswitch 相关工具函数。
- `classifierDecision.ts` — classifierDecision 相关工具函数。
- `classifierShared.ts` — classifierShared 相关工具函数。
- `dangerousPatterns.ts` — dangerousPatterns 相关工具函数。
- `denialTracking.ts` — denialTracking 相关工具函数。
- `filesystem.ts` — filesystem 相关工具函数。
- `getNextPermissionMode.ts` — getNextPermissionMode 相关工具函数。
- `pathValidation.ts` — pathValidation 相关工具函数。
- `permissionExplainer.ts` — permissionExplainer 相关工具函数。
- `PermissionMode.ts` — PermissionMode 相关工具函数。
- `PermissionPromptToolResultSchema.ts` — PermissionPromptToolResultSchema 相关工具函数。
- `PermissionResult.ts` — PermissionResult 相关工具函数。
- `PermissionRule.ts` — PermissionRule 相关工具函数。
- `permissionRuleParser.ts` — permissionRuleParser 相关工具函数。
- `permissions.ts` — permissions 相关工具函数。
- `permissionSetup.ts` — permissionSetup 相关工具函数。
- `permissionsLoader.ts` — permissionsLoader 相关工具函数。
- `PermissionUpdate.ts` — PermissionUpdate 相关工具函数。
- `PermissionUpdateSchema.ts` — PermissionUpdateSchema 相关工具函数。
- `shadowedRuleDetection.ts` — shadowedRuleDetection 相关工具函数。
- `shellRuleMatching.ts` — shellRuleMatching 相关工具函数。
- `yoloClassifier.ts` — yoloClassifier 相关工具函数。

#### src/utils/plugins

插件相关工具（市场、安装、校验、加载等）。

- `addDirPluginSettings.ts` — addDirPluginSettings 相关工具函数。
- `cacheUtils.ts` — cacheUtils 相关工具函数。
- `dependencyResolver.ts` — dependencyResolver 相关工具函数。
- `fetchTelemetry.ts` — fetchTelemetry 相关工具函数。
- `gitAvailability.ts` — gitAvailability 相关工具函数。
- `headlessPluginInstall.ts` — headlessPluginInstall 相关工具函数。
- `hintRecommendation.ts` — hintRecommendation 相关工具函数。
- `installCounts.ts` — installCounts 相关工具函数。
- `installedPluginsManager.ts` — installedPluginsManager 相关工具函数。
- `loadPluginAgents.ts` — loadPluginAgents 相关工具函数。
- `loadPluginCommands.ts` — loadPluginCommands 相关工具函数。
- `loadPluginHooks.ts` — loadPluginHooks 相关工具函数。
- `loadPluginOutputStyles.ts` — loadPluginOutputStyles 相关工具函数。
- `lspPluginIntegration.ts` — lspPluginIntegration 相关工具函数。
- `lspRecommendation.ts` — lspRecommendation 相关工具函数。
- `managedPlugins.ts` — managedPlugins 相关工具函数。
- `marketplaceHelpers.ts` — marketplaceHelpers 相关工具函数。
- `marketplaceManager.ts` — marketplaceManager 相关工具函数。
- `mcpbHandler.ts` — mcpbHandler 相关工具函数。
- `mcpPluginIntegration.ts` — mcpPluginIntegration 相关工具函数。
- `officialMarketplace.ts` — officialMarketplace 相关工具函数。
- `officialMarketplaceGcs.ts` — officialMarketplaceGcs 相关工具函数。
- `officialMarketplaceStartupCheck.ts` — officialMarketplaceStartupCheck 相关工具函数。
- `orphanedPluginFilter.ts` — orphanedPluginFilter 相关工具函数。
- `parseMarketplaceInput.ts` — parseMarketplaceInput 相关工具函数。
- `performStartupChecks.tsx` — performStartupChecks 相关工具函数。
- `pluginAutoupdate.ts` — pluginAutoupdate 相关工具函数。
- `pluginBlocklist.ts` — pluginBlocklist 相关工具函数。
- `pluginDirectories.ts` — pluginDirectories 相关工具函数。
- `pluginFlagging.ts` — pluginFlagging 相关工具函数。
- `pluginIdentifier.ts` — pluginIdentifier 相关工具函数。
- `pluginInstallationHelpers.ts` — pluginInstallationHelpers 相关工具函数。
- `pluginLoader.ts` — pluginLoader 相关工具函数。
- `pluginOptionsStorage.ts` — pluginOptionsStorage 相关工具函数。
- `pluginPolicy.ts` — pluginPolicy 相关工具函数。
- `pluginStartupCheck.ts` — pluginStartupCheck 相关工具函数。
- `pluginVersioning.ts` — pluginVersioning 相关工具函数。
- `reconciler.ts` — reconciler 相关工具函数。
- `refresh.ts` — refresh 相关工具函数。
- `schemas.ts` — schemas 相关工具函数。
- `validatePlugin.ts` — validatePlugin 相关工具函数。
- `walkPluginMarkdown.ts` — walkPluginMarkdown 相关工具函数。
- `zipCache.ts` — zipCache 相关工具函数。
- `zipCacheAdapters.ts` — zipCacheAdapters 相关工具函数。

#### src/utils/powershell

PowerShell 解析工具。

- `dangerousCmdlets.ts` — dangerousCmdlets 相关工具函数。
- `parser.ts` — parser 相关工具函数。
- `staticPrefix.ts` — staticPrefix 相关工具函数。

#### src/utils/processUserInput

用户输入处理（bash/斜杠/文本/整体分发）。

- `processBashCommand.tsx` — processBashCommand 相关工具函数。
- `processSlashCommand.tsx` — processSlashCommand 相关工具函数。
- `processTextPrompt.ts` — processTextPrompt 相关工具函数。
- `processUserInput.ts` — processUserInput 相关工具函数。

#### src/utils/sandbox

沙箱适配工具。

- `sandbox-adapter.ts` — sandbox-adapter 相关工具函数。
- `sandbox-ui-utils.ts` — sandbox-ui-utils 相关工具函数。

#### src/utils/secureStorage

安全存储（keychain/明文回退）。

- `fallbackStorage.ts` — fallbackStorage 相关工具函数。
- `index.ts` — index 相关工具函数。
- `keychainPrefetch.ts` — keychainPrefetch 相关工具函数。
- `macOsKeychainHelpers.ts` — macOsKeychainHelpers 相关工具函数。
- `macOsKeychainStorage.ts` — macOsKeychainStorage 相关工具函数。
- `plainTextStorage.ts` — plainTextStorage 相关工具函数。

#### src/utils/settings

设置相关工具（校验、变更、MDM 等）。

- `allErrors.ts` — allErrors 相关工具函数。
- `applySettingsChange.ts` — applySettingsChange 相关工具函数。
- `changeDetector.ts` — changeDetector 相关工具函数。
- `constants.ts` — constants 相关工具函数。
- `internalWrites.ts` — internalWrites 相关工具函数。
- `managedPath.ts` — managedPath 相关工具函数。
- `permissionValidation.ts` — permissionValidation 相关工具函数。
- `pluginOnlyPolicy.ts` — pluginOnlyPolicy 相关工具函数。
- `schemaOutput.ts` — schemaOutput 相关工具函数。
- `settings.ts` — settings 相关工具函数。
- `settingsCache.ts` — settingsCache 相关工具函数。
- `toolValidationConfig.ts` — toolValidationConfig 相关工具函数。
- `types.ts` — types 相关工具函数。
- `validateEditTool.ts` — validateEditTool 相关工具函数。
- `validation.ts` — validation 相关工具函数。
- `validationTips.ts` — validationTips 相关工具函数。

##### src/utils/settings/mdm

MDM 受管设置工具。

- `constants.ts` — constants 相关工具函数。
- `rawRead.ts` — rawRead 相关工具函数。
- `settings.ts` — settings 相关工具函数。

#### src/utils/shell

shell 提供者与检测工具。

- `bashProvider.ts` — bashProvider 相关工具函数。
- `outputLimits.ts` — outputLimits 相关工具函数。
- `powershellDetection.ts` — powershellDetection 相关工具函数。
- `powershellProvider.ts` — powershellProvider 相关工具函数。
- `prefix.ts` — prefix 相关工具函数。
- `readOnlyCommandValidation.ts` — readOnlyCommandValidation 相关工具函数。
- `resolveDefaultShell.ts` — resolveDefaultShell 相关工具函数。
- `shellProvider.ts` — shellProvider 相关工具函数。
- `shellToolUtils.ts` — shellToolUtils 相关工具函数。
- `specPrefix.ts` — specPrefix 相关工具函数。

#### src/utils/skills

技能相关工具。

- `skillChangeDetector.ts` — skillChangeDetector 相关工具函数。

#### src/utils/suggestions

补全建议工具（命令/目录/shell 历史/slack 频道等）。

- `commandSuggestions.ts` — commandSuggestions 相关工具函数。
- `directoryCompletion.ts` — directoryCompletion 相关工具函数。
- `shellHistoryCompletion.ts` — shellHistoryCompletion 相关工具函数。
- `skillUsageTracking.ts` — skillUsageTracking 相关工具函数。
- `slackChannelSuggestions.ts` — slackChannelSuggestions 相关工具函数。

#### src/utils/swarm

多智能体 swarm（团队协作）工具。

- `constants.ts` — constants 相关工具函数。
- `inProcessRunner.ts` — inProcessRunner 相关工具函数。
- `It2SetupPrompt.tsx` — It2SetupPrompt 相关工具函数。
- `leaderPermissionBridge.ts` — leaderPermissionBridge 相关工具函数。
- `permissionSync.ts` — permissionSync 相关工具函数。
- `reconnection.ts` — reconnection 相关工具函数。
- `spawnInProcess.ts` — spawnInProcess 相关工具函数。
- `spawnUtils.ts` — spawnUtils 相关工具函数。
- `teamHelpers.ts` — teamHelpers 相关工具函数。
- `teammateInit.ts` — teammateInit 相关工具函数。
- `teammateLayoutManager.ts` — teammateLayoutManager 相关工具函数。
- `teammateModel.ts` — teammateModel 相关工具函数。
- `teammatePromptAddendum.ts` — teammatePromptAddendum 相关工具函数。

##### src/utils/swarm/backends

swarm 后端（InProcess/ITerm/Tmux/Pane）。

- `detection.ts` — detection 相关工具函数。
- `InProcessBackend.ts` — InProcessBackend 相关工具函数。
- `it2Setup.ts` — it2Setup 相关工具函数。
- `ITermBackend.ts` — ITermBackend 相关工具函数。
- `PaneBackendExecutor.ts` — PaneBackendExecutor 相关工具函数。
- `registry.ts` — registry 相关工具函数。
- `teammateModeSnapshot.ts` — teammateModeSnapshot 相关工具函数。
- `TmuxBackend.ts` — TmuxBackend 相关工具函数。
- `types.ts` — types 相关工具函数。

#### src/utils/task

任务输出/框架工具。

- `diskOutput.ts` — diskOutput 相关工具函数。
- `framework.ts` — framework 相关工具函数。
- `outputFormatting.ts` — outputFormatting 相关工具函数。
- `sdkProgress.ts` — sdkProgress 相关工具函数。
- `TaskOutput.ts` — TaskOutput 相关工具函数。

#### src/utils/telemetry

遥测与追踪工具。

- `betaSessionTracing.ts` — betaSessionTracing 相关工具函数。
- `bigqueryExporter.ts` — bigqueryExporter 相关工具函数。
- `events.ts` — events 相关工具函数。
- `instrumentation.ts` — instrumentation 相关工具函数。
- `logger.ts` — logger 相关工具函数。
- `perfettoTracing.ts` — perfettoTracing 相关工具函数。
- `pluginTelemetry.ts` — pluginTelemetry 相关工具函数。
- `sessionTracing.ts` — sessionTracing 相关工具函数。
- `skillLoadedEvent.ts` — skillLoadedEvent 相关工具函数。

#### src/utils/teleport

teleport 远程环境工具。

- `api.ts` — api 相关工具函数。
- `environments.ts` — environments 相关工具函数。
- `environmentSelection.ts` — environmentSelection 相关工具函数。
- `gitBundle.ts` — gitBundle 相关工具函数。

#### src/utils/todo

待办（todo）相关工具。

- `types.ts` — types 相关工具函数。

#### src/utils/ultraplan

ultraplan 相关工具。

- `ccrSession.ts` — ccrSession 相关工具函数。
- `keyword.ts` — keyword 相关工具函数。

### src/vim

Vim 模式：motions / operators / textObjects 等编辑动作。

- `motions.ts` — Vim 移动（motions）动作。
- `operators.ts` — Vim 操作符（operators）。
- `textObjects.ts` — Vim 文本对象（text objects）。
- `transitions.ts` — Vim 状态转换。
- `types.ts` — Vim 相关类型定义。

### src/voice

语音模式相关实现。

- `voiceModeEnabled.ts` — 语音模式开关判断。

## vendor

原生（native）依赖源码目录，保留音频采集、图像处理、修饰键、URL handler 等原生模块的 TypeScript 源文件。

### vendor/audio-capture-src

音频采集原生模块源码。

- `index.ts` — 音频采集原生模块源码。

### vendor/image-processor-src

图像处理原生模块源码。

- `index.ts` — 图像处理原生模块源码。

### vendor/modifiers-napi-src

修饰键（modifiers）原生模块源码。

- `index.ts` — 修饰键原生模块源码。

### vendor/url-handler-src

URL handler 原生模块源码。

- `index.ts` — URL handler 原生模块源码。
