# v1.6.0 本地能力全面升级

日期：2026-10-02。类型：feature / fix。依据：[升级前差距评估](../20261002-claude-code差距评估.md)。

## 最重要的行为变化

Fork Skill 与其他委派入口一样保留父会话的 deny / ask 和 Hooks；无审批通道时不能自行批准写入。工作树只有在没有修改和独有提交时才自动清理，有成果或执行异常时保留路径与分支。主会话进入工作树后，文件工具、Shell 与模型提示使用同一个有效工作区，会话存储保持原位置。

## 新增与增强

| 领域 | v1.6.0 行为与入口 |
|---|---|
| 配置 | 独立用户目录、项目／本地／CLI／管理配置层级，递归合并与权限集合合并；`--settings`、`--setting-sources`；管理权限模式优先 |
| 项目指令 | 用户、祖先和根目录指令；CLAUDE.local.md、AGENTS.md 回退；Markdown 导入最多四跳；子目录与路径规则按文件操作加载 |
| Skills | 标准 YAML 列表与嵌套字段；调用可见性、标准 allowed-tools 授权、disallowed-tools、模型／effort、作用域 Hooks；手动调用 fork Skill |
| 子代理 | 默认用户目录、递归发现、官方工具名映射、省略工具时继承、模型与 effort、预载技能；父限制仍保留，定义只能收窄 plan / dontAsk |
| 插件 | `.claude-plugin/plugin.json` 和标准组件目录；Skill、command、agent 命名空间；显式插件目录；标准 hooks 文件与原有信任门 |
| MCP | 用户配置、显式文件或 JSON 配置、strict 模式、可选择的官方项目配置适配；插件服务器命名空间与内联配置 |
| Hooks | command / HTTP / prompt / agent / MCP tool 执行；输入更新、额外上下文、权限结果、阻断用户输入和任务完成；事件返回值可影响执行 |
| 非交互模式 | 实时 stdin、纯 JSON stdout、分层消息事件、最终结果和 usage、结构化结果校验、会话保存／恢复、预算估算与模型价格检查 |
| 自动化 API | TypeScript `query()` 和 Python async iterator；会话恢复、取消、工具规则、结构化结果；可用于同任务 CLI 对照评估 |
| 持续目标 | `/goal` 独立完成评估与有限续做；可使用 CCR_FAST_MODEL；不能把未满足条件的任务报告为完成 |
| 工作流 | 继续使用声明式数据解释器，新增有界 repeat / if，持久缓存已完成且参数不变的 worker 报告；没有重新开放任意 JavaScript |
| 会话运行状态 | 保存／恢复 cron、wakeup、结构化任务、团队和后台输出；正在运行的进程恢复为中断，不能假装仍在执行 |
| 记忆 | 真正跨项目 user scope；同仓库工作树共享项目记忆；MEMORY.md 索引与主题文件；memory_recall 按关键词／ID 查询 |
| 代码理解 | 通用 LSP stdio 接入；definition、references、hover、symbols、diagnostics；编辑通知与可用的自动诊断；TS / JS 有内置 tsserver 导航 |
| 询问 | 一次调用最多四个问题，保留旧单问题调用；选项 preview 在 TUI 聚焦时显示，连续收集批次答案 |
| 搜索 | `allowed_domains` / `blocked_domains` 参数适配与结果过滤，保留原 domains 和 HTML 搜索回退 |
| 评估 | `npm run eval -- examples/eval-suite.json`；记录成功断言、时间、usage 和成本；可指定官方可执行文件跑同一任务集 |

## 配置与使用

默认用户配置放在 `~/.claude-code-replica/`，可用 `CCR_USER_CONFIG_DIR` 重定向，避免自动接触官方凭据。

显式设置 `CCR_COMPAT_CLAUDE=1` 后，使用官方用户 `.claude` 目录的 settings / skills / agents，并适配项目 `.mcp.json`；仍保留项目 MCP 与 Hooks 信任确认。不读取官方登录令牌和 `~/.claude.json`。

`CCR_MANAGED_SETTINGS` 指向管理 JSON，`CCR_MANAGED_INSTRUCTIONS` 指向管理指令。管理指令在 safe-mode / bare 下仍生效。

`--safe-mode` 现在禁用自定义扩展供排障；需要旧版只读行为时使用 `--read-only` 或 `--permission-mode plan`。`--bare` 跳过扩展和项目指令自动加载。

LSP 示例在 [examples/lsp.json](../../examples/lsp.json)：安装对应服务器后复制到 `.claude/lsp.json`。配置的语言服务器和插件是可执行扩展，适用既有安装即信任约定。

TypeScript 在构建后导入 `dist/sdk.js` 的 `query()`。Python 在 [python/ccr_sdk.py](../../python/ccr_sdk.py) 提供 `query()`；运行依赖 Node 和构建后的 dist。二者使用项目自己的公开协议，不宣称官方 Agent SDK 的全部控制消息、审批回调都可以直接复用。

## 验证与覆盖率迁移

针对性验证包含：委派规则、真实临时 Git 工作树、CLI 子进程 stdout 与 resume、标准 YAML 和插件命名空间、HTTP / 模型 / MCP Hook、模拟 Python LSP、任务恢复和工作流缓存。没有访问真实模型凭据或运行付费的官方效果对照。

Vitest / V8 覆盖率工具链升级到 4.1.x，npm 审计已无已知依赖漏洞。新版 V8 使用不同的 AST 映射，旧阈值不能直接作为原有覆盖质量的对照。

为确认原因，在 `f28352a` 的独立只读源码副本上运行了同版本工具链：165 个测试文件、2,159 个测试全部通过；与升级版的比较如下。

| 指标 | 升级前代码，同版本工具链 | 升级版第一次最终测量 | 重新锚定的门禁 |
|---|---:|---:|---:|
| Statements | 70.56% | 70.71% | 68% |
| Branches | 61.83% | 61.49% | 59% |
| Functions | 74.38% | 74.43% | 72% |
| Lines | 72.17% | 72.46% | 70% |

新门禁继续保留原规则约 3 个百分点的基线余量，未删除测试或排除新增模块来提高数字。后续覆盖率以新工具链实测为准。测试并发限制为四个 worker，避免 ZIP、进程和 TUI 测试互相争抢内存与 CPU。

最终检查结果随本轮完成更新：[升级实施记录](../archive/reports/20261002-升级实施.md)。本机检查不能替代 Linux / Windows CI 运行。

## 仍有条件的能力

官方订阅登录、托管云端、Chrome 官方扩展、Remote Control、IDE 产品界面、语音服务及 Mods 私有运行时没有本地替代实现。它们需要对应账号、外部服务或独立客户端项目。现有 MCP 和新增 SDK 可以接入可公开使用的工具，但不等同于这些官方产品已经移植。

通用 LSP 需要实际语言服务器 binary；预算依据已知价格与 token 估算，不是供应商计费系统的硬限制；没有实际支付账号的云认证联调；官方插件的全部清单字段和协议细节仍未全面复现。不用空壳入口宣称这些能力已完成。

临时对照目录 `.claude/upgrade-baseline/` 的清理被自动审批策略拒绝，因此保留并纳入忽略规则；它包含源码与依赖链接，不进入交付文件。
