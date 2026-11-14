# 核心编码任务测量

此入口用于源码 checkout 的真实 provider 测量。离线回归使用 `npm run test:core`；它与真实编码任务的成功率分别记录。

## 运行

```sh
npm run build
npm run eval -- examples/core-eval-suite.json --repeat=2
npm run eval -- examples/coding-loop-suite.json --repeat=2
npm run eval -- examples/repository-task-suite.json --repeat=2
npm run eval -- examples/collaboration-suite.json --repeat=2
npm run eval -- examples/collaboration-resume-suite.json --repeat=2
npm run eval -- examples/collaboration-conflict-suite.json --repeat=2
npm run eval:context -- 2
npm run eval:context -- 2 correction
npm run eval:subagents -- 2
```

评估器从当前目录 `.env` / 已有环境变量读取连接配置，不输出凭据；`--model=名字` 覆盖模型，`--command=可执行文件` 可切换 CLI。外部 CLI 必须支持 SDK 使用的 stream-json 参数与协议；这不是通用命令适配器，也不代表官方效果已经对照。

默认使用本项目 SDK，模型名由配置解析后显式传入。任务版号来自套件 `version`。各套件的尝试按顺序运行。

## 固定任务与验收

| 任务 | 初始状态 | 通过条件 |
|---|---|---|
| `read-code` | 订单过滤与求和实现 | 回答准确的文件与函数；原源码保持不变 |
| `single-file-fix` | 去重后错误排序 | 去重保留首见顺序、SameValueZero 语义、输入不变；覆盖对象、NaN 与空数组 |
| `cross-file-fix` | 金额解析、格式化和发票入口混用单位 | 整数分解析、非法输入拒绝、无货币符号的两位小数输出、跨文件发票总额正确 |
| `test-driven-repair`（独立 `coding-loop-v1` 套件） | 两个相互调用的函数存在顺序错误 | 真实测试失败 → 源码修复 → 测试通过的工具证据，测试文件不变，独立边界验收通过 |
| `typed-catalog-repair`（`repository-tasks-v2`） | TypeScript 公共导出无法编译，解析/排序/对象所有权有缺陷 | 真正编译失败→修复→构建/测试成功；运行边界、公开类型负例与补丁重放通过 |
| `catalog-module-migration`（`repository-tasks-v2`） | 同上，另需迁移 legacy 模块 | 实际 Git 移动、创建比较器、接入消费者与 README；补丁在干净仓库重新编译并验收 |
| `review-and-integrate-order-summary`（`isolated-collaboration-v1`） | 两个订单模块有缺陷，主目录包含未暂存的用户笔记 | 主模型调用 Agent 起草，独立测试后传回审查意见，恢复同一工作树，验证并应用补丁，主目录和补丁重放均通过 |
| `review-resume-in-new-cli`（`isolated-collaboration-resume-v1`） | 同一个订单夹具 | 首个 CLI 在审查后结束，新的 CLI 恢复主会话，找回原 agent id 和反馈，完成修订、整合、主目录测试及补丁重放 |
| `merge-overlapping-agent-patches`（`worktree-conflict-v1`） | 两个子代理从同一基点修改同一行，主目录同一文件另有未暂存用户修改 | 先应用一个补丁，再观察 Git 拒绝重叠补丁。主模型读取当前文件、合并两条规则、运行测试，补丁独立重放通过 |

每次尝试复制 `examples/eval-fixtures/<task>/workspace/` 到独立临时 Git 仓库，同时隔离用户配置和信任记录。助手结束后，在独立 Node 进程中执行 fixture 的 `verify.mjs`，默认限时 5 秒。验证程序留在模型工作区之外，不需要模型执行 Shell。缺少结果帧、CLI 错误、超时、断言失败都计为失败；结束后清理临时目录。

临时目录隔离用于避免不同尝试互相污染，不是操作系统沙箱。自定义套件中的验证程序属于本地可信代码。工具 allow/deny 列表控制审批规则，不代表模型只看得到这些工具的 schema。

`coding-loop-v1` 另有 14 turn / 每响应 2,048 tokens / 每查询 180 秒限制。固定命令 `node check.mjs` 通过 SDK 审批白名单放行。评估器版本 3 用隔离 ask 规则让所有 Shell 调用接受该审批，包括原本会自动允许的只读命令；额外组合命令与后台执行拒绝。报告保存实际工具 trace 与完整候选 patch；早期版本仅含 src 既有文件差异，不能代替创建/移动产物。verifier 同时核验顺序与最终语义，不以口头回答作为测试证据。早期两轮首组 2/2 通过，见[闭环记录](更新日志/20261111-coding-loop-evidence.md)。

`repository-tasks-v2` 有 20 turn / 每响应 4,096 tokens / 每查询 300 秒限制，采用 checkout 本地 TypeScript 编译器（需要开发依赖，不安装网络依赖）。编译器版本和 lib 哈希进入指纹，具体路径不作为报告内容。每次尝试都检查驱动/配置未修改，并在第二份初始仓库应用 patch 后重复独立 verifier。详情、审批原型与最终结果见[工程任务记录](更新日志/20261112-repository-task-evaluation.md)。

`isolated-collaboration-v1` 通过 SDK 启动真实 CLI。主模型负责发起委派、传回审查意见、调用预置脚本验证并应用 Git 补丁。外部验收检查同一个 agent id 和工作树、worker 两轮的文件操作、主目录测试与未暂存的用户笔记。主模型有 24 个回合，每次响应上限 4,096 tokens，整个查询上限 420 秒。Shell 审批只放行五条固定命令。被明确拒绝的请求保留在轨迹里，任何实际执行的未授权命令均使验收失败。

`isolated-collaboration-resume-v1` 使用 `resumePrompt` 启动第二次 SDK 查询。第一段正常结束且报告会话 ID 后，第二段才启动新的 CLI 并传入该 ID。第二段提示只要求继续已保存的审查。它从恢复的对话获取原 agent id 和反馈。每段最多 14 个回合、每次响应 4,096 tokens，两段共用 420 秒。配置美元预算时，第二段使用扣除第一段费用后的余额。报告的 `queries` 分别记录每段的会话 ID、工具轨迹起止偏移和用量。轨迹的结束偏移不包含在该段中。

`worktree-conflict-v1` 分别验收两个 Agent 工作树里的数量和币种规则。`git apply` 拒绝第二份补丁后，夹具比较工作区差异和暂存树，确认失败没有改变这两处。主模型在主目录读文件后合并规则，验收程序检查同文件的用户收据标题、两份 worker 补丁、规则组合及候选补丁重放。离线回归要求两个 worker 的首次请求都到达本地模拟服务，才释放任一请求。真实模型可以并行或依次分派，两个 worker 必须在整合前都交付。

`eval:context` 使用 tsx 直接运行当前源码，独立临时目录中的真实 agentLoop / provider / 文件工具。预置 107 条历史并强制压缩，检查修复结果、已有注释、配置不变、任务保留和摘要次数；任务结果由独立 Node 进程验收。它测试核心 loop，未经过 SDK。每尝试 8 turn / 每响应 2,048 tokens / 180 秒；报告包含候选实现和工具 trace，见[上下文连续性记录](更新日志/20261111-context-continuity.md)。

`correction` 选择 `context-correction-v1`。在旧要求和后续工具报告之间插入真实用户更正，要求至少两次压缩后，格式采用新的货币符号要求，早先约定的输入校验、用户注释、配置与完成产物仍通过验收。

`eval:subagents` 使用 tsx 和真实 AgentTool，在临时 Git 仓库内创建隔离 worktree。文件工具 worker 修改代码后，主控脚本独立运行测试，检查原工作区、测试、成果路径与候选补丁。每 worker 8 turn / 每响应 2,048 tokens / 180 秒。当前进度 API 未返回 worker usage。详见[子代理记录](更新日志/20261111-subagent-outcomes.md)。

当前 `core-coding-v2` 每次尝试固定最多 10 个 loop turn，每次模型响应最多 2,048 tokens、整个查询 120 秒。不是整个任务只允许 2,048 个输出 tokens；多次响应的累计值可以更大。已知价格的模型可在套件中设置 `maxBudgetUsd` 使用现有美元预算门禁；未知价格保留 `cost_usd: null`，不套用其他模型的价格。

## 结果

每完成一次尝试，stderr 输出名称、轮次、通过状态和耗时；最终 stdout 输出报告路径及通过数。完整报告在 `.claude/evaluations/<时间戳>-<pid>.json`，该目录已忽略，不会提交运行产物。

即使收到成功 result，只要 SDK 随后报告 `abnormal_exit`，本次尝试仍判失败。可恢复的 stdout 噪声诊断与进程异常终止分别处理。

每项包含任务指纹、实际限制、工具审批规则、耗时、provider 返回的 usage、费用和断言诊断。指纹覆盖任务提示、输入/验证文件、任务版本、限制和工具规则。模型、provider、CLI 与重复次数记录在报告头；报告不含 API key 和环境变量快照。

新增命令白名单后，指纹还显式纳入 `shellCommands`。早期报告采用先前的指纹计算字段，比较旧报告时需要同时核对套件与评估器版本；不要把不同指纹直接当作同输入对照。

当前报告含 `evaluator_version: 5`、`shell_approval`、可选 `toolchain` 和 `patch_replay_verified`。候选补丁以初始 Git tree 为基线，包含暂存与未暂存改动以及未忽略的新文件，排除 `.claude` 运行材料。任务的 `initialEdits` 可为已跟踪的夹具文件预置未暂存改动。评估器先创建基线提交，再应用这些改动，并在补丁重放时重建同样的初始状态。验证程序收到工作区、回答文件和阶段三个参数，阶段为 `workspace` 或 `patch-replay`。Git 忽略的必要源码可能使原工作区通过而补丁复验失败，报告会标出失败阶段。

强制 ask 通过本项目自有 settings 实现，目前只对本项目 CLI 验证。`--command` 外部 CLI 还需适配自己的设置来源并审计 trace；支持同名 stream-json 参数，不足以证明审批条件相同。

`contains`、`fileContains` 仍可用于旧套件（见 `examples/eval-suite.json`）；`verifier` 只允许用于 fixture 任务。空套件、无断言、未知断言类型在开始模型调用前报错。文件断言不能越出任务工作区。

比较时固定任务版本、指纹、模型、CLI 与限制；记录缓存、负载和机器差异，不把两次成功当成稳定成功率。首次实测和版本修正见[测量记录](更新日志/20261111-core-evaluation.md)。
