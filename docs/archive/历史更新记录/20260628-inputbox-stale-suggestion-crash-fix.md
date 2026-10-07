# 更新日志 — InputBox `/` 命令面板陈旧选中索引越界崩溃修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-28
> 类型：fix
> 模块：TUI（`src/tui/InputBox.tsx`）
> 主题：`/` 命令补全里先按 ↓ 选到靠后项、再继续打字使候选列表变短时，选中索引未夹紧 → `suggestions[selected].name` 解引用 undefined，整个进程崩溃退出。
> 状态：已落地
> 验证：`npm run typecheck` 0 错；`npm run check`(biome) 干净；`npm test` **508/508**（新增 2 回归用例）；重建 dist 已含修复
> 关联 commit：待提交
> 关联文档：[项目架构.md §InputBox](../../项目架构.md)

---

## 一、现象 / 用户反馈

TUI 中操作 `/` 命令面板后进程整体崩溃，Node 抛栈：

```
TypeError: Cannot read properties of undefined (reading 'name')
    at InputBox.useInput.isActive (dist/tui/InputBox.js:83:47)
          value = "/" + suggestions[selected].name;
```

用户在大量文件被 M20 全量格式化后遇到，怀疑是格式化改坏了指令。

---

## 二、根因

| # | 缺陷 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | `selected` 为独立 state，候选列表 `suggestions` 随输入变短时未夹紧/归零 | `src/tui/InputBox.tsx`（原 `suggestions[selected]!.name`） | 索引越界 → 解引用 `undefined` → 进程崩溃 |

**触发时序：** ① 打 `/` → 候选 = 前 8 条命令，`selected=0`；② 按 ↓ 数次把 `selected` 移到靠后（如 2）；③ 继续打字（如 `/h`），候选被过滤变短（甚至 1 条），但 `selected` 仍停在 2；④ 回车/Tab → `suggestions.length>0` 成立，`suggestions[2]` 却是 `undefined` → `.name` 崩溃。↑↓ 导航用 `% suggestions.length` 只在导航当刻夹紧，**列表因打字而缩短的那一刻没有任何夹紧**。

**与 M20 格式化的关系（已核实无关）：** `git diff HEAD -- src/tui/InputBox.tsx` 显示该文件改动**纯属格式**（多行折叠 + 因 jsx automatic 删除未用的 `React` 默认导入）；崩溃那行 `value = "/" + suggestions[selected]!.name` 在格式化前后**逐字相同**，`!` 只是历史遗留的无用非空断言（骗过编译器、运行期照炸）。**此为既有潜在 bug，非格式化引入**——只是用户这次触发了它（对不存在的命令如 `/agents` 边导航边打字）。

**为何行式 REPL 不崩：** `src/cli-interactive.ts:172-173` 每次重算候选后有 `if (state.selected >= state.suggestions.length) state.selected = 0;` 的守卫；TUI 的 InputBox **缺这道防线**。

---

## 三、改动明细

### `src/tui/InputBox.tsx` — 在所有读取点用夹紧后的 `safeSelected`

```ts
const safeSelected =
  suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;
```

- 回车提交（原 `suggestions[selected]!.name`）→ `suggestions[safeSelected].name`
- Tab 补全（原 `suggestions[selected]!.name`）→ `suggestions[safeSelected].name`
- 下拉渲染高亮（原 `i === selected`）→ `i === safeSelected`（让视觉高亮与回车/Tab 实际选中一致）

要点：
- 选择**在使用点夹紧**而非 `useEffect` 归零——输入回调从闭包读 state，effect 要等下一次渲染才跑，崩溃发生在事件回调内，使用点夹紧才能即时杜绝越界。
- 三处全部 `length>0` 守卫下，`suggestions[safeSelected]` 必有值，顺手去掉了无意义的 `!`。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run check`（biome） | 干净，0 error |
| `npm test`（vitest --dir src） | **508 / 508**（新增 2 回归：Enter / Tab 在列表缩短后夹紧 → `/help`、`/clear`，不崩溃） |
| `npm run build`（esbuild） | dist/tui/InputBox.js 已含 `safeSelected`（line 84/91 不再越界） |

### 同类隐患排查（用户要求"不要有漏洞"）

逐一审计交互层的数组下标解引用：

- `cli-interactive.ts` 行式 REPL 补全：**已有**归零守卫（172-173），安全。
- `Prompts.tsx`、`cli-interactive.ts` 选择/多选菜单：数字键路径均有 `idx < options.length` 守卫；导航走固定列表 + `% length`，本质不越界。
- `SessionPicker.tsx`：`idx < sessions.length` 守卫 + 固定列表，安全。
- `EffortPrompt.tsx`：`ORDER` 为定长常量 + 夹紧 idx，安全。

结论：**唯一缺守卫的就是 InputBox.tsx**，已修复。

---

## 五、受影响文件

**修改**
- `src/tui/InputBox.tsx`（加 `safeSelected` 夹紧，3 处使用点改用之）
- `src/__tests__/input-box.test.tsx`（+2 回归用例：Enter / Tab 列表缩短场景）

**删除**
- 无

---

## 六、设计决策记录

1. **使用点夹紧而非 effect 归零** —— 崩溃在输入事件回调内同步发生，`useEffect` 的重置滞后一帧救不了；`Math.min(selected, len-1)` 在每次读取处即时夹紧，与渲染时刻无关，零竞态。
2. **对齐行式 REPL 的既有守卫** —— 两条渲染栈（TUI / 行 REPL）行为应一致；行 REPL 早有 `selected` 越界归零，本次给 TUI 补上等价防线（覆盖了"只有行 REPL 防御"的不一致）。
