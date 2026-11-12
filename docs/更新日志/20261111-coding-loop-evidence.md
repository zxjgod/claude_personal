# 完整编码闭环：测试失败、源码修复与再次验证

> 日期：2026-11-11
> 类型：feature / test
> 模块：编码任务测量 / 工具审批 / 执行证据
> 状态：离线验收与真实模型首组测量通过
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[测量说明](../core-evaluation.md)

## 本轮交付

此前 `core-coding-v2` 禁用 Shell，验证了修改结果但未覆盖助手执行测试的过程。新增独立的 `examples/coding-loop-suite.json`（`coding-loop-v1`），保留旧套件与原始数据。

输入为两个相互调用的源码文件：去重函数错误地排序，batch API 又反转结果。任务要求先运行 `node check.mjs`，读取失败后修改源码，再次运行直至通过。测试文件必须保持不变；外置 verifier 还检查对象、NaN、冻结数组与空批次的语义。

`scripts/evaluation.mjs` 增加：

- fixture 专用 `shellCommands` 白名单，通过 SDK `canUseTool` 只批准精确匹配的前台命令；组合命令、未知请求和后台执行被拒绝。文件工具沿用已有 allow/deny 规则。
- 从实际 SDK 消息记录 tool_use / tool_result，并把 trace 交给外置 verifier。必须证明：首次测试失败 → 成功源码修改 → 修改后测试通过。仅口头声称成功、只有通过结果、修改测试文件均判失败。
- 在临时仓库建立初始索引，将初始 `src` 文件的候选差异记录为报告 `patch`；临时仓库关闭 autocrlf 以免 Git 改写基线换行。trace、patch 与断言错误均保存在忽略的原始报告中。

新增四项参数化离线场景（complete / claim-only / pass-only / changed-tests），使用真实 Node 测试命令验证 oracle。其中只有 complete 能通过；同时核验白名单拒绝组合命令与后台执行。

## 真实模型结果

命令：`npm run eval -- examples/coding-loop-suite.json --repeat=2`。

2026-11-11，本机 Node v24.16.0、Windows，用户已有 `anthropic` 类型连接，模型 `k3`。每尝试 14 个 loop turn、每次响应最多 2,048 tokens、查询 180 秒。两轮均通过，未变更验收程序。

| 轮次 | 结果 | 耗时（秒） | input tokens | output tokens | 工具事件数 | patch 字符数 |
|---|---|---|---|---|---|---|
| 1 | 通过 | 59.320 | 12,997 | 931 | 16 | 595 |
| 2 | 通过 | 49.225 | 2,342 | 898 | 14 | 595 |

报告：`.claude/evaluations/1794406367863-52588.json`。两次输入指纹一致：`06ee3d3ce63fc7f2fb5f60f08ea44299da4e6f0f1b56421f914ec3e24b25d671`。费用均为 null；usage 是 provider 返回的累计值，未归一缓存口径。两个成功样本验证了这个小项目场景，尚不能外推复杂仓库任务成功率或宣称与官方效果等价。

## 验证

- `evaluation.test.ts`：8 → 12 项通过，新增四类完整闭环证据验收。
- `npm test`：244 文件通过，3,126 项通过、1 项跳过（共 3,127 项）。
- `npm run typecheck`、`npm run check`：通过；仓库原有 lint 警告保留。
- `npm run test:core`：12 文件、207 项通过；`npm run docs:sync -- --check` 与 `git diff --check` 通过。

## 受影响文件与后续

修改：`scripts/evaluation.mjs`、`src/__tests__/evaluation.test.ts`、`package.json`、测量指南、总览、推进计划和日志索引。新增：`examples/coding-loop-suite.json`、`examples/eval-fixtures/coding-loop/`（工作区源码、可见测试和独立 verifier）、本文。

目前候选差异覆盖初始 `src` 下已有文件；新增文件、目录移动、构建失败与中途取消等任务仍需扩展。工具 trace 是实际执行通道的记录，临时目录与白名单用于隔离测量，不提供操作系统级沙箱。
