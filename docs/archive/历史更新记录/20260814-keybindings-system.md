# 更新日志 — Keybindings 系统（Phase A2）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：键位系统（`src/tui/keybindings/`）
> 主题：从 claude-code 参考 `keybindings/` 移植解析 + 匹配 + 解析器 + 用户配置加载，并接入 App 全局热键
> 状态：已落地（解析层 + 解析器 + 全局热键接线 + 测试）
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/keybindings.test.ts` 10/10、全量 1100/1100
> 关联 commit：待提交
> 关联文档：[参考源码盘点与移植计划](20260814-network-dependency-audit.md)（Phase A）

---

## 一、背景

原 `/keybindings` 命令只是硬编码展示一组快捷键，无解析、无校验、无用户自定义。参考 `keybindings/` 有一套「解析 → 匹配 → 解析」的完整链路，其中解析与匹配是纯函数、可直接移植。

---

## 二、移植内容

| 新文件 | 来源 | 说明 |
|---|---|---|
| `src/tui/keybindings/types.ts` | — | `ParsedKeystroke`/`Chord`/`KeybindingBlock`/`ParsedBinding` |
| `src/tui/keybindings/parser.ts` | `keybindings/parser.ts` | `parseKeystroke`（含 ctrl/control、alt/opt/option、cmd/command/super/win、esc/return/space/方向箭头别名）、`parseChord`、`chordToString`、`parseBindings` |
| `src/tui/keybindings/load.ts` | `keybindings/loadUserBindings.ts` | 读 `~/.claude/keybindings.json`，best-effort |
| `src/tui/keybindings/match.ts` | `keybindings/match.ts` | `getKeyName`（Ink Key → 键名）、`matchesKeystroke`/`matchesBinding`（alt/meta 折叠、Escape 忽略 meta 的 quirk） |
| `src/tui/keybindings/resolver.ts` | `keybindings/resolver.ts` | `resolveKey`（后者覆盖前者）、`buildKeystroke`、`keystrokesEqual`、`createResolver`（默认+用户覆盖合并） |
| `src/tui/keybindings/defaults.ts` | 新写 | 默认全局绑定：`shift+tab→chat:cycleMode`、`?→help:toggle`、`ctrl+c→app:interrupt` |

**接线**：`src/tui/App.tsx` 的 `ModeHotkey` 从硬编码 `key.tab && key.shift` / `input === "?"` 改为经 `globalResolver`（默认 + 用户覆盖）解析后派发。

**命令升级**：`/keybindings` 额外加载并显示 `~/.claude/keybindings.json` 的自定义绑定。

**测试** `keybindings.test.ts`（10 用例）：修饰符/别名/命名键解析、和弦、显示格式化、块扁平化、`getKeyName`、`resolveKey`、`createResolver` 覆盖优先级。

---

## 三、设计决策记录

1. **alt/meta 折叠** —— 终端无法区分 Alt/Option 与 Meta（Ink 把 Alt 记成 `key.meta`），故匹配时二者等价；`super`（Cmd/Win）保持独立（需 kitty 协议才到得了）。
2. **Escape 忽略 meta** —— Ink 在 Escape 时也置 `key.meta=true`（终端转义序列遗留），否则裸 `escape` 绑定永远匹配不上；`buildKeystroke` 同样处理。
3. **后者覆盖前者** —— `resolveKey` 遍历绑定取最后一个匹配，用户覆盖追加在默认之后自然生效。
4. **只接全局热键，不动 InputBox 编辑键** —— 编辑键（方向键/退格/Enter 提交）仍在 InputBox 内联处理；本次把「全局快捷键」这类 app-level 热键接到解析器，作为真实但低风险的接线示范。InputBox 编辑键迁到解析器是后续项。
5. **绑定启动时加载，不热重载** —— `loadUserBindings` 在模块加载时读一次；改 `keybindings.json` 需重启生效。

---

## 四、已知边界

- 仅支持**单键**绑定（`chord.length === 1`）；多键和弦（"ctrl+k ctrl+s"）解析已支持，但匹配/resolver 暂只处理单键。
- `ctrl+c` 的 `app:interrupt` 实际由进程级 SIGINT 处理，解析器里声明了但未接（避免双处理）。
