# 独立生态契约与来源规则修复

> 日期：2026-11-12
> 类型：fix / test / docs
> 模块：Settings / 启动 / 扩展发现 / MCP / 发布包
> 状态：实现、全量、核心集合与发布包验收已通过
> 关联 commit：本次工作区改动
> 关联文档：[自有格式清单](../independent-ecosystem.md)、[核心引擎计划](../20261111-core-engine-plan.md)

## 根因与复现

新建 `ecosystem-contract.test.ts` 首轮 13 项中 7 项失败，其余 6 项验证了已有规则；随后补三项正向场景，当前合计 16 项。

- `D:/AI项目/claude_personal/src/cli-config.ts` 的 loadConfig 原本直接合并 readUserSettings().env 与 managed.env，绕过 user 来源选择，也遗漏显式 --settings。关闭 user 时测试变量仍为 user；两种显式 settings（文件/JSON）都得到 user，而不是 explicit。
- `D:/AI项目/claude_personal/src/cli-tools.ts` 的插件内联 MCP 走单独 connectServer 循环，绕过 strict 和 loadConfig 的条目校验、disabled/名称禁用。严格模式、disabled:true、禁用名称三种场景下，真实 Node server 均启动并写入 server-started 文件；内联 null 值导致 normalizeServerConfig 读取 type 崩溃。
- `D:/AI项目/claude_personal/src/cli-env.ts` 的交互启动只检查已有 env/.env，没有识别 loadConfig 已支持的 settings 凭据。现在读取相同的受信任 env，避免要求额外创建 .env。

## 修改与实际规则

`readSettingsEnvironment` 复用 settings 合并入口，但只选择活动 user 来源，继续叠加显式 --settings 和 managed；项目/local env 不注入进程，值只接收字符串。loadConfig 与交互启动共同使用这一读取规则，保留现有进程环境优先级。

插件对象形式 mcpServers 通过同一 MCP loadConfig 入口校验和连接，传入 namespace 与 disabledServers；strict 时不加载自动插件内联项。保留插件安装即信任，不新增审批流程。有效内联 MCP 与 strict 下的显式 MCP 均用真实子进程完成工具调用，确认修复没有关闭正常能力。

新增随包发布的独立生态说明：根目录及显式 opt-in、设置层级和数组累积、env 信任来源、指令路径、skills/commands/agents 已消费字段、插件命名空间及 MCP 发现顺序。清楚标注 command 的 model/allowed-tools 等元数据当前不消费、扩展嵌套未知字段缺少统一诊断等限制；没有把官方资产格式兼容作为改造目标。

## 验收

- 新契约 16 项通过；设置、权限信任、workspace 重载及真实 MCP 相关六文件合计 71 项通过。
- 正向场景验证项目覆盖用户 skill/command/agent、插件命名空间、切换 workspace 移除旧项目扩展且保留用户/内联 agent，以及受信任 settings 单独提供第三方 API key。
- MCP 阴性验收观察真实启动标记；正向验收实际调用返回 `selected:ping`。未知顶层 settings 的告警也有回归。
- 发布包烟测新增只用用户 settings 凭据进入交互 CLI 并执行 /release-notes；解包后没有 .env，也不进行模型调用。

## 最终门禁

- 固定核心集合：21 文件、287 项通过。
- `npm run smoke:package` 通过：628 个文件，解包体积 8.01 MiB；真实解包 CLI 仅用 settings 凭据通过交互启动并输出当前版本说明，自有生态文档在发布包内。
- `npm run typecheck`、`npm run check`、`npm run docs:sync -- --check`、`git diff --check` 通过；检查保留原有 764 项警告，无错误。
- 全量：251 个测试文件通过，3,197 项通过、1 项跳过。

## 文件

新增：`D:/AI项目/claude_personal/src/__tests__/ecosystem-contract.test.ts`、`D:/AI项目/claude_personal/docs/independent-ecosystem.md`、本文。

实现修改：`D:/AI项目/claude_personal/src/settings.ts`、`D:/AI项目/claude_personal/src/cli-config.ts`、`D:/AI项目/claude_personal/src/cli-env.ts`、`D:/AI项目/claude_personal/src/cli-tools.ts`、`D:/AI项目/claude_personal/src/mcp/index.ts`（注释）、`D:/AI项目/claude_personal/scripts/package-smoke.mjs`、`D:/AI项目/claude_personal/package.json`。导航与指标同步至深度使用指南、CHANGELOG、核心计划、更新日志索引、项目总览/架构及维护方案。

## 未完成边界

本轮未统一嵌套/扩展未知字段诊断，未重定义同名插件整包遮蔽规则，也未完成依赖/LSP/marketplace 与热更新矩阵。损坏设置仍告警后忽略，不承诺 fail-closed 配置解析。模型质量、复杂仓库任务和多模型比较继续由独立套件验证；目标保持进行中。
