# 更新日志 — 上下文压缩：按工具类型选择性清除（Phase B1）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：上下文压缩（`src/context-pipeline.ts`）
> 主题：从 claude-code `microCompact.ts` 移植「按工具类型选择性清除」——只清 bulk I/O 工具结果，保护语义工具（Task/Skill 等）
> 状态：已落地（`COMPACTABLE_TOOLS` + 两层过滤 + 2 测试）
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/context-pipeline.test.ts` 15/15、全量 1117/1117
> 关联 commit：待提交
> 关联文档：[参考源码移植路线图](../参考源码移植路线图.md)（Phase B）

---

## 一、背景与研究结论

项目已有 5 层轻→重压缩（边界裁剪 → 字节预算 → microcompact → 可恢复 stash → LLM 摘要）。对照参考 `services/compact/microCompact.ts` 发现一个缺口：**你的 `microcompact` 无差别清空所有工具结果**，而参考用 `COMPACTABLE_TOOLS` 集合**只清除 bulk I/O 工具的结果**，保护语义工具。

参考的关键区分（`apiMicrocompact.ts`）：
- **可清除结果**（Read/Grep/Glob/WebFetch/WebSearch/Shell）—— 结果是大块 dump，可重取。
- **可清除用途**（Edit/Write/NotebookEdit）—— 编辑参数可重推。
- **不可清除**（Task/Skill/AskUserQuestion 等）—— 子代理报告、加载的指令丢失了没法重取。

---

## 二、改动

### `src/context-pipeline.ts`

- 新增 `COMPACTABLE_TOOLS` 集合（read/write/edit/multi_edit/notebook_edit/glob/grep/bash/powershell/web_fetch/web_search/lsp_diagnostics/lsp_completions）。
- `applyToolResultBudget`（层 2，head/tail 裁剪）与 `microcompact`（层 3，整块清除）都加了 `if (!COMPACTABLE_TOOLS.has(m.name ?? "")) continue;` —— **语义工具（Task/Skill/AskUserQuestion 等）的结果不再被裁剪/清除**。

### 测试 `context-pipeline.test.ts`（+2）

- `microcompact` 保护 task 结果、清除 read 结果。
- `applyToolResultBudget` 同样保护 task 结果（read 被裁剪、task 原样保留）。

---

## 三、设计决策记录

1. **保护语义工具、清 bulk 工具** —— 对齐参考：Task 子代理的报告、Skill 加载的指令一旦清除，模型无法重取（除非重跑子代理/重加载技能）；Read/Grep 的结果只是大块内容，可重取。
2. **两层都加过滤** —— 不只 microcompact（最激进），字节预算的 head/tail 裁剪也保护语义工具，避免"中间内容被剪掉"这种更隐蔽的信息损失。
3. **不做「清除 tool_use 参数」（Edit/Write 用途）** —— 参考还区分"清除 tool_use args"，但那需要改 assistant 消息里的 `tool_calls`，侵入更大、对 OpenAI 兼容 provider 价值低，留作后续。
4. **不做 API 侧 context management（cache_edits）** —— 参考用 Anthropic 原生 `context_management`（`clear_tool_uses` 策略）做服务端清块、保缓存不破；这是 Anthropic 专属，OpenAI 兼容 provider 不支持，不做。

---

## 四、Phase B 收尾

B1 ✅（本日志）、B2 ✅（`dontAsk` + 优先级，`7ce5028`）、B3 成本追踪已按用户要求**砍掉**。Phase B 完成。
