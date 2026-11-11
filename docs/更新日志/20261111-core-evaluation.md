# 固定编码任务测量与打包 SDK 入口修复

> 日期：2026-11-11
> 类型：feature / fix / test
> 模块：核心行为测量 / SDK / 发布验证
> 状态：评估器与回归已落地；真实测量结果见下
> 关联 commit：本次工作区改动
> 关联文档：[推进计划](../20261111-core-engine-plan.md)、[使用说明](../core-evaluation.md)

## 根因与改动

旧 `scripts/evaluate.mjs` 在指定目录运行模型，仅有文字与文件包含断言，没有隔离修复任务。现在把运行逻辑放到 `scripts/evaluation.mjs`，增加每尝试独立临时 Git 仓库、外置可执行验收、任务指纹、重复运行、明确模型与限制，并拒绝空验收。原套件仍可使用。新增三类版本化任务和对应验证程序，不依赖 npm 安装或模型 Shell 权限。

首次真实运行在进入 provider 之前全部失败：`src/sdk.ts` 的 `query()` 原本通过相邻 `cli.js` 定位 CLI，esbuild splitting 把共享 SDK 代码放入 `dist/chunks/` 后，错误地查找 `dist/chunks/cli.js`。新增 `sdk-bundle.test.ts`：真实构建两个共享 SDK 的入口并启动 fixture CLI，修复前能复现同一错误，修复后通过。现在共享 chunk 返回上层查找 `dist/cli.js`；源码入口缺失时仍及时报错。发布包检查也调用 SDK 默认入口，用非法预算触发本地验证，离线证明实际解包产物能够启动 CLI。

## 首次实测

2026-11-11，本机 Node v24.16.0，provider 配置类型 `anthropic`，配置模型 `k3`，每任务两次。模型由用户已有连接配置提供；没有更换供应商或借用官方账号。

`core-coding-v1`：读码 2/2，单文件修复 2/2，跨文件修复 1/2，总计 5/6。跨文件第二次失败于 `$0.00` 与预期 `0.00` 不同。原题只写“dollar string”，存在输出格式歧义，因此不把它直接归因于引擎缺陷；保留原始报告，任务升级为 v2，明确“无货币符号”及输入/输出示例。验收程序未放宽，也不删除原失败样本。

`core-coding-v2`：两轮 6/6 通过，约 285 秒；原始报告为 `.claude/evaluations/1794403347267-42324.json`。v1 的 5/6 报告为同目录下的 `1794402967330-49488.json`；最早 SDK 入口阻断的 0/6 报告为 `1794402552747-45440.json`，该次未调用 provider，不计入模型效果。

| 任务 | 轮次 | 通过 | 耗时（秒） | input tokens | output tokens |
|---|---|---|---|---|---|
| read-code | 1 | 是 | 49.107 | 1,249 | 288 |
| single-file-fix | 1 | 是 | 36.507 | 1,045 | 365 |
| cross-file-fix | 1 | 是 | 62.134 | 3,330 | 2,898 |
| read-code | 2 | 是 | 17.757 | 907 | 204 |
| single-file-fix | 2 | 是 | 27.013 | 1,146 | 533 |
| cross-file-fix | 2 | 是 | 92.713 | 3,237 | 3,199 |

usage 按 provider 原样记录，是每个查询内多次模型响应的累计值；未归一缓存计费口径。所有费用均为 null，未按其他模型估价。原始报告目录已忽略。两轮小样本只能证明这六次尝试通过所列验收，不能推断稳定成功率或通用编码质量，也未进行与官方的效果对照。

## 验证

- `evaluation.test.ts`：8 项通过。证明未修复任务不能通过、重复尝试互不污染、修复实现可被验收、无结果和 CLI 失败不算成功、异常清理、验证超时和越界路径拒绝。
- `sdk-bundle.test.ts`：1 项通过；SDK / evaluator 相关共 17 项通过。
- `npm test`：243 文件通过，3,115 项通过、1 项跳过（共 3,116 项）。
- `npm run typecheck`、`npm run check`：通过；保留仓库现有 lint 警告。
- `npm run smoke:package`：通过，包含新增 SDK 默认入口执行检查。
- `npm run smoke`、`npm run docs:sync -- --check`：通过；最终任务版本再次运行 evaluator / SDK 打包回归，9 项通过。

## 受影响文件

- 新增：`scripts/evaluation.mjs`、`examples/core-eval-suite.json`、`examples/eval-fixtures/` 的工作区输入和验证程序、`src/__tests__/evaluation.test.ts`、`src/__tests__/sdk-bundle.test.ts`、`docs/core-evaluation.md`、本文。
- 修改：`scripts/evaluate.mjs`、`src/sdk.ts`、`scripts/package-smoke.mjs`、`.gitignore`，以及计划、文档索引、使用指南和总览。
- 运行产物：`.claude/evaluations/`；不提交凭据、临时工作区或原始模型会话。
