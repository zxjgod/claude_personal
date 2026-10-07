# TUI 官方对齐 — 批次 D（打磨，D1/D5/D6）完成报告

> 日期：2026-09-07
> 用户选定：D1 Spinner tips、D5 大粘贴折叠、D6 查看器补齐；D2/D3 未选；**D4 Banner 永久否决（经典双栏样式保留）**。
> 结果：完成；测试 1513 → 1524（113 文件全绿），tsc/build 通过，lint 零 error。

## 交付

| 项 | 行为 | 主要文件 |
|---|---|---|
| D1 Spinner tips | 官方风格 tips 14 条（中英双语），spinner 运行 ≥8s 且无 todos 时显示 `⎿ Tip: ...`（todos 时 Next: 行优先）；`nextTipId` 会话内不重复、耗尽为 null | `spinner-core.ts`、`App.tsx`(TipLine)、`i18n.ts` |
| D5 大粘贴折叠 | 粘贴 >1024 字符折叠为 `[Pasted text #N +L lines]` chip（buffer/回显一行）；提交时 `expandPastedChips` 展开全文进上下文（模型始终见全文）；chip 会话级持久（非一次性，区别于图片 chip）；手打的未知 id 保持字面 | `paste-chip.ts`(新纯模块)、`InputBox.tsx`、`run.tsx`、App/FullScreenApp 接线 |
| D6 查看器补齐 | footer 官方文案 `Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · home/end top/bottom · ctrl+e to collapse/expand`（随状态切换、自然换行）；ctrl+e 切换 thinking 全文/折叠（官方 showAll 语义，工具输出始终全量）；搜索时 `(当前/总数)` 角标；q 退出确认保留 | `TranscriptReview.tsx`、`transcript-lines.ts`(collapseThinking)、`i18n.ts` |

## 附带修复

- 运行中 Shift+Tab 无反馈：footer 忙碌+非默认模式并列显示（`⏵⏵ accept edits on · esc to interrupt`），官方 ModeIndicator 语义（前序提交 `94d8eb3`）。
- 三个旧断言随 D6 官方文案/视口预算更新（q/Esc close → Showing detailed transcript；`{` 跳转断言改为与视口行数无关）。

## 验证

新增 `polish-features.test.tsx`（10 例：tip 轮换/8s 门槛/todos 压制、chip 构建/展开/未知 id/折叠路径/短粘贴不折叠、footer 官方文案/ctrl+e 翻转/搜索角标/q 关闭）。
