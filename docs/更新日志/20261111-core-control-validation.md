# 核心验收入口与审批信封校验

> 日期：2026-11-11
> 类型：fix / test
> 模块：Headless 控制协议 / 核心引擎验收
> 状态：已落地，验证结果见下
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[控制协议](20261107-sdk-control-protocol.md)

## 现象与根因

`src/headless-control.ts` 的 `handleResponse()`（约 120 行）只对 `subtype: "error"` 单独处理，其余信封均按成功回复解析。带正确 request_id 的回复即使缺少 subtype 或 subtype 未知，嵌套的 `behavior: "allow"` 仍能放行待审批工具。

在真实 `runHeadless → agentLoop → 权限检查 → 工具执行` 路径新增两项参数化测试，修复前均失败：预期无执行，实际得到 `[{value: "unapproved"}]`。修复只允许 `subtype: "success"` 携带审批；畸形回复消耗当前请求并拒绝执行，后续迟到回复不能重新批准。

另新增跨回合测试：第一回合等待审批时 interrupt，第一工具不执行；第二回合挂起后收到第一回合迟到的 allow，第二工具仍不执行；收到自身审批后才执行，结果依次为失败/成功，进程退出码为 0。用 initialize 应答作为读入屏障，避免靠固定 sleep 判断迟到回复已经处理。

## 文件改动

- 修改 `src/headless-control.ts`：校验审批回复信封的成功 subtype。
- 修改 `src/__tests__/headless-control.test.ts`：12 → 15 项，新增上述三个回归用例。
- 修改 `package.json`：新增 `test:core`，固定 10 个核心行为测试文件。
- 新增 `docs/20261111-core-engine-plan.md`：固定验收矩阵、后续工作与完成条件。
- 新增本文；更新 `docs/README.md`、`docs/20261002-claude-code差距评估.md`、`docs/项目总览.md`、`docs/更新日志/README.md` 的入口与实测数字。

## 验证

- `npm run typecheck`：通过。
- 控制协议、TS SDK、Python SDK 和真实 CLI 控制往返：4 文件、25 项通过。
- `npm run test:core` 首轮：10 文件、188 项通过。
- `npm run check`：通过，仓库现有警告仍存在。
- `npm test`：241 文件通过，3,106 项通过、1 项跳过（共 3,107 项）。
- `npm run smoke`：构建与 6 组 CLI / 会话启动冒烟通过。
- `npm run smoke:package`：实际打包、解包、CLI / SDK 发布入口检查通过。
- 加强迟到回复的同步断言后，再跑 `npm run test:core`：188 项通过；类型检查与 `npm run docs:sync -- --check` 通过。

本轮只验证本项目契约，没有接入官方资产，也未执行真实模型效果对照。避免同类问题的约束是：控制帧必须验证外层信封，再解释内层权限决策；审批用完整执行流程测试锁定。
