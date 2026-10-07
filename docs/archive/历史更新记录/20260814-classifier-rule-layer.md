# 更新日志 — 权限分类器规则层（Phase C2）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：权限分类器（`src/classifier-rules.ts` + `src/permissions.ts` + `src/cli.ts`）
> 主题：从 claude-code `yoloClassifier` 移植「allow/soft_deny/environment 规则层」，让权限分类器从硬编码单提示词变成可配置规则驱动
> 状态：已落地（规则层 + 分类器接线 + 6 测试）
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/classifier-rules.test.ts` 6/6、全量 1112/1112
> 关联 commit：待提交
> 关联文档：[参考源码移植路线图](../reports/参考源码移植路线图.md)（Phase C）

---

## 一、背景与研究结论

研究参考源码发现两个事实：

1. **bash 分类器是 ANT-ONLY 桩** —— `utils/permissions/bashClassifier.ts` 里 `getBashPromptAllowDescriptions` 返回 `[]`、`classifyBashCommand` 返回 "feature disabled"，真正的规则/提示词被从泄露的 npm 包里剥离了，**无法直接移植**。
2. **yoloClassifier（auto-mode 分类器）的结构是真实的、可移植的** —— `AutoModeRules = { allow, soft_deny, environment }`，默认规则 + 用户覆盖（分节 REPLACE 语义）+ 结构化提示词（带 tagged 段落注入）。

所以 C2 的落点是：把「分类器规则层」这个**结构**移植过来，让 Phase 1 做的 auto mode 从黑盒单提示词变成可配置、规则驱动的分类器。

---

## 二、移植内容

### `src/classifier-rules.ts`（新）

- `ClassifierRules` 类型（allow / soft_deny / environment 三类字符串数组）。
- `DEFAULT_CLASSIFIER_RULES`（自有合理默认——参考的具体规则是桩，默认值是我们自己定的基线）。
- `buildClassifierPrompt(rules)`：把三类规则注入结构化提示词（带 `[ALLOW]`/`[SOFT_DENY]`/`[ENVIRONMENT]` 段 + "err on the side of blocking" 指引）。
- `mergeClassifierRules(defaults, user)`：分节 REPLACE（非空覆盖，空/缺省沿用默认）。
- `parseClassifierRules(json)`：从 `CCR_CLASSIFIER_RULES` JSON 解析用户规则（best-effort）。

### `src/permissions.ts`

`classifyPermissionRisk` 读 `classifier.rules`，有规则时用 `buildClassifierPrompt` 替代硬编码 `CLASSIFIER_SYSTEM_PROMPT`。

### `src/types.ts`

`PermissionClassifier` 增加可选 `rules?: ClassifierRules`。

### `src/cli.ts`

启动时 `mergeClassifierRules(DEFAULT_CLASSIFIER_RULES, parseClassifierRules(process.env.CCR_CLASSIFIER_RULES))`，注入分类器。

### 测试 `src/__tests__/classifier-rules.test.ts`（6 用例）

规则注入 / 空段 `(none)` / 分节 REPLACE / 空覆盖沿用默认 / JSON 解析 / 非法输入 null。

---

## 三、设计决策记录

1. **只移植结构、不移植具体规则** —— 参考的默认规则是 ANT-ONLY 剥离的，所以 `DEFAULT_CLASSIFIER_RULES` 是我们自己的基线；可移植的是「三类规则 + 分节 REPLACE + tagged 注入」这套结构。
2. **保留现有 VERDICT 格式** —— 分类器仍返回 `BLOCK|reason` 文本（已有测试、已工作），不改成参考的 `classify_result` 工具结构化输出（那需要 `callModel` 支持 tool call，改动面更大）。
3. **用户覆盖走 env** —— 用 `CCR_CLASSIFIER_RULES` JSON 而非 settings 文件，避免再引入一套配置解析（与项目其它 env 配置风格一致）。
4. **投机式分类不做** —— 参考里分类器与 pre-tool hook 并行隐藏延迟；本项目分类器是同步的、无前置 hook 可并行，暂无隐藏对象，留待需要时再补。
