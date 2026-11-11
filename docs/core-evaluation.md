# 核心编码任务测量

此入口用于源码 checkout 的真实 provider 测量。离线回归使用 `npm run test:core`；它与真实编码任务的成功率分别记录。

## 运行

```sh
npm run build
npm run eval -- examples/core-eval-suite.json --repeat=2
```

评估器从当前目录 `.env` / 已有环境变量读取连接配置，不输出凭据；`--model=名字` 覆盖模型，`--command=可执行文件` 可切换 CLI。外部 CLI 必须支持 SDK 使用的 stream-json 参数与协议；这不是通用命令适配器，也不代表官方效果已经对照。

默认使用本项目 SDK，模型名由配置解析后显式传入，避免报告只写“configured model”。任务版号来自套件 `version`。每个任务重复两次时，总计六次尝试；它们顺序运行。

## 固定任务与验收

| 任务 | 初始状态 | 通过条件 |
|---|---|---|
| `read-code` | 订单过滤与求和实现 | 回答准确的文件与函数；原源码保持不变 |
| `single-file-fix` | 去重后错误排序 | 去重保留首见顺序、SameValueZero 语义、输入不变；覆盖对象、NaN 与空数组 |
| `cross-file-fix` | 金额解析、格式化和发票入口混用单位 | 整数分解析、非法输入拒绝、无货币符号的两位小数输出、跨文件发票总额正确 |

每次尝试复制 `examples/eval-fixtures/<task>/workspace/` 到独立临时 Git 仓库，同时隔离用户配置和信任记录。助手结束后，在独立 Node 进程中执行 fixture 的 `verify.mjs`，默认限时 5 秒。验证程序留在模型工作区之外，不需要模型执行 Shell。缺少结果帧、CLI 错误、超时、断言失败都计为失败；结束后清理临时目录。

临时目录隔离用于避免不同尝试互相污染，不是操作系统沙箱。自定义套件中的验证程序属于本地可信代码。工具 allow/deny 列表控制审批规则，不代表模型只看得到这些工具的 schema。

当前 `core-coding-v2` 每次尝试固定最多 10 个 loop turn，每次模型响应最多 2,048 tokens、整个查询 120 秒。不是整个任务只允许 2,048 个输出 tokens；多次响应的累计值可以更大。已知价格的模型可在套件中设置 `maxBudgetUsd` 使用现有美元预算门禁；未知价格保留 `cost_usd: null`，不套用其他模型的价格。

## 结果

每完成一次尝试，stderr 输出名称、轮次、通过状态和耗时；最终 stdout 输出报告路径及通过数。完整报告在 `.claude/evaluations/<时间戳>-<pid>.json`，该目录已忽略，不会提交运行产物。

每项包含任务指纹、实际限制、工具审批规则、耗时、provider 返回的 usage、费用和断言诊断。指纹覆盖任务提示、输入/验证文件、任务版本、限制和工具规则。模型、provider、CLI 与重复次数记录在报告头；报告不含 API key 和环境变量快照。

`contains`、`fileContains` 仍可用于旧套件（见 `examples/eval-suite.json`）；`verifier` 只允许用于 fixture 任务。空套件、无断言、未知断言类型在开始模型调用前报错。文件断言不能越出任务工作区。

比较时固定任务版本、指纹、模型、CLI 与限制；记录缓存、负载和机器差异，不把两次成功当成稳定成功率。首次实测和版本修正见[测量记录](更新日志/20261111-core-evaluation.md)。
