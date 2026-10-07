# TUI 官方对齐 — 批次 A（视觉骨架）完成报告

> 日期：2026-09-06
> 方案：[TUI官方对齐方案](../reports/20260906-TUI官方对齐方案.md) 批次 A（用户决策 1-A / 2-A / 3-A / 4-A / 5-B）
> 结果：**完成并通过两轮代码审查 + 用户真机验收**；测试 1438 → 1476（110 文件全绿），tsc/lint/build 通过。
> 信息源：官方 claude 2.1.202 二进制键位/文案提取 + 官方反编译源码（REPL/PromptInput/theme/Spinner）+ 官方文档 interactive-mode/statusline 页。

---

## 一、交付清单

| 项 | 内容 | 主要文件 |
|---|---|---|
| A1 官方字形/主题 | figures.ts（⏺/❯/⎿/⏵⏵/⏸/▔，Windows ● 分支）；palette 补 promptBorder/bashBorder/permission/warning token + 模式色（暗色可读的官方 dark 等效色） | `tui/figures.ts`(新) `tui/theme.ts` |
| A2 输入框 | 官方圆角框（手绘 ╭╮╰╯ 行——Ink 无侧边框不出角）；❯ 提示符；多行超过 max(3, rows/2−2) 框内滚动（光标锚定窗口，↑/↓ 双向裁剪指示） | `tui/InputBox.tsx` |
| A3 底部信息行 | 新 PromptFooter（左列优先级链 `esc to interrupt` > 模式指示 > `? for shortcuts`；右列 模型 · ctx剩余% · queued N，窄终端逐级降级）；删除 StatusBar（tokens/cost 移至 /cost /tokens） | `tui/PromptFooter.tsx`(新)，删 `tui/StatusBar.tsx` |
| A4 消息渲染 | 用户消息 dim 灰 `>`（去蓝）；assistant 正文去 ● 前缀（官方 ⏺ 只属于工具行）；`⎿` 官方 2+2 缩进；截断提示 `(ctrl+o to expand)` 指向 verbose 查看器（官方语义） | `tui/App.tsx` `tui/ToolCard.tsx` `tui/transcript-lines.ts` |
| A5 Spinner | 官方平台分支帧序列（darwin `·✢✳✶✻✽`，**Windows/Linux ✳→`*`**，Ghostty ✽→`*`）+ 逆序 120ms；188 官方动词全量照搬，mount 单次采样（不轮换）；stall 检测（3s 无活动从原橙 #d77757 向红渐变，活动未知兜底橙色） | `tui/spinner-core.ts` `tui/StatusLine.tsx` `tui/cli-spinner.ts` |
| A6 文案/版本 | i18n 默认英文（仅 CCR_LANGUAGE=zh-CN 显式切中文，LANG 不再自动翻转）；~25 处硬编码中/英文案收表；version.ts 运行时读 package.json（banner 1.0.0 硬编码修复）；中断提示官方文案 | `tui/i18n.ts` `src/version.ts`(新) `tui/banner.ts` `tui/run.tsx` 等 |
| A7 权限对话框 | permission 蓝 + ▔ 分隔线；官方选项文案（bash → "…don't ask again for commands in <cwd>"、编辑族 → "…allow all edits this session"，run.tsx 按工具注入）；y/a/n 快捷键；**框内 Shift+Tab 切模式**（含全屏路径） | `tui/Prompts.tsx` `tui/store.ts` `tui/run.tsx` `tui/FullScreenApp.tsx` |

## 二、审查修复（两轮）

- version.ts 候选路径顺序（`../` 优先，防 monorepo 误读）；InputBox 裁剪指示方向/计数；ctx% 剩余语义（100−used，首用量前隐藏）；FullScreenApp 漏传 store（全屏 Shift+Tab 失效）+ statusLabel i18n 去遮蔽；死键/死字段/死导出清理（ui.status.*、palette.user、figures 重复）；过时注释 ×8；中断文案去冗余；palette 复用替代硬编码色；plan/acceptEdits 模式色对比度（官方 dark 用 ANSI bright，等效色 ≥6:1）。
- 用户真机反馈三修：输入框底线补回（升级为完整 ╭╮╰╯ 圆角框）；动词橙色恢复 + 帧序列改官方 Windows 分支（✳→`*`）；PromptFooter React key 警告（数组子节点改条件 JSX）。

## 三、验证

- 新增 `src/__tests__/official-alignment.test.tsx`（14 例：footer 优先级/宽度降级/queued 徽标、权限对话框 y/a/n + Shift+Tab 键盘级、version/banner、裁剪指示双向）+ 更新 7 个受影响测试文件。
- 四关：vitest 1476/1476、tsc --noEmit 0 错、biome lint 0 error（warning 541 < 基线 546）、esbuild 213 文件。
- 视觉自检（ink-testing-library 渲染实测）：圆角框/❯/footer 双列/动词橙色/`14% until auto-compact`/无 key 警告。

## 四、后续（待用户指令）

批次 B（输入行为：`!`/`#` 模式、Ctrl+R 历史搜索、Ctrl+S/G/T/D/L、队列可视化、双击 Esc 800ms、Alt+P 选择器）→ 批次 C（模式循环修正、plan 审批流、rewind 二级动作、历史持久化）→ 批次 D（可选打磨）。
