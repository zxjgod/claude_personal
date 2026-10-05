# `--ax-screen-reader`：纯 TUI 开关，判定级联完整复刻（2026-10-03）

对标本机官方 CLI **2.1.202**（win32 native binary）。

## 结论先行

`--ax-screen-reader` 是**纯 TUI 开关**。help 里"flat text, no decorative borders or animations"的承诺**对 TUI 完全准确**，但在 `--print` 路径上**一个字都不生效** —— 实机对比确认。

这是"声明 ≠ 运行时"的第四次，但形态与前三次都不同：`--betas` 看着是透传实为白名单、`--from-pr` 声明承诺选择器实为静默空操作、`--tmux` 的 help 推荐了一个 commander 拒绝的拼写 —— 而这一次，**声明是对的，只是作用域比暗示的窄得多**：九个消费者全部挂在 TUI 上，`--print` 一个都碰不到。

## 官方运行时考古

### 1. 判定级联（四级，顺序固定）

`Z9s.isEnabled()`（offset `231323680`）：

```js
isEnabled() {
  if (this.#e !== void 0) return this.#e;          // 私有字段缓存
  let e;
  if (J9s("--ax-screen-reader")) e = true;                          // ① CLI flag
  else {
    let t = ke.CLAUDE_AX_SCREEN_READER;                            // ② 环境变量
    e = t !== void 0 ? t : Dn().axScreenReader === true;           // ③ 设置键
  }
  if (!e) return (this.#e = false);
  return (this.#e = cno?.(aQd, true) ?? true);                      // ④ 测试闸门，生产恒 true
}
reset() { this.#e = void 0 }
```

三个必须逐字复刻的怪癖：

1. **环境变量不做布尔转换。** `e = t !== void 0 ? t : …` 然后 `if (!e)` —— 于是 `CLAUDE_AX_SCREEN_READER=0` 和 `=false` 都**开启**该模式（非空字符串为真），只有 `=""` 才关闭。这几乎肯定不是设 `=0` 的用户预期的，但官方已发布的行为就是这样；本项目照抄并写进测试与文档，不"顺手修正"，否则本项目就会在官方已经出货的地方产生分歧。
2. **设置键是嵌套的，且严格比较。** schema 在 `screenReader: { axScreenReader: boolean }`（offset `187806840`），`Dn()` 读到的是拍平后的 `axScreenReader`。因此磁盘上必须写在 `.claude/settings.json` 的 `screenReader` 对象里，且值必须是 `true` —— 顶层平铺的 `"axScreenReader": true` 不生效（因为拍平只发生在官方内部，本项目没有那一层）。
3. **结果被缓存**，所有消费者读同一个值。

### 2. argv 扫描规则（`J9s`，offset `231322859`）

```js
function J9s(e, t = process.argv) {
  for (let r = 0; r < t.length; r++) {
    let n = t[r];
    if (n === "--") break;                     // `--` 之后不算
    if (n === e) return true;                  // 精确元素匹配
    if (n !== void 0 && X9s.has(n)) r++;       // 带值 flag 吃掉下一个元素
  }
  return false;
}
```

`X9s` 共 **21 个**带值 flag：`--prefill` `--prefill-b64` `--deep-link-repo` `--deep-link-last-fetch` `--deep-link-cwd-b64` `--handle-uri` `--settings` `--managed-settings` `--setting-sources` `--team-name` `--agent-id` `--agent-name` `--agent-color` `--parent-session-id` `--agent-type` `--model` `--agent` `--routine` `--effort` `--permission-mode` `--session-id`。

可观测后果：`claude --model --ax-screen-reader` **不会**开启该模式（那个 flag 文本被当成 `--model` 的值）。默认取整个 `process.argv`，**不**跳过 node/脚本前缀。

### 3. 九个消费者（`qP()` 的全部调用点）

| 位置 | 函数 | 作用 |
| --- | --- | --- |
| 231500712 | `Yi` | 备用屏判定 → `if (qP()) return false` |
| 231501437 | `C4t` | 同上（第二个备用屏谓词） |
| 231501715 | `L1e` | 原因字符串 → `return "sr_auto_off"` |
| 231880803 | `sDe` | DECSTBM → 关闭 |
| 231881059 | `Coe` | 颜色谓词 → **强制 true** |
| 231881162 | `zao` | 原生光标谓词 → **强制 true** |
| 236442078 | `bL` | Ink `render()` 选项 → `isScreenReaderEnabled: qP()` |
| 244697224 | `/tui` | 封锁渲染器切换：`"Screen-reader mode always uses the classic renderer, so the tui setting has no effect while it is active."` |
| 248875606 | `Wqc` | 全屏 upsell → 抑制 |

外加 `b1e()`：开启时向子进程环境注入 `{ CLAUDE_AX_SCREEN_READER: "1" }`。

**九个全在 TUI 侧**。没有一个挂在 `--print` / headless / stream-json 路径上。

### 4. Ink 的扁平模式到底做了什么（Ink 7.1.0）

`node_modules/ink/build/render-node-to-output.js:24` `renderNodeToScreenReaderOutput`：

- `ink-text` → `squashTextNodes(node)`，**纯文本，无 ANSI**
- `ink-box` / `ink-root` → 子节点以 `" "`（row）或 `"\n"`（column）拼接，**不画 border、不排 padding**
- 有 `internal_accessibility.state` 的节点 → 前缀 `(state1, state2) `
- `ink.js:193`：`const unthrottled = options.debug || this.isScreenReaderEnabled;` → **关闭帧节流**，这正是"no animations"的实现方式

help 的描述对 TUI 是**准确的**。本项目同样用 Ink 7.1.0，依赖自带 `render.d.ts` 的 `isScreenReaderEnabled?: boolean`，无需自己实现渲染器。

## 实机探针（6 次 `claude -p`，约 $0.10）

第一次做的是原始字节比对，结果全是模型抖动（回复长度不同 → token 数与费用不同），无法归因。改成**遮蔽易变字段后的结构比对**（`result` / `session_id` / `duration_*` / `ttft*` / `usage` / `modelUsage` 全部剔除，只比对字段名与非易变标量）：

```
--- --output-format json      (shape 29 vs 29 entries)
   only-without: .usage.output_tokens=42 | .modelUsage…costUSD=0.013102
   only-with   : .usage.output_tokens=11 | .modelUsage…costUSD=0.012327
   → 29 个字段名完全一致，仅 token/费用数值不同

--- --output-format stream-json  (shape 2 vs 2 entries)
   only-without: (none)
   only-with   : (none)          ← 完全一致

--- env CLAUDE_AX_SCREEN_READER=1 (json)  (shape 29 vs 29 entries)
   同上，仅 token/费用抖动
```

结论：**`--print` 下该 flag 零可观测影响**（环境变量同）。

另探：

```
$ claude --ax-screen-reader=false -p "hi" …
error: unknown option '--ax-screen-reader=false'      exit=1
```

与 `--tmux=classic` 同一形态：官方声明为**无值 flag**，commander 因此拒绝一切 `=` 拼写。

## 本项目实现

| 文件 | 改动 |
| --- | --- |
| `src/ax-screen-reader.ts`（新） | `AX_FLAG` / `AX_ENV_VAR` / `VALUE_TAKING_FLAGS`（21 个）、`argvHasAxScreenReader()`、`resolveAxScreenReader()`（纯四级级联，带 `AxSource`）、`isAxScreenReaderEnabled()`（缓存）、`resetAxScreenReader()` |
| `src/tui/run.tsx` | `runTui` 开头解析一次，两处 `render()` 都传 `isScreenReaderEnabled` |
| `src/cli.ts` | `workspaceRoot` 确定后立即解析一次（避免 TUI 与启动提示各判一次）；`--fullscreen` 在该模式下被丢弃并告警；交互 TTY 打印官方原句 |
| `src/hooks-config.ts` | `screenReader` 注册进 `KNOWN_SETTINGS_KEYS` |
| `src/cli-env.ts` | `--help` 新增条目，**明写 "TUI only — --print output is unchanged"** |
| `src/__tests__/ax-screen-reader.test.ts`（新，29 项） | argv 扫描 6 / 优先级 6 / 环境真值 8 / 设置严格性 4 / 缓存 4 |

### 四条设计决策

1. **在 `workspaceRoot` 确定后、worktree 切换前解析一次** —— 既让 TUI 与启动提示读同一个值（官方就是私有字段缓存 + 单一 `qP()`），又让设置取自用户实际启动的那个目录，而不是换到 worktree 之后的那个。
2. **环境变量逐字采用，不做布尔转换** —— `=0` 开启、`=false` 开启、只有空串关闭。这是官方已发布的行为，写成 8 条参数化测试锁死，并写进文档。理由写在代码注释里：这是"照抄"与"顺手修正"的分界，本项目不替官方改语义。
3. **`--fullscreen` 被丢弃时必须告警** —— 官方的备用屏谓词在 flag 命中时直接 `return false`，用户请求的 `--fullscreen` 就这样没了。不告警就是静默降级。
4. **`screenReader` 必须进白名单** —— 否则 `warnUnknownSettings` 会对一个**本项目确实消费**的设置键报 "unsupported settings key ignored"，正是那个函数注释里点名要避免的失败模式（"a user-configured statusLine used to be 'known' yet do nothing"）。

### 明确记录的偏差

1. **`--ax-screen-reader=false` 被静默忽略而非报错**。结果正确（不启用），但与官方 commander 的 `error: unknown option` 不同。**不为单条 flag 开特例**：本项目全局容忍未知 flag 与布尔 flag 的 `=` 拼写（实测 `--totally-unknown-flag` exit 0、`--fullscreen=false` exit 0、`--debug=maybe` exit 0），只有取值域封闭的 flag（如 `--effort=nonsense`）才报错。为 `--ax-screen-reader` 单开一条拒绝规则会与这条全局约定冲突。
2. **`--print` 下无任何影响** —— 与官方一致，不是偏差，但必须在 `--help` 里写明，否则用户会以为 `-p` 也变了。

### 明确未实现（不应暗示已具备）

- 官方 `Coe` / `zao` 的强制颜色与强制原生光标谓词 —— Ink 扁平模式下颜色本就不输出、边框本就不画，加谓词是重复的"声称"而非能力
- DECSTBM 滚动区域控制（本项目未使用该协议）
- `/tui` 渲染器切换封锁 —— 本项目**没有 `/tui` 命令**
- 全屏 upsell 抑制 —— 本项目没有 upsell
- 向子进程（subagent / MCP）注入 `CLAUDE_AX_SCREEN_READER=1`

## 校验结果（全绿）

- `npm run typecheck`：通过
- `npm test`：**194 文件 / 2,534 用例全通过**（+1 文件 +29 用例）
- `npx biome check src`：**零 error**，**727 warnings**（与上两轮同数，基线未增长；新文件与新测试零 warning）
- `npm run build`：transpiled 277 files ✓ ／ `npm run smoke`：**PASSED**
- `node --import tsx scripts/doc-sync.mjs --check --with-tests`：全 ✓ —— version 1.6.1、srcLines **57,752**、srcFiles **277**、testFiles **194**、commands 49、tools 49、tests **2,534**

### 本项目实机核对（`dist/cli.js`）

```
=== A. --print 路径 ===
   --ax-screen-reader -p … json        exit=0，正常返回 result
   -p … json                          exit=0，正常返回 result（对照组）
   --ax-screen-reader=false -p …      exit=0，正常返回 result

=== B. 设置键 screenReader.axScreenReader ===
   exit=0，未出现 "axScreenReader" 字样（即无 unsupported 告警），正常返回 json

=== C. 对照：真正未知的键 ===
   bogusKeyXyz 仍然触发 "unsupported settings key ignored" 告警
```

C 组是必要的反向验证：确认 B 组不是"告警被整体关掉了"。`.claude/settings.json` 已在探针结束时按原内容还原（含探针前不存在的情形）。

**未实机验证**：TUI 渲染差异（扁平文本树、边框消失、取消帧节流）与 `[Accessible screen reader mode: on]` 启动提示 —— 本机无可交互 TTY，这两条只能靠 Ink 的 `isScreenReaderEnabled` 契约与单测覆盖；`--fullscreen` 被丢弃的告警同样只走了代码路径，未在真 TTY 下目视。