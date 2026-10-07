# 更新日志 — `/provider` 多 API 端点档案热切换

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-28
> 类型：feature
> 模块：provider 路由 / 配置（`provider-profiles.ts` · `commands/provider.ts` · `llm-adapter`/`cli.ts` caller 分发 · TUI overlay）
> 主题：在中转站 / 国内 API 开放平台之间会话内热切换 `(provider, baseURL, apiKey, model)`，免改 `.env`、免重启。
> 状态：已落地
> 验证：`npm run typecheck` 0 错；`npm run check`(biome) 干净；`npm test` **630/630**（+17）；`npm run smoke` PASSED
> 关联 commit：待提交
> 关联文档：[项目架构.md §LLM 适配层 / §配置源 / §10 命令目录 / §12 TUI](../../项目架构.md) · [快速开始.md §多 API 端点](../../快速开始.md) · [20260627-M计划表-对齐CCB.md §六 M22](../20260627-M计划表-对齐CCB.md)

---

## 一、背景 / 用户反馈

用户日常在**中转站**与**国内 API 开放平台**（DeepSeek/Qwen/Moonshot/Zhipu）间频繁切换。这些后端**全部 OpenAI 兼容**，差异只是 `(provider, baseURL, apiKey, model)` 四元组。原状：

- `.env` 只存**一套**配置，切换要改文件并**重启**。
- `/config` 只读；`/model <id>` 只能换 model，换不了 baseURL / apiKey / provider。

起因是用户问「M22（多 provider 原生化：Bedrock/Vertex/Gemini/Grok adapter）有无必要做」。结论：**M22 对该场景零增量**（那几家也都有 OpenAI 兼容端点，改 baseURL 即可），其真正难点 SigV4/ADC 签名又明确不做。用户真正需要的是「多档案 + 一键热切换」，故不实现 M22，改做本特性。

---

## 二、设计要点（机制）

| # | 机制 | 位置 | 说明 |
|---|------|------|------|
| 1 | 配置引用传递、热改生效 | `agent-loop.ts:148`、`llm-adapter.ts:100-106` | `callModel` 每轮把**同一个** `modelConfig` 引用传入 caller，caller **调用时**才读 `apiKey/baseURL/model` → 原地改即生效（`/model` 早已如此） |
| 2 | provider 家族切换需重解析 caller | `llm-adapter.ts:254` `createModelCaller` | 原 `cli.ts` 启动时定死一个 caller，改 `provider` 不换函数 → anthropic↔OpenAI 兼容切不动 |

**修法：** 把 `cli.ts` 的 `callModel` 包成「每次调用按 `cfg.provider` 现解析」的薄封装，分支只是函数引用查找，开销可忽略。切换本身 = `resolveProviderConfig(档案)` → `Object.assign(modelConfig, resolved)` 原地改共享引用。

---

## 三、改动明细

### `src/provider-profiles.ts`（新，131 行）

纯逻辑、易测：`loadProviderProfiles(workspaceRoot)`（读 `.claude/providers.json`，缺文件/坏 JSON/坏结构一律返回 `[]`，无 `name` 的项跳过、未知 provider 丢弃）、`findProfile`（精确大小写不敏感 → 唯一前缀）、`applyProfile`（`resolveProviderConfig` 回填默认 + `Object.assign` 原地改；缺 apiKey 沿用当前，保留 maxTokens/temperature/options）。

### `src/commands/provider.ts`（新，92 行）+ `registry.ts`

`/provider`：带参 → `findProfile` 直切；无参 + TTY → `promptSelectMenu` 方向键；无参 + 非 TTY（管道/CI）→ 文本列表（不阻塞）；无档案 → 打印创建示例。在 `registry.ts` 三步注册（import + 推入 `COMMANDS`，置于 `pr` 之后）。

### `src/cli.ts`

`callModel` 改为按 provider 动态分发的薄封装（见 §二修法）；补 import `ModelCaller`。

### TUI overlay（仿 `/resume` 既有范式）

- `tui/store.ts`：`Overlay` 增 `providerPicker` 变体 + `ProviderPickerItem` 接口 + `pickProvider()` + `setModelLabel()`。
- `tui/ProviderPicker.tsx`（新，97 行）：方向键档案列表，复用 `SessionPicker.nextOffset` 滚动窗口。
- `tui/App.tsx`：overlay 渲染分支加 `providerPicker`。
- `tui/run.tsx`：`onSubmit` 特判裸 `/provider` → `runProviderPicker`（加载档案 → `pickProvider` → `applyProfile` 原地改 → `setModelLabel` + notice）。

### 安全 / 模板 / 文档

`.gitignore` 加 `.claude/providers.json`（含明文 key）；新增可提交模板 `.claude/providers.json.example`；`.env.example` 加指引；`项目总览.md`/`项目架构.md`/`快速开始.md` 同步。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run check`（biome） | 干净（import 排序经 `--write` 规整） |
| `npm test` | **630 / 630** 全过（新增 `provider-profiles.test.ts` 17 例：load 缺文件/坏 JSON/坏结构/跳过无名/丢未知 provider；find 精确/前缀/歧义/空；apply 原地改/默认回填/沿用 key/默认 provider/保留参数/**切家族后 caller 不同**） |
| `npm run smoke` | PASSED（build + --version + --help + 无 key 优雅失败） |

---

## 五、受影响文件

**新增**
- `src/provider-profiles.ts`（档案加载 + applyProfile）
- `src/commands/provider.ts`（`/provider` 命令）
- `src/tui/ProviderPicker.tsx`（TUI 选择 overlay）
- `src/__tests__/provider-profiles.test.ts`（17 例）
- `.claude/providers.json.example`（可提交模板）

**修改**
- `src/cli.ts`（callModel 动态分发 + import）
- `src/commands/registry.ts`（注册）
- `src/tui/store.ts`（providerPicker overlay + pickProvider + setModelLabel）
- `src/tui/App.tsx`、`src/tui/run.tsx`（渲染分支 + runProviderPicker + 裸命令特判）
- `.gitignore`、`.env.example`、`docs/{项目总览,项目架构,快速开始}.md`

---

## 六、设计决策记录

1. **不做 M22** —— 用户面「多后端切换」由档案覆盖（都是 OpenAI 兼容，改 baseURL 即可）；M22 的云网关 adapter 收益低、且不含签名，与本需求正交。降为「按需」。
2. **档案文件而非扩展 `.env`** —— 一套 `.env` 存不下多组配置；`.claude/providers.json` 存数组并 gitignore，模板可提交。
3. **caller 每次调用现解析** —— 而非 `/provider` 时重建闭包。重建要回灌 REPL/TUI 多处持有的 `callModel`，易漏；现解析是一行薄封装、开销可忽略、覆盖全部 provider 家族。
4. **双前端沿用 `/resume` 范式** —— TUI 在 `handleSlashCommand` 之前特判裸命令走 store overlay（避免裸 ANSI 污染 Ink 帧）；行 REPL 走命令自身（TTY 用 `promptSelectMenu`，管道退化为文本列表防挂起）。
5. **只读 + 切换，不在 TUI 内增删档案** —— 增删档案手动编辑 `providers.json`，控制本期范围。
