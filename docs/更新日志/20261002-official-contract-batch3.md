# 2026-10-02 官方工具契约缺口收尾（Workflow / Agent / NotebookEdit）

## 背景

上一轮把官方工具**名称**统一到解析期（`resolveTool`）之后，剩下三处
**参数级**契约差异。这三处都不是"少个参数名"，而是官方形状的调用会直接被
zod 严格校验拒绝，或者（NotebookEdit）能通过但会改错单元格。

本轮一次处理这三项。

## 变更

### 1. NotebookEdit：实现 `cell_id`（真正实现，不是别名）

官方 `cell_id` 是**内容寻址**的单元格 id（nbformat 4.5+ 的 `id` 字段），本项目
长期使用 0 基下标 `cellIndex`。上一轮明确拒绝把二者做别名——那会在笔记本被
重排序后**静默改错单元格**。

本轮改为**实现**真正的 `cellId` 寻址，随后 `cell_id` 才成为安全别名：

- `cell_id` → 按 id 查找单元格；未命中则报错并指出未命中，**绝不退化成按下标取**。
- 插入语义对齐官方：新单元格插在目标单元格**之后**；两者都不给时**插到最前面**
  （官方 `cell_id` 缺省即为开头）。
- `cellIndex` 由必填改为可选；两者都给时显式下标优先。
- 插入的单元格会**铸造新 id**（`[a-zA-Z0-9-_]`，避让已有 id），使其下一轮
  可被 `cell_id` 寻址，同时保持 nbformat 4.5+ 合法。
- 非 insert 操作缺 `cell_id`/`cellIndex` 时给出明确报错。

回归测试 `notebook-edit-cell-id.test.ts` 显式钉住不变量：`cell_id: "0"` 不得被
当成第 0 个单元格。

### 2. Workflow：补齐 `script` / `scriptPath` / `title`，放宽 `args`

- `script` 作为官方拼写别名到 `plan`。但官方 `script` 是 **JS 模块**
  （`export const meta = …` + `agent()/parallel()`），本项目求值的是 **JSON 数据**。
  因此 `call()` 对不以 `{` 开头的 plan 返回**专门报错**，而不是让 JS 脚本死在
  `JSON.parse` 的 "Unexpected token" 上。
- 新增 `scriptPath`：从工作区内文件读取 plan（官方 `scriptPath` 语义，优先于
  `plan`）。走与其他读文件工具相同的路径收敛（`resolveInWorkspace` +
  `isBlockedPath`），模型给出的绝对路径不能读出沙箱；另有非文件、大小上限检查。
- 新增 `title`：官方标注 "Ignored"，照此接受并丢弃，使官方形状调用能通过严格校验。
- `args` 由 `z.string()` 放宽为 `string | object`。下游 `WorkflowOptions.args`
  本来就是 `unknown`，纯属 schema 过窄。
- `description` 由**必填改为可选**：它此前是必填却从未被 `call()` 读过，调用方
  被迫编造一个运行时直接丢弃的值。官方同样忽略它且可选。
- 工具**不再有任何必填参数**，与官方 `WorkflowInput` 全可选一致。

### 3. Agent：新增 `mode`，并加上权限收紧不变量

- 新增官方 `mode`（六值枚举），可覆盖 agent 定义与继承的会话模式。
- **安全不变量**：调用 `mode` 的一方是**模型**。模型改不了会话模式，但
  `mode: "bypassPermissions"` 会让其子代理获得超过用户授予本会话的权限。
  因此按授予权限排序（`plan < dontAsk < default < acceptEdits < auto <
  bypassPermissions`），**子代理只能收紧、不能放宽**；放宽请求**明确报错**
  而非静默降级，以免模型误以为生效。
- 接受并忽略 `team_name`（官方标注 "Deprecated; ignored"）。
- **不**新增 `name`：官方用 `SendMessage({to: name})` 寻址，本项目没有团队
  子系统，接受却无法兑现属于"广告不存在的行为"。

## 刻意未做

- `Agent.name`、`Workflow.name`（内置/`.claude/workflows/` 命名工作流注册表）。
- 版本号仍为 `1.6.1`。

## 验证

- `npm run typecheck` ✅ 0 错误
- `npx biome check src --diagnostic-level=error` ✅ 0 错误
- `npm test` ✅ **2289/2289，184 文件，0 失败**
- `npm run build` ✅ · `npm run smoke` ✅ · `doc-sync --check --with-tests` ✅

新增测试 25 条：`notebook-edit-cell-id.test.ts`（11）、`agent-workflow-official-params.test.ts`（14）。
`official-params.test.ts` 中原先断言"`cell_id` **不得**被别名"的那条已随实现
改为断言别名成立——拒绝它的理由被保留在新测试里。

### 过程中被探针抓出的两个真 bug

1. `cell_id` 加进 zod schema 但没进别名表 → 官方拼写仍然 "Unrecognized key"。
2. 别名机制把 `plan` 的**必填**搬到了 `script` 上，导致官方 `script` 变成必填、
   而 `scriptPath`-only 的合法调用反而报 "script: Required"。已把 `plan` 改为可选，
   把"至少给一个"的要求移进 `call()`。

## 已知既有问题（非本轮引入）

`session-memory.test.ts > two instances saving the same session concurrently leave
an intact file` **是 flaky 的**：本轮一次全量跑失败、单跑重跑通过。属并发保存
竞态，与本轮改动无关，建议单开一轮处理。