# TypeScript 工程修复、模块迁移与补丁复验

> 日期：2026-11-12；类型：feature / fix / test / evaluation。
> 模块：编码任务评估器、固定命令审批、TypeScript 工具链与候选补丁。
> 关联 commit：工作区改动，尚未提交。
> 关联：[核心计划](../20261111-core-engine-plan.md)、[评估运行说明](../core-evaluation.md)、[SDK 进程收尾](20261112-sdk-process-tree.md)。

## 目标与任务范围

新增 `repository-task-suite.json`，将测量从两函数的 JavaScript 修复扩展到小型 TypeScript 工程。两个任务使用相同的三个源文件初始项目，首轮真实构建因公共导出缺失而失败；模型必须观察失败，再修复公开类型、JSONL 解析、对象所有权、排序、状态转换与跨文件消费者。

迁移任务另要求实际执行 Git 移动，退休 legacy 模块，创建优先级比较模块并接入依赖，更新公共入口、消费者和根 README。它覆盖完整的创建/移动/修改交付，仍不是大型真实仓库成功率的证明。

## 评估器修复与可重放产物

原评估器仅保存 `git diff -- src`：新文件未进 index、git mv 已暂存、根文档不在 src，三者都可能丢失。新回归实际生成迁移与新文件后，原实现得到空补丁，`git apply` 报 No valid patches。复现记录在本机 `.review-tmp/repository-patch-red.log`。

现在初始化输入后保存 Git tree 基线，对新文件使用 intent-to-add，比较基线与最终工作树，覆盖暂存/未暂存修改、创建、删除、移动和根目录文档；排除 `.claude` 运行材料及 Git 忽略的新文件。不创建用户提交。报告记录 `patch_base_tree`、候选 patch 和范围。

`patchReplay: true` 的任务在另一份初始仓库应用候选补丁，再独立运行同一 verifier。原工作区通过而重放缺文件时，必须失败，不能只交一个不完整 patch。离线回归刻意将必要新源码放进 `.git/info/exclude`，原工作区编译和测试通过，重放编译失败，报告区分 `workspace` 与 `patch-replay` 阶段。

## TypeScript 工具链与验收

`toolchain: "typescript"` 使用 checkout 已安装的编译器，不安装依赖、不联网下载。绝对编译器位置经 `CCR_EVAL_TSC` 提供给受保护的驱动和独立 verifier；报告只记录 TypeScript 版本和 lib 内容哈希，二者进入输入指纹。当前实测为 TypeScript 5.9.3。

受保护的构建、测试、编译配置、包信息和 ignore 文件逐字校验。verifier 重新编译，检查运行边界、JSONL 的物理行号、规范化后重复 ID、冻结输入不被修改、返回对象隔离、稳定排序、幂等完成；外部 TypeScript 消费者还用负例验证 priority/status 闭合联合类型未被擦成 any。迁移任务检查旧模块消失、新模块被实际依赖、README 更新和真实 Git 移动证据。

固定验收顺序为编译失败 → 源码修改 → 构建成功 → 测试成功；模型的最终口头总结不代替工具 trace。限制：20 turn、每响应 4,096 tokens、每查询 300 秒；verifier 每次最多 20 秒。构建复验可使用相同宿主工具链，这不是 OS 沙箱或所有依赖均打包的 hermetic 构建。

## Shell 审批审计与版本

首个 `repository-tasks-v1` 原型两轮四项功能/补丁复验全部通过，原始报告为本机 `.claude/evaluations/1794429277242-39656.json`。审计 trace 发现默认只读 Shell 快捷允许绕过 canUseTool，因此 git status 组合命令仍被执行；不能将该原型作为“所有 Shell 均受固定白名单约束”的证据。

评估器现为版本 3：在每次隔离 user settings 写入 Bash/PowerShell 的 ask 规则，所有 Shell 调用都走固定命令审批，不改变产品的默认只读权限策略。配置模式 `all-shell-ask-v1` 进入指纹和报告。真实本地 SDK→CLI 回归确认白名单外的只读 git status 被拒，名单内构建实际执行。

套件升为 `repository-tasks-v2` 并重新运行两轮：四项全部通过，四份候选 patch 均通过重放。报告为本机 `.claude/evaluations/1794430199646-62652.json`（已忽略，不提交原始运行产物）；模型 `k3`，adapter 为 `anthropic` 协议，评估器版本 3。不能把不同评估器/审批模式的输入指纹当作同条件比较。

| 任务 | 尝试 | 耗时 | 输入 / 输出 tokens | 补丁复验 |
|---|---:|---:|---:|---|
| typed-catalog-repair | 1 | 72.483s | 9,680 / 6,456 | 通过 |
| catalog-module-migration | 1 | 68.932s | 9,051 / 4,488 | 通过 |
| typed-catalog-repair | 2 | 38.718s | 4,929 / 2,194 | 通过 |
| catalog-module-migration | 2 | 138.008s | 9,981 / 5,169 | 通过 |

总计 318.141 秒；费用四项均为 null。tokens 是多次响应的累计值，不受“单次响应 4,096”的总和限制。两个任务各自两轮的输入指纹一致：修复 `35169037cffa57b0d4599a976525fc90937db1da935ef305afcce06dc81e35f6`，迁移 `d26e5e3968dfe5aa15078424ea53df1e5aefa9af81b9cbdde1caf68317316e70`。TypeScript lib 哈希为 `f15b23af1bc1ef5f9971cfe60ceda0ee0c237251981d07b084be029c72b8f0ec`。

成功命令逐条对照白名单审计通过；添加 cd 的组合命令和 build && test 组合均被拒，模型随后用精确命令完成。修复候选包含三个源码文件，迁移候选包含 README、消费者、入口、旧模块删除及两个新模块；Git rename 相似度不足时补丁表示为删除/新建，工具 trace 则证明实际执行了 git mv。以上是四次小样本，不是稳定成功率或官方等效结论。

## 门禁中发现的进程边界

首次并行运行全量、核心与发布包时，既有 CLI 就绪/退出期限出现超时，原生 taskkill 还返回了之前未覆盖的 255。只接受 128 的实现过度依赖一次原生样本，现改成对非零数值返回核验实际行动目标 PID；目标仍存活时继续报错，SDK 父 PID 不被当作目标。Windows 单元回归现覆盖 128/255。

后续重量级门禁改为串行，保留现有 CLI 就绪/退出断言，不用隐藏进程存活失败换绿灯。最终全量 257 文件、3,256 项通过、1 项跳过（248.13 秒）；核心 28 文件、357 项通过（77.02 秒）。发布包烟测通过：637 文件、8.04 MiB 解包体积。`npm run check` 与 `npm run typecheck` 通过；原有 764 项警告，无错误。文档同步与 diff 空白检查通过。

## 文件与定位

新增：

- `D:/AI项目/claude_personal/examples/repository-task-suite.json`
- `D:/AI项目/claude_personal/src/__tests__/repository-evaluation.test.ts`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/.gitignore`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/README.md`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/package.json`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/tsconfig.json`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/build.mjs`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/test.mjs`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/src/legacy.ts`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/src/index.ts`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/workspace/src/commands.ts`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/verify.mjs`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/verify-repair.mjs`
- `D:/AI项目/claude_personal/examples/eval-fixtures/repository-tasks/verify-migration.mjs`
- `D:/AI项目/claude_personal/docs/更新日志/20261112-repository-task-evaluation.md`

修改：`D:/AI项目/claude_personal/scripts/evaluation.mjs`、`D:/AI项目/claude_personal/src/__tests__/evaluation.test.ts`、`D:/AI项目/claude_personal/src/utils/owned-process.ts`、`D:/AI项目/claude_personal/src/__tests__/owned-process.test.ts`、`D:/AI项目/claude_personal/python/ccr_sdk.py`、`D:/AI项目/claude_personal/package.json`、`D:/AI项目/claude_personal/docs/core-evaluation.md`、`D:/AI项目/claude_personal/docs/20261111-core-engine-plan.md`、`D:/AI项目/claude_personal/docs/项目总览.md`、`D:/AI项目/claude_personal/docs/项目架构.md`、`D:/AI项目/claude_personal/docs/模块维护方案.md`、`D:/AI项目/claude_personal/docs/CHANGELOG.md`、`D:/AI项目/claude_personal/docs/更新日志/README.md`、`D:/AI项目/claude_personal/docs/更新日志/20261112-sdk-process-tree.md`。

删除：无。基线中有意保留编译缺陷，仅在隔离副本修复和迁移，不把评估 fixture 当作应用源码。

根因定位：`scripts/evaluation.mjs:39` 的 Git 初始化、`scripts/evaluation.mjs:44` 的候选补丁、`scripts/evaluation.mjs:126` 的重放开关与后续隔离设置/验收；原 finally 的 src-only 工作树差异被替换，没有强制 ask 的回调通过隔离设置修复。

## 保留边界

这里测量的是明确任务、固定工具限制下的小型工程；尚未进行官方客户端同条件对照。没有证明大型依赖升级、已有 Git 冲突、主模型自主委派与合并、用户中途改需求或长时间多会话连续编码的稳定性。当前候选范围排除整棵 `.claude`，该目录内的 authored 设置/扩展还需另建产物验收；本轮必需的源码、根配置与文档不在排除范围内。真实 provider 费用按报告的已知值记录；未知价格保留 null，不代表免费。第三方模型连接和自有生态格式保持既定分叉方向。
