# TUI 官方对齐 — 批次 B（输入行为）完成报告

> 日期：2026-09-06
> 方案：[TUI官方对齐方案](../reports/20260906-TUI官方对齐方案.md) 批次 B
> 结果：**完成**；测试 1476 → 1494（111 文件全绿），tsc/build 通过，lint 无新增 error。

---

## 一、交付清单

| 项 | 行为 | 主要文件 |
|---|---|---|
| B1 `!` bash 模式 | 粉色框线 + `! ` 提示符（buffer 首字符由标记符渲染）；Enter 直跑 shell（Windows 用 powershell 工具，用户亲启无权限门）；输出 dim 回显进 transcript；`<bash-input>/<bash-stdout>` 包裹注入上下文并触发 Claude 自动回应；Esc 在 buffer=="!" 时退出模式 | `run.tsx`(runBashMode)、`InputBox.tsx`、`App.tsx`(回显标记) |
| B2 `#` 记忆前缀 | 官方 remember 蓝 `#` 标记；Enter 追加写入 CLAUDE.md（与 /memory add 同格式，含换行修正）+ dim 确认行；无模型回合 | `run.tsx`(runMemoryMode) |
| B3 Ctrl+R 历史搜索 | 内联 reverse-i-search：查询过滤（最新优先）、Ctrl+R/↑ 下一条、Enter 接受并运行、Esc/Tab 仅接受、Ctrl+C 取消；无历史时提示。工具卡展开热键退役（ExpandHotkey 删除），`(ctrl+o to expand)` 完全指向 verbose 查看器 | `InputBox.tsx`、`keybindings/defaults.ts` |
| B4 Ctrl+S/G/T | stash 草稿（text+cursor，空提示符再按恢复）；Ctrl+G 调 $VISUAL/$EDITOR（editInEditor 读回、TTY 挂起、失败保留原稿、等待行替换输入框）；Ctrl+T 收起 todo 列表（spinner 下 dim `Next: <task>` 替代） | `InputBox.tsx`、`open-editor.ts`(editInEditor)、`store.ts`、`App.tsx` |
| B5 Ctrl+C/D/L | 空闲 Ctrl+C：有草稿先清空并武装提示，空草稿双击 800ms 退出（footer 左列最高优先显示 `Press ctrl+c again to exit`，3s 自动熄灭）；Ctrl+D 双击 800ms 退出；Ctrl+L 清屏重绘（Ink 7 无 clear()，ANSI 清屏 + store 触发重渲染）；busy 时 Ctrl+C/Esc 中断、Ctrl+D 不误触 | `run.tsx`(InterruptHotkey 重构)、`PromptFooter.tsx` |
| B6 队列可视化 | 排队消息以 dim 用户消息渲染在输入框上方（≤3 行 + 溢出行，bash 队列 `!` 标记）；空提示符按 ↑ 取回最新排队消息编辑（InputQueue.popLast + snapshot 镜像贯穿所有 drain 点）；全屏布局同步支持 | `QueuedMessages.tsx`(新)、`input-queue.ts`、`store.ts`、`App.tsx`/`FullScreenApp.tsx` |
| B7 双击 Esc 800ms | 官方 useDoublePress 常量（原 2s） | `InputBox.tsx` |
| B8 Alt+P / Alt+T | 模型选择器 overlay（provider profiles + 当前模型，仿 ProviderPicker 滚动/数字快选，切换零 token + 上下文窗口随动）；thinking 开关（options.thinking = {type:"disabled"} 切换 + notice） | `ModelPicker.tsx`(新)、`store.ts`(askModelPicker)、`run.tsx` |

架构：全局热键（ctrl+s/g/r、alt+p/t）经 `store.dispatchInputAction(kind)` 信号管道送达 InputBox 执行（InputBox 拥有 buffer，热键层不越权）；键位全部进 DEFAULT_BINDINGS 可被 `~/.claude/keybindings.json` 重绑（ctrl+c/d 为官方保留键除外）。HelpPanel 全键位表同步更新（含 `!`/`#` 前缀说明）。

## 二、验证

- 新增 `src/__tests__/input-behaviors.test.tsx`（17 例：inputAction 管道/stash 往返/搜索三态/bash·memory 标记/队列取回·快照/exit hint 优先级/todos 开关/ModelPicker 键盘级+overlay 管道）+ keybindings 新绑定断言。
- 更新 keybindings.test.ts（ctrl+r → history:search）。
- 1494/1494 全绿；tsc 0 错；lint 无新增 error（存量 4 条与本批无关）；build 215 文件。
- 视觉自检：队列 dim 列表 + `!` bash 队列标记 + `queued 2` 徽标 + exit hint 覆盖链均实测渲染正确。

## 三、后续

批次 C（模式循环顺序修正、plan 审批流、rewind 二级动作、compact 摘要样式、输入历史持久化、transcript 查看器补齐）待启动。
