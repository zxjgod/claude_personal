# 更新日志 — Vim 模式引擎移植（Phase A1）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：vim 输入模式（`src/tui/vim/`）
> 主题：从 claude-code 参考源码 `vim/` 移植完整 vim 状态机 + 操作符，落成框架无关的纯引擎
> 状态：已落地（引擎 + InputBox 集成 + 测试）
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/vim.test.ts` 11/11 全过、全量 1090/1090
> 关联 commit：待提交
> 关联文档：[参考源码精华盘点与移植计划](./20260814-network-dependency-audit.md)（同一批规划的 Phase A）

---

## 一、背景

项目已有 `/vim` 命令能切换 `editorMode`（default|vim），但**只有占位、无实际编辑**。参考源码 `claude test/src/src/vim/` 里有一份完整、干净的 vim 实现（5 文件 1513 行），设计为「纯状态机 + 纯 Cursor 操作」，非常适合移植。

---

## 二、移植内容

| 新文件 | 来源 | 说明 |
|---|---|---|
| `src/tui/vim/types.ts` | `vim/types.ts` | 状态机类型（INSERT/NORMAL + 11 种 CommandState + 寄存器/查找/change） |
| `src/tui/vim/cursor.ts` | `utils/Cursor.ts`（1530 行）**重写** | 聚焦版 Cursor：grapheme 感知、`\n` 逻辑行；去掉 Ink 软换行/图片引用耦合 |
| `src/tui/vim/motions.ts` | `vim/motions.ts` | h/l/j/k/w/b/e/W/B/E/0/^/$/G/gg |
| `src/tui/vim/textObjects.ts` | `vim/textObjects.ts` | iw/aw + 引号/括号对象 |
| `src/tui/vim/operators.ts` | `vim/operators.ts` | d/c/y、x、r、~、J、p/P、>/<、o/O、dG/dgg |
| `src/tui/vim/transitions.ts` | `vim/transitions.ts` | 状态转移表（count/operator/find/g/replace/indent 中间态） |
| `src/tui/vim/engine.ts` | 新写 | `VimEngine` 门面：持有 text/offset/寄存器，喂键驱动状态机 |
| `src/tui/vim/index.ts` | 新写 | 公共导出 |

**测试** `src/__tests__/vim.test.ts`（11 用例）：插入/普通切换、`x`/`dd`/`yy+p`/`cw`/`diw`/`r`、`0`/`$`/`w`、`i`/`a`。

---

## 三、设计决策记录

1. **不移植 1530 行的参考 `Cursor`** —— 它深耦合 Ink（软换行、`[Image #N]` 引用、grapheme 边界），本项目的输入框是单行/简单模型，重写成 ~200 行只实现 vim 需要的部分，`snapOutOfImageRef` 置为空操作。
2. **引擎框架无关** —— 沿用项目 `spinner-core.ts`（纯核心）+ `StatusLine.tsx`（Ink 适配）的分层约定：`VimEngine` 不含任何 Ink/React 依赖，方便单测，InputBox 作为适配层。
3. **undo / dot-repeat 延后** —— 引擎记录 `lastChange` 但不回放；撤销栈/`.` 重放属于 InputBox（它持有完整文档历史），留待集成时接。
4. **逻辑行而非软换行** —— `*LogicalLine` 系列按 `\n` 计算，普通单行输入框用不上软换行。

---

## 四、A1 收尾：InputBox 集成（已落地）

`src/tui/InputBox.tsx` 把原手写 vim 子集（i/a/A/0/$/h/l/x/D）替换为 `VimEngine` 驱动：

- normal 模式按键经 `inkKeyToVim`（方向键 → h/l/k/j，其余 → 输入字符）路由进引擎，再把引擎的 `text/offset/mode` 读回 React 状态。
- 引擎用 `useRef` 跨按键持久，多键操作符（`d`→`w`、`3`→`w`）状态机在两次击键间保留。
- `Esc` 回 normal 时把引擎复位到 NORMAL/idle；text/offset 逐键重同步。
- INSERT 模式原有编辑逻辑（退格/删除/方向键/多行/历史/补全）不动，只换 normal 块。

## 五、已知未做

- **undo（`u`）/ dot-repeat（`.`）** 仍为 no-op——引擎记录 `lastChange`，但撤销栈属于 InputBox 的历史层，留待后续。
- A2 Keybindings 系统尚未开始。
