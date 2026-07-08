# 更新日志 — 代码审查修复（语法高亮实体、历史输入位置、命令换行绕过、死代码清理）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-07-08
> 类型：fix
> 模块：markdown 渲染 / InputBox 历史 / 命令验证 / store
> 主题：修复代码审查发现的 4 个中等/低等问题 + 清理死代码
> 状态：已落地
> 验证：`npm run typecheck` 通过、`npx vitest run --dir src` 994/994 全过
> 关联 commit：待提交
> 关联文档：[`../项目评审报告.md`](../项目评审报告.md)

---

## 一、现象 / 用户反馈

对未提交的 M41 改动（输入历史导航 + Emacs 行编辑快捷键 + highlight.js 语法高亮 + 结构化错误显示 + 权限风险等级可视化）进行代码审查时发现 4 个问题：

1. **代码块显示 HTML 实体**：启用 highlight.js 语法高亮后，代码中的 `<`、`>`、`&` 在终端显示为 `&lt;`、`&gt;`、`&amp;`，而非原始字符。
2. **历史浏览时输入插入位置错误**：浏览历史条目时输入字符，字符被插入到缓冲区开头（位置 0）而非光标位置（末尾），导致 `"history item"` + 输入 `"x"` 变成 `"xhistory item"` 而非预期的 `"history itemx"`。
3. **换行符可绕过只读命令判定**：`bashCommandIsReadOnly` 只按 `|`、`&&`、`||`、`;` 分割命令段，不处理换行符 `\n`/`\r`。含 `ls\nrm -rf /` 的命令第一段 `ls` 通过只读检查，但实际执行会跑 `rm`。
4. **死代码**：`formatError`（markdown.ts）、`pushInputHistory`/`getInputHistory`（store.ts）均无调用方。

---

## 二、根因

| # | 缺陷 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | `parseHljsOutput` 逐字符处理 HTML，未识别 HTML 实体 | `src/markdown.ts:316` | 代码块显示 `&lt;` 而非 `<` |
| 2 | 历史浏览时 `insertPos = historyIndex >= 0 ? 0 : cursorRef.current` | `src/tui/InputBox.tsx:474` | 输入插到开头而非光标处 |
| 3 | `bashCommandIsReadOnly` 分割前未检查换行符 | `src/tools/utils/command.ts:26` | `ls\nrm -rf /` 被判为只读 |
| 4 | `formatError`/`pushInputHistory`/`getInputHistory` 无调用方 | `src/markdown.ts:389` / `src/tui/store.ts:525,534` | 维护负担 |

**机制：**

1. highlight.js 的 `highlight()` 返回 HTML，其中源码的 `<`/`>`/`&` 已被转义为实体。`parseHljsOutput` 用栈解析 `<span>` 标签并应用 chalk 颜色，但在"Regular character"分支中逐字符累加，把 `&lt;` 当作 4 个字面字符 `&`、`l`、`t`、`;` 输出到终端。已定义的 `unescapeHtml` 函数从未被调用。
2. M41 历史导航将光标设到历史条目末尾（`setCursor(newHistoryItem.length)`），但输入处理逻辑误以为"浏览历史时光标在开头"，用 `historyIndex >= 0 ? 0 : cursorRef.current` 强制插入位置为 0。测试把这个错误行为固化为期望。
3. `bashCommandIsReadOnly` 用 `cmd.split(/\||&&|\|\||;/g)` 分割命令段，但换行符 `\n`/`\r` 不在分割模式中。Shell 中换行等价于 `;`，可链式执行命令。含换行的命令只有第一段被检查，后续段（可能是 `rm -rf`）被忽略。
4. `formatError` 在引入时 intended 供 markdown.ts 和 ToolCard.tsx 共用，但 ToolCard.tsx 实际只用了 `parseError` 并自行渲染，`formatError` 从未被调用。`pushInputHistory`/`getInputHistory` 是 store 的早期 API，但 InputBox 改为通过 `onHistoryChange` 回调直接调 `setInputHistory`，这两个方法成了死代码。

---

## 三、改动明细

### `src/markdown.ts`

**1. `parseHljsOutput` 增加 HTML 实体识别分支**

在"Regular character"分支前新增实体匹配，调用已有的 `decodeHtmlEntities` 解码：

```ts
// HTML entity — decode and add to current span (or result).
const entityMatch = html.slice(i).match(/^&(?:lt|gt|amp|quot|apos|nbsp|#x[0-9a-fA-F]+|#\d+);/);
if (entityMatch) {
  const decoded = decodeHtmlEntities(entityMatch[0]);
  if (stack.length > 0) {
    stack[stack.length - 1]![1] += decoded;
  } else {
    result += decoded;
  }
  i += entityMatch[0].length;
  continue;
}
```

同时增加未闭合 span 的防御性 drain（循环结束后清栈，防止畸形 hljs 输出导致 `stack.pop()!` 在空栈上崩溃）。

**2. 删除死代码 `formatError`**

删除 `formatError` 函数（~44 行）及其章节注释。`parseError` 保留（ToolCard.tsx 在用）。更新 `parseError` 的注释，移除对 `formatError` 的引用。

**3. 简化语言别名查找**

```ts
// 修改前（3 次 toLowerCase）：
const resolvedLang = lang.toLowerCase() in LANGUAGE_ALIASES
  ? LANGUAGE_ALIASES[lang.toLowerCase()]!
  : lang.toLowerCase();

// 修改后（1 次）：
const lower = lang.toLowerCase();
const resolvedLang = LANGUAGE_ALIASES[lower] ?? lower;
```

**4. 删除未使用的 `unescapeHtml`**

`unescapeHtml` 函数从未被调用（实体解码改用 `parseHljsOutput` 内联调用 `decodeHtmlEntities`），删除。

### `src/tui/InputBox.tsx`

**修复历史浏览时输入插入位置**

```ts
// 修改前：
const insertPos = historyIndex >= 0 ? 0 : cursorRef.current;

// 修改后：
const insertPos = cursorRef.current;
```

移除"浏览历史时插入开头"的错误注释。现在无论是否在浏览历史，输入都在光标位置插入，与正常编辑行为一致。

### `src/tools/utils/command.ts`

**换行符检查**

在 shell 特性正则检查后、命令段分割前，新增换行符检查：

```ts
// Newlines can chain commands (e.g. "ls\nrm -rf /") and bypass the
// per-segment read-only check below, which only splits on |, &&, ||, ;.
if (/[\r\n]/.test(cmd)) return false;
```

### `src/tui/store.ts`

**删除死代码**

删除无调用方的 `getInputHistory()` 和 `pushInputHistory()` 方法。保留 `setInputHistory()`（InputBox 通过 `onHistoryChange` 回调在用）。

### `src/__tests__/input-box.test.tsx`

**修正测试断言**

`"typing exits history browsing mode"` 用例：浏览 `"history item"` 后输入 `"x"`，断言从 `"xhistory item"` 改为 `"history itemx"`（光标在末尾，输入应追加到末尾）。

### `src/__tests__/tools.test.ts`

**新增换行符绕过测试**

```ts
it("rejects newlines that could chain a write command", () => {
  expect(bashCommandIsReadOnly("ls\nrm -rf /")).toBe(false);
  expect(bashCommandIsReadOnly("ls\rrm -rf /")).toBe(false);
  expect(bashCommandIsReadOnly("cat a.txt\n\necho done")).toBe(false);
});
```

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | 通过，0 错误 |
| `npx vitest run --dir src` | 994 / 994 全过（新增 1 个回归用例：`rejects newlines that could chain a write command`） |
| 受影响测试文件 | `tools.test.ts` 33/33、`input-box.test.tsx` 24/24、`tui-components.test.tsx` 22/22、`tui-store.test.ts` 25/25 |

测试数从 993 增至 994（+1 新增换行符测试）。

---

## 五、受影响文件

**修改**
- `src/markdown.ts`（修复 HTML 实体解码 + 删除 `formatError`/`unescapeHtml` + 简化语言别名）
- `src/tui/InputBox.tsx`（修复历史浏览输入位置）
- `src/tools/utils/command.ts`（换行符检查）
- `src/tui/store.ts`（删除 `getInputHistory`/`pushInputHistory`）
- `src/__tests__/input-box.test.tsx`（修正历史输入断言）
- `src/__tests__/tools.test.ts`（新增换行符测试）

---

## 六、设计决策记录

1. **实体解码放在 `parseHljsOutput` 内联而非保留 `unescapeHtml`** —— `unescapeHtml` 是整串反转义，但 `parseHljsOutput` 是逐 token 流式处理，实体可能跨越 span 边界。内联在字符循环中按实体模式匹配并解码更安全，且复用已有的 `decodeHtmlEntities`。故删除 `unescapeHtml` 避免两套解码逻辑。
2. **换行符一律判为非只读而非分割** —— Shell 中 `\n` 等价于 `;`，理论上可加入分割模式。但含换行的"只读"命令极少见，保守判为非只读（走审批）更安全，符合该函数"intentionally CONSERVATIVE"的设计原则。
3. **历史浏览输入统一在光标位置插入** —— 浏览历史时光标已被设到条目末尾，用户预期输入出现在光标处。移除 `historyIndex >= 0 ? 0 : ...` 的特殊分支，统一用 `cursorRef.current`，行为与正常编辑一致。
