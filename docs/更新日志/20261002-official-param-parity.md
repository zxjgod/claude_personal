# 更新日志 — 官方工具参数名对齐（snake_case）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-10-02
> 类型：fix
> 模块：tools/registry、tools/utils/official-params、hooks-config、Read/Write/Edit/NotebookEdit/WebFetch/JobOutput/LSP 工具
> 主题：官方 `file_path` 等 snake_case 参数此前完全不可用；现作为对外契约的规范名，camelCase 保留为别名
> 状态：已落地
> 验证：`npm run typecheck` 通过、`npm run build` 通过、`npm run smoke` 通过、`npm test` 2,238 项通过 0 失败
> 关联文档：[差距评估](../claude-code差距评估-20261002.md)、[v1.6.1 审查修复](20261002-review-remediation.md)

---

## 一、现象

官方 Claude Code 的工具参数一律是 snake_case（`file_path`、`notebook_path`、
`new_source`、`task_id`），本项目内部是 camelCase（`filePath`、`cellIndex`、
`job_id`）。两者之间没有任何映射层。

用官方安装包（2.1.202）随附的 `sdk-tools.d.ts` 逐个比对后确认，
**产品内调用频率最高的三个工具，用官方拼写会直接失败**：

```
read  {filePath}: OK
read  {file_path} (OFFICIAL): THROWS -> Cannot read properties of undefined (reading 'length')
write {file_path} (OFFICIAL): THROWS -> Cannot read properties of undefined (reading 'length')
edit  {file_path,...} (OFFICIAL): THROWS -> The "paths[1]" argument must be of type string.
```

经执行器（会先 `validateInput`）时表现为 `Unrecognized key: "file_path"` 的
校验失败；直接调用 `.call()` 则是未捕获的 TypeError。

影响面不止于第三方模型：

- 官方文档、Skill、subagent、hook 配置里写的都是 `file_path`；
- Hook 信封里的 `${tool_input.file_path}` 插值取不到值；
- 部分第三方模型（DeepSeek / Qwen / Llama 等）在 Claude 形状的 tool schema
  上训练，会不带提示地直接输出 `file_path`。

这是内核层行为不一致，不是命名风格问题——它让最高频的工具在官方契约下不可用。

---

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | 参数名只有 camelCase 一种拼写 | `src/tools/core/read.ts` 等各工具 zod schema | 官方拼写被 `strictObject` 判为未知键 |
| 2 | 对外 JSON Schema 直接用内部名 | `src/tools/registry.ts` `buildTool` | 模型被告知的参数名与官方契约不一致 |
| 3 | Hook 信封只带内部名 | `src/hooks-config.ts` PreToolUse / PostToolUse | 官方 hook 的 `${tool_input.file_path}` 解析为空 |
| 4 | 校验错误回显内部名 | `src/tools/registry.ts` `validateInput` | 报错说 `filePath: Required`，而 schema 里根本没有这个名字 |

---

## 三、改动明细

### 新增 `src/tools/utils/official-params.ts`

集中声明「官方名 ↔ 内部名」映射，并提供三个纯函数：

- `applyOfficialParamAliases()` —— 对外 Schema 里把**官方名作为规范名**
  （进 `required`），内部名降级为可选别名并在描述里标注；
- `normalizeOfficialParams()` —— 解析前把官方名改写成内部名，不修改调用方对象；
- `hookToolInput()` —— Hook 序列化时同时给出两种拼写；
- `advertisedParamName()` —— 校验报错回显模型实际看到的名字。

已覆盖：`read` / `write` / `edit` / `multi_edit` 的 `file_path`；
`notebook_edit` 的 `notebook_path`/`new_source`/`cell_type`/`edit_mode`；
`web_fetch` 的 `prompt`；`job_output` 的 `task_id`/`block`/`timeout`；
三个 LSP 工具的 `file_path`。

### `src/tools/registry.ts` `buildTool`

生成 Schema 后套用别名重命名，`validateInput` 在 `safeParse` 前先归一化。

**安全性**：归一化发生在 `validateInput` 内，而执行器的顺序是
`validateInput` → `checkPermissions` → `tool.call`，因此权限判定与 `getPath`
拿到的都是已归一化的输入——别名不可能绕过路径边界。回归用例
`still blocks an official-named path outside the workspace` 固定这一点。

**Schema 缓存**：原缓存以 schema 对象身份为键，而生成结果现在还依赖工具名，
改为 `WeakMap<schema, Map<name, schema>>`，避免两个工具共用一个 schema 对象时串味。

### `src/hooks-config.ts`

`tool_input` 改用 `hookToolInput(toolName, input)`，官方 hook 的
`${tool_input.file_path}` 可直接解析。只在序列化边界展开，执行器内部对象不变，
所以 Hook 改写输入后仍会按真实 schema 复验。

### 工具 `promptDescription`

`read`/`write`/`edit`/`multi_edit`/`notebook_edit`/`web_fetch`/`job_output`/
LSP 工具的提示词改为官方名优先，避免系统提示与 JSON Schema 自相矛盾。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm test` | **2,238 项通过，0 失败**（181 个文件中 180 通过） |
| `npx vitest run src/__tests__/official-params.test.ts` | 20 / 20 全过 |
| `npm run build` | 通过，265 文件转译 |
| `npm run smoke` | 6 步全过 |

新增回归 `src/__tests__/official-params.test.ts`（20 例），覆盖 Schema 形态、
归一化、报错文案、Hook 信封，以及经执行器的真实读写（含工作区外路径仍被拒绝）。

**已知失败（与本次改动无关）**：`ci-smoke.test.ts` 读 `.github/workflows/ci.yml`
报 `ENOENT`——本工作区没有 `.github/` 目录（`.git` 同样不存在）。属既有环境
缺失，非本轮引入，未在此轮补造 CI 配置。

---

## 五、受影响文件

**新增**
- `src/tools/utils/official-params.ts`（官方参数名映射与归一化）
- `src/__tests__/official-params.test.ts`（20 项回归）

**修改**
- `src/tools/registry.ts`（`buildTool` 套用别名、报错回显、缓存键改为 schema+name）
- `src/hooks-config.ts`（`tool_input` 双拼写）
- `src/tools/core/read.ts`、`write.ts`、`edit.ts`（提示词对齐）
- `src/tools/breadth/index.ts`（notebook_edit / LSP 提示词对齐）
- `src/tools/extended/web-fetch.ts`、`jobs.ts`（提示词对齐）

---

## 六、设计决策记录

1. **官方名作为对外规范名，内部名降为别名** —— 反过来做（内部名规范、官方名
   别名）改动更小，但系统提示会继续教模型输出官方文档里不存在的名字，与
   「向官方对齐」的目标相反。
2. **归一化放在 `validateInput` 而非各工具 `call` 内部** —— 单点接入，且天然
   早于权限判定；同时把「别名不是绕过通道」变成结构保证而非约定。
3. **两拼写同时出现时内部名优先** —— 二者语义相同，取其一比抛错更好；官方名
   副本被丢弃，避免 `strictObject` 因多余键拒绝。
4. **不映射语义不同的官方参数** —— NotebookEdit 的 `cell_id` 是内容寻址 id，
   本项目是 0 基下标，强行映射会静默改错单元格；Grep 的 `context` / `offset`
   是尚未实现的真实功能，宣告它们等于许诺不存在的行为。两者都留待后续单独实现。

---

## 七、本轮后续可做（未做）

- Grep 补 `context` / `offset`，Workflow 补 `name` / `title` / `scriptPath`，
  Agent 补 `name` / `team_name` / `mode`——这些是官方有、本项目缺的**能力**，
  不是拼写问题，需要单独设计与实现。
- 工具**名**本身（`web_fetch` vs `WebFetch`）目前只在 `permission-policy` 的
  规则匹配里归一，执行与工具可见性仍是各自一套命名。
- 官方 `Bash.dangerouslyDisableSandbox`、`Read.pages` 未接入；前者属既有
  沙箱收窄取舍，后者是真实缺口。