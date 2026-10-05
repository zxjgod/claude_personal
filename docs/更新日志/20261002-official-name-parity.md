<!--
  复制本文件，按 README 的命名规则改名：YYYYMMDD-<英文短横线主题>[-fix|-analysis].md
  填完后在 docs/更新日志/README.md 的「按日期」与「按模块」两张索引各登记一处。
  删掉本注释与所有〈占位说明〉。
-->

# 更新日志 — 官方工具名对齐 + Grep context/offset

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-10-02
> 类型：fix
> 模块：tool-executor、tools/registry、tools/utils、subagents、permission-policy、GrepTool
> 主题：官方工具**名**（`Read`/`WebFetch`/`TodoWrite`）全链路可解析；补齐 Grep 官方 `context`/`offset`
> 状态：已落地
> 验证：`npm run typecheck` 0 错误、`npm run check` 0 error、`npm test` 2264/2264 全过（182 文件，0 失败）、`npm run build` 266 文件、`npm run smoke` PASSED
> 关联文档：`docs/更新日志/20261002-official-param-parity.md`（前一轮：官方**参数名**对齐）

---

## 一、现象

前一轮统一了官方**参数名**（`file_path` 等）。本轮审查发现同一类缺陷的另一半：官方**工具名**完全无法解析。

实测（`executeSingleTool` 探针）：

```
read               -> OK
Read               -> ERR: Error: Tool "Read" is not available.
WebFetch           -> ERR: Error: Tool "WebFetch" is not available.
TodoWrite          -> ERR: Error: Tool "TodoWrite" is not available.
TaskOutput         -> ERR: Error: Tool "TaskOutput" is not available.
subagent [Read, Grep]           -> read
subagent [TodoWrite]            -> (none)
subagent [TaskOutput]           -> (none)
subagent [WebFetch]             -> web_fetch
```

一个使用官方命名的模型**一个工具都跑不起来**。子代理 `tools:` frontmatter 里写 `TodoWrite` / `TaskOutput` 解析为空集。

---

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | 6 处工具查找全为精确匹配 `tools.find(t => t.name === name)` | `tool-executor.ts`×2、`anthropic-adapter.ts`、`llm-adapter.ts`、`streaming-tool-executor.ts`、`speculation.ts` | 官方名一律 `Tool "X" is not available.` |
| 2 | 子代理 `tools:` 解析自带一份**私有** camel→snake 规则，且无 `TodoWrite`/`TaskOutput` 映射 | `subagents.ts` `resolveSubagentTools` | 官方 frontmatter 写 `TodoWrite` 解析为空集 |
| 3 | 权限规则匹配走**另一份**手维护别名表（`TOOL_ALIASES`） | `permission-policy.ts` `canonicalToolName` | 与执行路径**各说各话**：规则能匹配到、执行却找不到 |
| 4 | Grep 缺官方 `context`（= 我们的 `-C`）与 `offset`（跳过前 N 条） | `tools/core/grep.ts` | 官方 `GrepInput` 声明的两项能力不存在 |

**机制：** 缺陷 3 最隐蔽——上轮审查把它记为"仅在 permission-policy 规则匹配中归一化"，属**已知欠债**。三套命名逻辑（执行 / 子代理 / 权限）各自演化，导致 `WebFetch` 规则命中了 `web_fetch` 工具、但执行阶段拒绝该名字。任何一处补齐都不够，必须收敛成**单一解析器**。

---

## 三、改动明细

### 新增 `src/tools/utils/official-names.ts`

`official-params.ts` 的孪生模块，处理工具**名**。两个函数：

```ts
export function canonicalToolKey(name: string): string {
  const trimmed = name.trim();
  const alias = OFFICIAL_TOOL_NAME_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function resolveTool<T extends { name: string }>(name: string, tools: T[]): T | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const key = canonicalToolKey(name);
  return tools.find((t) => canonicalToolKey(t.name) === key);
}
```

要点：

- **精确匹配优先**，常见路径零分配、绝不多余；无法解析时返回 `undefined`，调用方继续报 `Unknown tool: X`，绝不静默替换成别的工具。
- **别名表是"词边界"权威**。`webfetch → web_fetch` 无法推导——不预知词边界就无法区分 `webfetch` 是 `web_fetch` 还是 `webfetch`。表按"小写无分隔"的官方名索引，于是 `WebFetch` 与 `webfetch`（权限规则常用后者）共用一条。
- 仅收**词级别**不同的条目（`TodoWrite→todo`、`TaskOutput→job_output`、`ListMcpResources→mcp_list_resources`）。仅大小写不同的（`Read`/`NotebookEdit`/`ExitPlanMode`/`EnterWorktree`…）交给 camel→snake 兜底，故**刻意不入表**。

### 6 处查找点收敛

`tool-executor.ts`（`callIsConcurrencySafe` + `executeSingleTool`）、`anthropic-adapter.ts`、`llm-adapter.ts`、`streaming-tool-executor.ts`、`speculation.ts` 全部改用 `resolveTool`。

> 连带修正：`callIsConcurrencySafe` 若停留在精确匹配，官方命名的调用会被**强制串行**执行，并行度静默下降。

### `permission-policy.ts` 删表

`TOOL_ALIASES`（13 条）被 `canonicalToolKey` 取代。13 条全部可由兜底规则或新表覆盖，故这是**净删减**，同时消除了"两处各说各话"。

### `subagents.ts` 改用 `canonicalToolKey`

私有 `canonical` 函数删除。`TodoWrite` / `TaskOutput` 随之可解析（分号命令由既有 `mcp__*` 前缀分支处理，未动）。

### Grep `context` / `offset`

- `context` 入 `OFFICIAL_PARAM_ALIASES`：`grep: [{ official: "context", internal: "-C" }]`。官方 `context` 就是 `-C`（前后各 N 行），语义完全相同，故走别名而非重命名。
- `offset` 是**真实新能力**，两条路径各自实现：

```ts
// ripgrep 路径
const skip = Math.min(Math.max(0, input.offset ?? 0), rawLines.length);
const windowed = rawLines.slice(skip);
const truncated = windowed.length > headLimit || sizeCapped;
const lines = windowed.slice(0, headLimit);
```

Node 兜底路径有**独立的收集循环**，必须多收 `skip` 条，否则末页会比 `head_limit` 短：

```ts
const skip = Math.max(0, input.offset ?? 0);
const collectLimit = skip + headLimit;   // 循环内所有 headLimit 比较改为 collectLimit
```

`files_with_matches` / `count` 模式同样按 `skip` 切片。`summary` 计数用 `windowed.length`（偏移之后的量），`truncated` 用 `windowed.length > headLimit`——末页为完整结果，不误报截断。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run check`（Biome） | **0 error**（8 个 error 全部出自我本轮新增的 import 顺序/格式，已修） |
| `npm test` | **2264 / 2264 全过**，182 文件 0 失败（较上轮 +26 用例） |
| `npm run build` | 通过，266 文件 |
| `npm run smoke` | PASSED |
| 探针复测 | `Read` / `WebFetch` / `TodoWrite` / `TaskOutput` 全部落到正确工具；子代理 `TodoWrite→todo`、`TaskOutput→job_output` |
| 新增回归 | `official-tool-names.test.ts` 15 例（canonical 推导 / 词级别重命名 / 连字小写 / 精确优先 / 未知名不替换 / 执行 / 并行安全 / 子代理 / 规则与执行一致） |
| Grep 回归 | ripgrep 路径 4 例 + **Node 兜底路径 1 例**（兜底有独立循环，必须单独覆盖） |

### 过程中修掉的自身错误（保留记录）

- 误删 `TOOL_ALIASES` 的连字小写条目 → 3 个权限测试回归。教训：`webfetch`（无分隔）**无法**由 camel 拆分推导，别名表不可省。
- 新测试 4 处断言错误，全部源于 `formatted` 末尾附 `[12ms]` 耗时尾巴（污染行数与相等比较）与 `truncated` 挂在 `result` 而非包装对象上。产品代码无误。
- `files_with_matches` 跨调用比较位置**天然 flaky**：两次独立 rg 调用的文件顺序不稳定（readdir 序）。改为集合断言。

---

## 五、受影响文件

**新增**
- `src/tools/utils/official-names.ts`（工具名 canonical 解析器）
- `src/__tests__/official-tool-names.test.ts`（15 例回归）
- `.github/workflows/ci.yml`、`.gitignore`（见 §七）

**修改**
- `src/tool-executor.ts`、`src/anthropic-adapter.ts`、`src/llm-adapter.ts`、`src/streaming-tool-executor.ts`、`src/speculation.ts`（查找点改用 `resolveTool`）
- `src/permission-policy.ts`（删 `TOOL_ALIASES`，委托 `canonicalToolKey`）
- `src/subagents.ts`（删私有 canonical，改用共享解析器）
- `src/tools/core/grep.ts`（`offset` 真实实现 + `context` 提示）
- `src/tools/utils/official-params.ts`（新增 `grep: context→-C`）
- `src/__tests__/official-params.test.ts`、`src/__tests__/grep-security-fallback.test.ts`（Grep 回归）

**删除**：无

---

## 六、设计决策记录

1. **保留本项目工具名，不改名** —— 官方名只在**解析时**被接受，对外仍注册 `web_fetch` 等。改名会波及 49 个工具、hook、权限存储、配置与文档，收益仅是"看起来更像"。`official-params` 的做法一致：官方拼写进 schema，本地拼写留在内部。
2. **`resolveTool` 精确优先** —— 万一同名工具与官方别名指向不同工具，精确匹配是确定行为，别名不参与。绝不做"总是走别名"的模糊匹配。
3. **别名表只收词级别差异** —— 63 个名字里 20 条入表，其余走推导。表越小越不容易过期；把 `read→read` 这类写进表只会变成必须同步维护的第二处真相。
4. **未知名仍报错** —— 解析失败返回 `undefined` 而非最接近的匹配。静默替换会让模型收到"成功"结果却执行了别的工具，比报错危险得多。
5. **不引入 `NotebookEdit.cell_id`** —— 官方是内容寻址 id、本项目是 0 基索引，映射会**静默改错单元格**。留作独立实现。

---

## 七、顺带闭环：两个"环境问题"其实是文件丢失

上轮记为"环境缺口"的两件事，根因相同——主树缺少 `.claude/upgrade-baseline/` 快照里**存在**的文件：

| 现象 | 根因 | 处理 |
|---|---|---|
| `ci-smoke.test.ts` ENOENT 失败 | 主树无 `.github/workflows/ci.yml` | 按真实 `package.json` 脚本补齐（typecheck → check → test → smoke） |
| `npm run check` 必失败 | `biome.jsonc` 的 `useIgnoreFile: true` 需要 `.gitignore`，主树没有 | 补齐 `.gitignore` |

补 `ci.yml` 时踩到一个**自造**的坑：`scripts/architecture-docs.mjs` 硬性要求 CI 同时覆盖 `ubuntu-latest` 与 `windows-latest`，我第一版只写了 ubuntu。

> 该要求是对的、不是刁难：本项目主 shell 就是 cmd.exe，ripgrep 的 `execFile` argv 路径、路径包含性检查、smoke 都有平台相关行为（grep.ts 里那段"Unix 单引号在 cmd.exe 下不成立、故曾静默回退"的注释正是此故）。故改为 `matrix.os`，**两个平台都是必过项**。

`.gitignore` 已特意排除 `.claude/upgrade-baseline/`（含完整 `node_modules` 的全量项目副本）、`.claude/worktrees/`（4 个上一轮循环残留）、`.review-tmp/`（本轮探针目录）。

**结论：`npm test` 首次全绿（182 文件 0 失败）。** 未伪造任何配置来消音——补的是按真实脚本写的可用配置，且随后被 `architecture-docs.mjs` 与 `ci-smoke.test.ts` 双向校验。

---

## 八、仍未处置

- `NotebookEdit.cell_id`（需实现内容寻址 cell id，非别名可解）
- `Workflow` 缺 `name` / `title` / `scriptPath`；官方用 `script`，本项目用 `plan`
- `Agent` 缺 `name?` / `team_name?` / `mode?`
- `Bash.dangerouslyDisableSandbox`（既有"刻意收窄沙箱"决策）、`Read.pages`（真实缺口）
- 官方缺失工具 `Projects` / `Monitor` / `Artifact` / `PushNotification` / `RemoteTrigger` / `ShowOnboardingRolePicker`（多为托管/生态侧，个人轻量用途优先级低）
- 版本号仍为 `1.6.1`（本轮含 feature，未单独 bump）
