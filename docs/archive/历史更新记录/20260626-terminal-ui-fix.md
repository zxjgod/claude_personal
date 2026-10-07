# 终端界面 Bug 修复日志

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-26
> 主题：修复「命令行打开后闪一下就没 Claude」+「文字输出带 `&#39;` 等 HTML 实体」
> 验证：`npm run build` 通过，`npm test` **459 / 459 全过**（原 456 + 新增 3）

---

## 一、用户反馈

1. **命令行界面打开后闪一下就没 Claude了** —— TUI 启动时 Claude 欢迎横幅（mascot +
   "Welcome back!"）一闪即逝，进入会话后看不到横幅。
2. **文字输出有问题** —— 助手文本里的英文撇号 `'`、`&` 等字符以 HTML 实体形式泄漏到
   终端，例如 `I&#39;m ready` 而不是 `I'm ready`。
3. **命令行 bug（综合）** —— 上述两项影响正常使用。

---

## 二、根因分析

### Bug 1：横幅被备用屏幕（alt screen）切换擦掉

`src/tui/run.tsx` 的 `runTui()` 原先的顺序是：

```
printBanner(...)              // ① 先把横幅画到「主屏幕」
process.stdout.write(ENTER_ALT) // ② 再切到备用屏幕（DEC 1049），并 \x1B[2J 清屏
```

DEC 1049 备用屏幕是一个独立缓冲区，切入时会清空显示。于是横幅刚画到主屏幕就被备用
屏幕的清屏指令抹掉——表现就是「闪一下就没 Claude了」。会话期间备用屏幕里只有 Ink 的
输入框，横幅彻底消失。

用 `winpty` 仿真 TTY 抓帧验证：修复前会话内 `grep -c 'Welcome back'` = **0**。

### Bug 2：`marked` 转义产生的 HTML 实体未解码

`marked` 在词法分析时会把不安全字符转义成 HTML 实体（`'` → `&#39;`、`&` → `&amp;`、
`<` → `&lt;` …），这些实体挂在 `text` token 的 `.text` 上。`src/markdown.ts` 的
`formatToken` 直接原样输出 `token.text`，而终端不是浏览器，不会解码实体——于是实体
原样泄漏：

```js
marked.lexer("I'm ready")  // → paragraph.tokens[0].text === "I&#39;m ready"
renderMarkdown("I'm ready & cool")  // 修复前 → "I&#39;m ready &amp; cool"
```

这条同时影响 TUI（`renderMarkdown` 渲染流式文本）和非 TUI（`cli-renderer.ts` 的
`StreamingRenderer` 也走 `renderMarkdown`）两条路径。

---

## 三、改动明细

### `src/tui/run.tsx`

调整 `runTui()` 的启动顺序：**先切备用屏幕，再画横幅**。

```diff
+ const ENTER_ALT = "\x1B[?1049h\x1B[2J\x1B[H";
+ const EXIT_ALT  = "\x1B[?1049l";
+ process.stdout.write(ENTER_ALT);          // ① 先进备用屏幕（已清屏）
+
+ // ② 再把横幅画进备用屏幕——它是清屏后画的第一笔，会停在 Ink 实时区上方，
+ //    直到被输出滚进 in-app ScrollBox。
  printBanner({ version, model, provider, workspaceRoot });
- process.stdout.write(ENTER_ALT);
```

横幅成为备用屏幕里第一笔绘制内容，会话期间持续可见，不再被擦掉。退出时既有的
`restoreScreen()`（写 `EXIT_ALT` 回主屏幕）逻辑不变。

### `src/markdown.ts`

新增 `decodeEntities()`，在 `renderMarkdown()` 的输出边界统一解码 HTML 实体：

```ts
const HTML_ENTITIES = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'",
  "#39":"'", "#34":'"', "#60":"<", "#62":">", "#38":"&" };
const ENTITY_RE = /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;
export function decodeEntities(input: string): string { /* 命名/十进制/十六进制实体 → 字符 */ }

export function renderMarkdown(content: string): string {
  return decodeEntities(tokens.map(formatToken).join("").replace(/\n+$/, ""));
}
```

覆盖命名实体（`&amp;`）、十进制（`&#39;`）、十六进制（`&#x27;`）三种形式；未知名实体
原样保留（安全降级）。在渲染边界统一解码，`text` / `codespan` / `escape` 等所有承载
实体的 token 都能输出字面字符。

### 测试

- `src/__tests__/cli-renderer.test.ts`：新增 `decodes HTML entities marked introduces
  while escaping`——断言 `I'm ready & it's fine` 不再含 `&#39;` / `&amp;`。
- `src/__tests__/tui-banner.test.ts`：新增 `runTui banner/alt-screen ordering
  (regression)`——读取 `run.tsx` 源码断言 `printBanner({...})` 调用出现在
  `process.stdout.write(ENTER_ALT)` 之后，锁死顺序，防止回退。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run build`（`tsc`） | 通过，0 错误 |
| `npm test`（vitest 全套） | **459 / 459 全过**（新增 3 个回归测试） |
| 非 TUI 端到端：`printf "say: I'm a teapot & it's hot\nexit\n" \| node dist/cli.js` | `● I'm a teapot & it's hot`（无 `&#39;` / `&amp;`） |
| TUI 横幅持久（winpty 仿真）：会话内 `grep -c 'Welcome back'` | 修复前 **0** → 修复后 **1** |
| `renderMarkdown("I'm ready & cool <b>")` | `I'm ready & cool <b>`（实体已解码） |

---

## 五、受影响文件

**修改**
- `src/tui/run.tsx`（横幅改到 `ENTER_ALT` 之后绘制）
- `src/markdown.ts`（新增 `decodeEntities`，`renderMarkdown` 输出边界解码）
- `src/__tests__/cli-renderer.test.ts`（新增实体解码回归测试）
- `src/__tests__/tui-banner.test.ts`（新增横幅/备用屏幕顺序回归测试）

---

## 六、设计决策记录

1. **横幅画进备用屏幕，而非主屏幕** —— 备用屏幕（DEC 1049）是 TUI 的正主缓冲区，
   切入即清屏。横幅必须在切入之后画，才能留在会话可见区。退出时 `EXIT_ALT` 回主屏幕，
   主屏幕本来就没有横幅（干净），行为符合预期。
2. **实体解码放在渲染边界，而非每个 token 内** —— `marked` 可能在多种 token
   （`text`/`codespan`/`escape`/`html`）里塞实体，逐 token 处理易漏；在 `renderMarkdown`
   最终字符串上统一 `decodeEntities` 一次，覆盖全部来源且无性能顾虑（单次正则替换）。
3. **回归测试用源码文本断言锁顺序** —— 无 headless TTY 可在 CI 里真正触发备用屏幕
   切换，因此对 `run.tsx` 源码做文本断言（`printBanner` 调用必须在 `ENTER_ALT` 写入之
   后），既不依赖 TTY 又能防止顺序回退。

---

## 七、二次修复（同日）：横幅被 Ink 全屏首帧覆盖

> 主题：上一节修复后用户实测「闪一下就没 Claude，只剩底部输入框」依旧存在。
> 验证：`npm run build` 通过，`npm test` **460 / 460 全过**（改写 1 个回归测试）

### 7.1 现象复现

`npm start -- --verbose` 启动后：verbose 信息 + 会话信息正常打印 → 进入 TUI 主界面 →
**横幅闪一下就消失，只剩最底下的输入框和状态栏**。上一节的 alt-screen 顺序修复没能
解决这个实测症状。

### 7.2 真正的根因

上一节判定「横幅被 alt screen 清屏擦掉」是**错的**。真正原因在 [App.tsx](../../../src/tui/App.tsx)
的布局：`<App>` 的根 Box 是 `<Box flexDirection="column" height={rows}>`——**高度等于
整个终端行数，从备用屏幕第 0 行开始铺满**。

`run.tsx` 用裸 `printBanner()` 把横幅画到 stdout 后，Ink 接管渲染。Ink **首帧从光标
原点（第 0 行）重绘整个视口**：ScrollBox（启动时 `transcript` 为空，被空 padding 行
铺满）+ 输入框 + 状态栏，把刚画的横幅**整片覆盖**。表现就是「横幅画出来（闪一下）→
Ink 首帧用一个全屏空白布局盖掉 → 只剩底部输入框」。

用 `renderBannerLines()` 直接渲染横幅本身完全正常（吉祥物、Welcome back! 都在），
证明横幅代码没问题，纯粹是 Ink 全屏布局和裸 stdout 横幅**抢同一个屏幕区域**，二者
只能活一个。

### 7.3 改动明细

让横幅**成为 Ink 渲染内容的一部分**，而不是裸 stdout 打印——这样首帧渲染时就画出来，
不会被自己的布局覆盖。

#### `src/tui/store.ts`

新增 `banner` transcript kind 与 `setBanner()` 方法，把横幅作为会话第一条 transcript
项注入：

```ts
export type TranscriptItem =
  | …
  | { kind: "banner"; id: number; lines: string[] };

setBanner(lines: string[]): void {
  const banner = { kind: "banner", lines, id: this.nextId++ } as TranscriptItem;
  this.set({ transcript: [banner, ...this.state.transcript] });
}
```

#### `src/tui/App.tsx`

`TranscriptRow` 增加 `banner` kind 渲染（每行一个 `<Text>`，与 `log` kind 同构）：

```tsx
case "banner":
  return (
    <Box flexDirection="column">
      {item.lines.map((l, i) => (<Text key={i}>{l}</Text>))}
    </Box>
  );
```

#### `src/tui/run.tsx`

删掉裸 `printBanner()` 调用，改用 `renderBannerLines()` 构造内容后 `store.setBanner()`
注入；`printBanner` 导入改为 `renderBannerLines`：

```diff
- import { printBanner } from "./banner.js";
+ import { renderBannerLines } from "./banner.js";
  ...
- printBanner({ version, model, provider, workspaceRoot });
  const store = new TuiStore(...);
+ store.setBanner(renderBannerLines({ version, model, provider, workspaceRoot }));
```

横幅现在是 ScrollBox 里的第一条 transcript 项，首帧 Ink 渲染时就画出来；新输出会把它
慢慢顶上去——与真 Claude Code 的行为一致。

#### `src/__tests__/tui-banner.test.ts`

回归测试改写：从「`printBanner` 必须在 `ENTER_ALT` 之后」改为「必须用
`store.setBanner(bannerLines)` 注入、源码中不得再出现裸 `printBanner(` 调用」，锁死
新方案，防止回退到会被覆盖的裸打印。

### 7.4 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run build`（`tsc`） | 通过，0 错误 |
| `npm test`（vitest 全套） | **460 / 460 全过**（含改写的横幅回归测试） |
| TUI 横幅首帧可见、常驻顶部 | 修复前「闪一下消失」→ 修复后常驻，随输出上滚 |

### 7.5 设计决策记录（覆盖第三节的第 1 条）

1. **（覆盖旧决策）横幅画进 Ink 视口，而非裸 stdout 画进备用屏幕** —— 上一版"先切
   alt screen 再裸 `printBanner`"的方案在 alt-screen 切换层面是对的（横幅确实进了备用
   屏幕），但忽略了 `<App>` 的根 Box 是 `height={rows}` 全屏高度——Ink 首帧从第 0 行
   重绘整个视口，必然覆盖任何先画的裸 stdout 内容。只有让横幅成为 Ink 渲染树的一部分
   （store 的 transcript 项），它才不会被自己的布局盖掉。这是「裸 stdout 画静态内容」
   与「Ink 全屏接管」两种范式不可混用的典型坑。

### 7.6 受影响文件（本次）

**修改**
- `src/tui/store.ts`（新增 `banner` kind + `setBanner()`）
- `src/tui/App.tsx`（`TranscriptRow` 渲染 `banner` kind）
- `src/tui/run.tsx`（删裸 `printBanner`，改 `store.setBanner`）
- `src/__tests__/tui-banner.test.ts`（回归测试改写）
