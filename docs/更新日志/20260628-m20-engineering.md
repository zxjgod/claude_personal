# 更新日志 — M20 工程化对齐（Biome / esbuild / 冒烟 / husky / CI）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-28
> 类型：feature（里程碑 M20）
> 模块：工程基建（package.json · biome.json · .gitattributes · scripts/build.mjs · scripts/smoke.mjs · .husky/pre-commit · .github/workflows/ci.yml）+ cli.ts（`--version/--help` + 无 key 早退出）
> 主题：从"零工程化"补齐到"可发布"——单工具 lint/format（Biome）、esbuild 转译构建、免 API key 冒烟脚本、husky+lint-staged pre-commit、GitHub Actions CI。
> 状态：已落地
> 验证：`npm run typecheck` 0 错误；`npm run check`(biome) 干净；`npm test` **506/506**；`npm run smoke` 9/9 PASSED
> 关联 commit：待提交
> 关联文档：[M计划表-对齐CCB.md §四 M20](../archive/M计划表-对齐CCB.md) · [项目架构.md §构建/测试/运行](../项目架构.md)

---

## 一、背景 / 目标

M18（命令广度 26→37）、M19（记忆服务化）落地后，A 的功能面已大幅对齐 CCB，但**工程基建几乎为零**：

- `npm run lint` 引用 `eslint src/` 却**无 `eslint.config.js`**（ESLint v9 起必须 flat config），lint 直接报错不可用；`format` 指向 `prettier` 也无配置。
- 构建只有 `tsc`（慢、产出含 `.d.ts`/map 体积大）。
- 无任何冒烟脚本、无 pre-commit 钩子、无 CI。

M20 目标（计划表 §四）：CI + pre-commit + 构建升级 + 冒烟，坚守"纯 TS / Node 可跑 / 易读"。

---

## 二、改动明细

### 20.5 Biome 替换坏掉的 ESLint+Prettier — `biome.json`（新）

- 装 `@biomejs/biome@2.5.1`，卸载 `eslint`/`prettier`。
- 配置按**项目现有风格**：2 空格、双引号、分号、`lineWidth:100`、`trailingCommas:all`。
- 初次 `biome check src` 爆出 222 错 + 380 警。按"**真 bug 留、风格洁癖关**"收敛：
  - 关掉与刻意风格冲突的高量级规则：`noExplicitAny`(172)、`noNonNullAssertion`(160)、`useTemplate`(75)、`noConfusingVoidType`、`noAssignInExpressions`、`noControlCharactersInRegex`、`noArrayIndexKey`；并把 `noUnusedVariables/FunctionParameters/PrivateClassMembers` 关掉（与 tsconfig 刻意设的 `noUnusedLocals/Parameters:false` 保持一致）。
  - 保留真问题规则并修复：`noUnusedImports`(20)、`useOptionalChain`(6)、`useImportType`、`useConst`、`useParseIntRadix`、`noUselessConstructor` 走 `biome check --write --unsafe` 自动修；`useIterableCallbackReturn`×3（forEach 回调隐式返回 `expect()` 值）包成块体；`useYield`×1（测试里故意抛错不 yield 的 mock）加定向 `biome-ignore`。
- **决策（经用户确认）：立即全量格式化**——`biome format --write` 重排 **120 个文件**（净 −362 行，机械且语义中性，由 tsc + 506 测试兜底），CI 强制 `biome check`。

### 20.3 构建升级 tsc → esbuild — `scripts/build.mjs`（新）

- `bundle:false` **逐文件转译**（1 input=1 output，import 路径原样保留），而非打包/代码分割。理由：CLI 用 Ink+React 19（ESM，动态 require）打包易碎，且 `src/lsp.ts` 用 `createRequire(import.meta.url)`——打包后 import.meta.url 指向 bundle 会破坏模块解析；转译模式每文件各自保留 import.meta.url，运行期模块图与旧 tsc 产出一致。
- 收益：99 文件转译 **~260ms**（远快于 tsc），dist 更小（无 `.d.ts`/map）。类型检查独立交给 `npm run typecheck`。
- `package.json`：`build`→esbuild，新增 `build:tsc`(备用)、`typecheck`(tsc --noEmit)。

### 20.4 冒烟脚本 + CLI 信息旗标 — `scripts/smoke.mjs`（新）+ `cli.ts`

- `cli.ts`：在 `main()` 最前加 `maybeHandleInfoFlags`——`--version/-V`（读 `package.json` 版本）、`--help/-h`（用法），**在 config 加载前打印并 return**（免 API key/网络）。版本号经 `new URL("../package.json", import.meta.url)` 读取（src 与 dist 同在根下一级，两处都对）。
- `cli.ts`：loadConfig 后加空 config 早退出守卫（`if (!modelConfig.provider) return;`）——原先无 key 时只设 `exitCode=1` 却限跛前行，现在确定性快速退出（顺手修隐患，也让冒烟的"管道输入"路径可判定）。
- `smoke.mjs`：一条命令跑 build→`--version`(exit0+semver)→`--help`(exit0+Usage)→**临时 cwd** 无 key 管道输入(优雅 exit≠0 + 报 `LLM_API_KEY`，不挂死)。9 项断言全过。

### 20.2 husky + lint-staged — `.husky/pre-commit`（新）

- `husky init` 设 `core.hooksPath=.husky/_`；`prepare:"husky"` 让 `npm ci` 自动装钩子。
- pre-commit 改为 `npx lint-staged`；`package.json` 的 `lint-staged` 对暂存 `*.{ts,tsx,mjs}` 跑 `biome check --write --no-errors-on-unmatched`。
- 端到端实测：可修问题（未用 import）自动修+重暂存（exit 0）；不可修问题（`useIterableCallbackReturn`）退出 1 **拦截提交**。

### 20.1 GitHub Actions CI — `.github/workflows/ci.yml`（新）

- push/PR→main 触发，Node 20 + npm cache，`npm ci` 后跑 `typecheck → check(biome) → test → smoke` 四道门禁。

### 行尾归一 — `.gitattributes`（新）

- `* text=auto eol=lf` + 二进制白名单。根因：`git checkout -- src/` 在 `core.autocrlf=true` 下把文件还原成 CRLF，biome（lineEnding=lf）逐行报 `␍`。强制 LF 让本地/CI/仓库三处一致；并用 `biome --write` 把工作树残留 CRLF 归一。

---

## 三、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | 通过，0 错误 |
| `npm run check`（biome lint+format） | Checked 146 files，No fixes，**0 error** |
| `npm test`（vitest --dir src） | **506 / 506** 全过（47 测试文件） |
| `npm run smoke` | **9 / 9** 断言 PASSED |
| `npm run build`（esbuild） | 99 文件转译 ~260ms，`dist/cli.js` 保 shebang，0 个 `.d.ts` |
| pre-commit 端到端 | 可修自动修+重暂存；不可修 exit 1 拦截 |

---

## 四、受影响文件

**新增**
- `biome.json`（lint+format 配置）
- `scripts/build.mjs`（esbuild 转译构建）
- `scripts/smoke.mjs`（免 key 冒烟）
- `.husky/pre-commit`（→ lint-staged）
- `.github/workflows/ci.yml`（CI）
- `.gitattributes`（强制 LF）
- `docs/更新日志/20260628-m20-engineering.md`（本文件）

**修改**
- `package.json`（scripts 全改：build/typecheck/lint/format/check/smoke/prepare；卸 eslint+prettier，装 biome/esbuild/husky/lint-staged；加 lint-staged 配置）
- `src/cli.ts`（`--version/--help` + 无 key 早退出 + 1 处 forEach 块体化）
- `src/__tests__/{memory-extract,session-transcript,permissions}.test.ts`（lint 残留修复）
- **120 个源文件**（`biome format` 全量重排，机械、语义中性）
- `docs/项目架构.md`（构建/测试/运行 + 工具链表更新）

**删除**
- 无（eslint/prettier 仅从依赖移除）

---

## 五、设计决策记录

1. **学里子不学壳子** —— 构建用 esbuild **转译**而非 Bun.build/代码分割；CI 单 ubuntu job 而非企业级矩阵；lint 用 Biome 单工具。对齐 CCB 的"有 CI/有构建/有 lint"机制，不引其重型基建。
2. **esbuild 转译（bundle:false）而非打包** —— Ink/React 19 ESM + `createRequire(import.meta.url)` 打包易碎；转译已拿"更快+更小"，且运行期模块图与旧 tsc 一致、零行为漂移。
3. **Biome 规则"真 bug 留、洁癖关"** —— `noExplicitAny`/`noNonNullAssertion` 等是项目刻意选择，关掉避免噪声；`noUnused*` 与 tsconfig 既有取向对齐。
4. **立即全量格式化（用户拍板）** —— 一次性重排 120 文件，换取"全库格式统一 + CI 可强制"；代价是大块机械 diff，由 tsc+506 测试保正确。
5. **冒烟走信息旗标而非真 LLM 调用** —— `--version/--help` 免 key、确定性、秒级，CI 可稳定复跑；真模型调用需密钥且不稳定，不入冒烟。
