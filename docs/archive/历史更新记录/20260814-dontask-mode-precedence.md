# 更新日志 — `dontAsk` 权限档 + 配置优先级（Phase B2）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：权限系统（`src/permissions.ts` + `src/cli.ts` + `src/tui/store.ts` + `src/commands/mode.ts`）
> 主题：新增第 6 档 `dontAsk`（把"询问"转"拒绝"的无交互档）+ 权限模式配置优先级链
> 状态：已落地（6 档权限 + 优先级 + 3 测试）
> 验证：`npx tsc --noEmit` 通过、全量 1115/1115
> 关联 commit：待提交
> 关联文档：[参考源码移植路线图](../reports/参考源码移植路线图.md)（Phase B）

---

## 一、背景

参考源码 `utils/permissions/permissions.ts:503` 的 `dontAsk` 语义是**后处理变换**：把权限流程的 `ask`（询问用户）结果统一转成 `deny`（静默拒绝），且「放在最后，避免被 early return 绕过」。这是比 `auto`（分类器审批）更严的**无交互档**——凡是需要弹窗的操作一律拒绝，绝不提示、绝不自动放行。

---

## 二、改动

### `dontAsk` 档（第 6 档）

- `src/types.ts` / `src/tui/store.ts` / `src/cli.ts` / `src/commands/mode.ts`：加入 `dontAsk` 到类型、Shift+Tab 循环、合法模式表、`/mode` 描述。
- `src/permissions.ts` `checkPermission` 两处加 `dontAsk` 守卫：
  - Step 3b（危险命令）——本会 `askUser` 的，改为拒绝，且**不调分类器、不弹窗**。
  - Step 6（默认）——`needsApproval` 的工具，改为拒绝。
- 语义对齐参考：`dontAsk` 是"ask → deny"，只读工具照常放行，其余静默拒绝。

### 配置优先级链（`src/cli.ts` `getPermissionMode`）

```
--permission-mode <mode>  >  --safe-mode(→plan)  >  PERMISSION_MODE env  >  .claude/settings.local.json > .claude/settings.json  >  ~/.claude/settings.json  >  default
```

复用 `hooks-config.ts` 的 `readSettings()` 读项目/用户 settings，读取 `permissionMode` 字段。

### 测试

- `permissions.test.ts` 新增 3 用例：dontAsk 拒绝危险命令且不弹窗、拒绝非危险破坏性工具且不弹窗、只读工具仍放行。
- `tui-store.test.ts` 循环序补 `dontAsk`。

---

## 三、设计决策记录

1. **对齐"ask→deny"而非新增 fast-path** —— 在 `checkPermission` 的两个 `askUser` 调用点前加守卫（等效于参考的"末尾变换"），语义清晰：`dontAsk` 下从不弹窗、从不自动放行。
2. **`dontAsk` 进 Shift+Tab 循环** —— 参考里 `dontAsk` "未暴露到 UI 循环"（产品决策）；复刻项目把它放进循环/`/mode`，让用户实际可达。
3. **优先级用 `readSettings` 复用** —— 项目 settings 读取已有 `hooks-config.ts::readSettings`，直接复用，避免重复实现 settings 合并。
