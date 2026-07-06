# 更新日志 — TypeScript 类型收窄 + TUI 测试超时修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-07-06
> 类型：fix
> 模块：TypeScript 类型 / TUI 测试
> 主题：修复类型收窄错误和 TUI 滚动测试超时问题
> 状态：已落地
> 验证：`npm run typecheck` 通过、`npm test` 978/978 全过
> 关联 commit：待提交

---

## 一、现象

### 问题 1: TypeScript 类型错误

```
src/__tests__/path-security.test.ts(15,21): error TS2339: Property 'path' does not exist on type '{ ok: true; path: string; } | { ok: false; error: string; }'.
```

`resolveInWorkspace` 返回 discriminated union，但测试代码在类型收窄前直接访问 `.path` 和 `.error` 属性。

### 问题 2: TUI 测试超时

```
❯ src/__tests__/tui-components.test.tsx > CommandPicker > scrolls the window as the cursor moves down, then selects
Error: Test timed out in 5000ms.
```

TUI 滚动测试在 CI 或性能较差的机器上 5 秒超时。

---

## 二、根因

| # | 缺陷 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | 访问未收窄的 discriminated union 属性 | `src/__tests__/path-security.test.ts:15,21,27,89` | TS 编译错误 |
| 2 | TUI 测试延迟不足 + 无自定义超时 | `src/__tests__/tui-components.test.tsx:279-286` | CI 环境测试超时 |

**机制：**

1. `resolveInWorkspace` 返回 `{ ok: true; path: string } | { ok: false; error: string }`，TypeScript 要求在访问 `.path` 前检查 `.ok`。
2. TUI 测试循环 12 次按键，每次等待 5ms（共 60ms），但在 CI 环境下渲染可能更慢。

---

## 三、改动明细

### `src/__tests__/path-security.test.ts`

将直接属性访问改为类型守卫后访问：

```typescript
// 修复前
expect(result.ok).toBe(true);
expect(result.path).toBe(path.resolve("/workspace/src/index.ts"));

// 修复后
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.path).toBe(path.resolve("/workspace/src/index.ts"));
}
```

要点：
- 使用 `if (result.ok)` 类型守卫确保 TypeScript 正确收窄类型
- 适用于所有 4 处直接属性访问

### `src/__tests__/tui-components.test.tsx`

增加按键延迟和测试超时：

```typescript
// 修复前
for (let i = 0; i < 12; i++) {
  stdin.write("\x1B[B"); // down arrow
  await new Promise((r) => setTimeout(r, 5));
}

// 修复后
for (let i = 0; i < 12; i++) {
  stdin.write("\x1B[B"); // down arrow
  await new Promise((r) => setTimeout(r, 20)); // 增加延迟
}
// ...
}, 10000); // 添加 10 秒超时
```

要点：
- 按键间延迟从 5ms 增加到 20ms，给渲染足够时间
- 为测试添加 10 秒超时参数

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | 通过，0 错误 |
| `npm run lint` | 通过，0 错误，5 警告（已知） |
| `npm test` | **978/978 全过** (100%) |

---

## 五、受影响文件

**修改**
- `src/__tests__/path-security.test.ts`（类型收窄修复）
- `src/__tests__/tui-components.test.tsx`（超时修复）

---

## 六、设计决策记录

1. **类型守卫 vs 非空断言** —— 选择显式 `if (result.ok)` 而非 `result.path!`，因为测试应明确表达预期，更安全且意图清晰。
2. **延迟 vs Mock** —— 选择增加真实延迟而非 mock 时间，因为 TUI 组件的异步行为难以 mock，真实延迟更可靠。

---

## 七、二次修复（同日）

无。
