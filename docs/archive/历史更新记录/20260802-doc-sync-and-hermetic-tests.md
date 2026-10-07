# 更新日志 — 文档同步脚本 + 测试封闭化修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-02
> 类型：fix
> 模块：测试（new-tools）、工程基建（scripts/doc-sync.mjs）、文档体系（架构/总览/维护方案/快速开始/CHANGELOG）
> 主题：文档数字漂移根治（一键复核脚本）+ WebFetchTool URL 测试封闭化
> 状态：已落地
> 验证：`npm run typecheck` 通过、`npx vitest run new-tools` 25/25 全过、`npm run smoke` PASSED、`npm run docs:sync -- --check` 全绿
> 关联 commit：〈待提交〉
> 关联文档：`docs/archive/reports/20260623-项目评审报告.md`（2026-08-02 审查结论）

---

## 一、现象 / 用户反馈

审查发现文档体系与代码严重不同步：`项目总览.md` 声称「~13,000 行 / 76 测试文件 / 952 用例 / 100% 通过 / v1.2.0」，实测为 **24,843 非测试行 / 151 文件 / 76 测试文件 / 952 用例（951/952，1 例超时）/ package.json=1.0.0**。`模块维护方案.md` 引用的 10 个旧工具路径（`tools.ts`、`task-tool.ts` 等）已随 Phase-3 重构删除，其自带复核命令因此返回 0。CHANGELOG 缺失 `0ca3cd4`、`f471601` 两条提交。

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | 文档数字靠手写维护，无复核门禁 | docs/* | 数字反复漂移 |
| 2 | `new-tools.test.ts` 的 WebFetchTool「should accept valid URLs」注释标 no-network 却对 `github.com` 发起真实 `fetch` | `src/__tests__/new-tools.test.ts:187` | 受限网络下挂起，5s 超时，套件 951/952 |
| 3 | Phase-3 重构未同步文档路径 | docs/项目架构.md、模块维护方案.md | 定位失效 |
| 4 | `package.json` 版本号从未随发布推进 | package.json | 三处版本不一致 |
| 5 | CHANGELOG 版本号不落、缺提交 | docs/CHANGELOG.md | 无法回溯 |

## 三、改动明细

### 测试封闭化（`src/__tests__/new-tools.test.ts`）

`should accept valid URLs` 改为 stub 全局 `fetch` 返回固定 Response，断言 `error` 未定义且内容含 `ok`；finally 恢复原 fetch。

### 计数脚本（新增 `scripts/doc-sync.mjs`）

- 静态扫描行数/文件数/测试文件数；经 tsx loader `import()` `COMMANDS`/`CORE_TOOLS` 取真值（39 命令 / 28 工具）。
- `--check` 与 `docs/项目总览.md` 比对并退出码 1；`--with-tests` 跑 vitest 取权威测试用例数。
- `package.json` 增 `docs:sync` script；`.husky/pre-commit` 追加 `--check` 警告（不阻断）。

### 文档更新

- `项目架构.md`：规模快照、6 静态段、工具系统 §5 全节、MCP/CLI/TUI 路径、命令数 39、依赖图与模块索引重写、vitest 76/952。
- `项目总览.md`：行数/文件数/命令数/工具数补齐、版本真源说明、结构树、执行超时 2min。
- `模块维护方案.md`：卡 5 工具路径、症状反查、红线、cookbook 更新；自检命令改为 `npm run docs:sync`。
- `快速开始.md`：命令表补 `/mode`、`/provider`，注明 `exit` 非 slash 命令，冒烟测试补 API key 前置。
- `.env.example`：补 `CCR_*`/`LLM_GATEWAY*` 等 19 个运行时开关注释。
- `CHANGELOG.md`：顶部 v1.2.0 化、补 07-08/07-09 提交、刷新提交表；`package.json` version → 1.2.0。

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npx vitest run new-tools` | 25 / 25 全过（485ms，此前超时） |
| `npm run smoke` | 12 / 12 检查 PASSED |
| `npm run docs:sync -- --check` | 全绿（版本/行数/文件数/测试文件/命令数/工具数） |

## 五、受影响文件

**新增**
- `scripts/doc-sync.mjs`（一键复核计数）
- `docs/archive/历史更新记录/20260802-doc-sync-and-hermetic-tests.md`（本文）

**修改**
- `src/__tests__/new-tools.test.ts`（WebFetchTool 测试封闭化）
- `package.json`（version 1.2.0、docs:sync script）
- `.husky/pre-commit`（doc-sync 警告）
- `docs/项目架构.md`、`docs/项目总览.md`、`docs/模块维护方案.md`、`docs/快速开始.md`、`docs/CHANGELOG.md`
- `.env.example`

## 六、设计决策记录

1. **版本真源 = `package.json`** —— 把 `version` 提到与文档一致的 1.2.0，CHANGELOG 顶部注明唯一真源，避免三处漂移。
2. **doc-sync 读 `COMMANDS.length`/`CORE_TOOLS.length` 而非正则** —— 真值而非估算；正则仅在 import 失败时降级。
3. **pre-commit 警告不阻断** —— 数字漂移不阻塞提交（避免无关文档改动被卡），但醒目提示。
4. **测试静态计数标 `≈`** —— 静态 `it(/test(` 计数无法匹配 vitest 的 `.each` 展开值，权威数必须 `--with-tests`。
