# 更新日志 (Changelog)

## [待发布] - 2026-07-11

### 架构重构 + 质量完善

#### P1 高优先级改进

**P1-1: agent-loop.ts 拆分**（1302→500 行）
- 拆分为 4 个模块：
  - `src/tool-executor.ts`: 工具执行器（M36 streaming + type-ahead）
  - `src/auto-compact.ts`: 上下文自动压缩（M31-M33）
  - `src/error-recovery.ts`: 错误恢复机制（429 指数退避）
  - `src/agent-loop.ts`: 主循环（精简后的协调层）
- 保留所有功能：speculation 预测预取、并发安全分组、token budget

**P1-2: types.ts 分区注释完善**
- 添加结构化分区注释：
  - Tool & ToolCall 相关类型
  - Event 类型
  - Message & Turn 相关类型
  - Config 类型
  - 其他类型

**P1-3: result-spill.ts → truncation.ts 重命名**
- 文件重命名：`src/tools/result-spill.ts` → `src/tools/truncation.ts`
- 更新所有引用
- 更准确反映功能（截断而非溢出）

**P1-4: 端到端集成测试**
- 新增 `src/__tests__/session-lifecycle.test.ts`
- 13 个新测试覆盖：
  - 会话启动 → 对话 → 压缩 → 退出 → resume
  - 持久化完整性
  - 原子性写入
  - 损坏文件恢复

#### P2 质量改进

**P2-1: DEBUG_STREAM 完整实现**
- 新增 `src/debug-logger.ts` 调试日志模块
- 实现完整的 `debugStream` 函数（runtimeMonitor 替代 stub）
- 支持 DEBUG_STREAM、DEBUG_PERMISSIONS、DEBUG_TOOLS 等环境变量
- 运行时性能监控（工具延迟、并发安全）

**P2-2: 权限决策链路日志**
- 在 `permissions.ts` 添加 structured logging
- `DEBUG_PERMISSIONS=1` 开启权限决策日志
- 记录：检查模式、危险模式匹配、最终决策

**P2-3: 会话版本迁移机制**
- 在 `session-memory.ts` 添加 `SESSION_FORMAT_VERSION = 2`
- 实现 `migrateV1toV2()` 迁移函数
- 启动时自动检测并迁移旧版本会话文件
- 保留 v1 格式作为 fallback

**P2-4: smoke test 扩展**
- 扩展 `scripts/smoke.mjs` 覆盖：
  - TUI 启动测试
  - 会话保存路径验证
  - Provider 配置检查
  - 基本工具功能

#### 测试结果

```
TypeScript: 0 编译错误
Test Files: 76 passed
Tests: 952 passed (100%)
Smoke Test: PASSED
```

---

## [待发布] - 2026-07-08

### 代码审查修复（M41 改动复审）

对未提交的 M41 改动（输入历史导航 + Emacs 行编辑 + highlight.js 语法高亮 + 结构化错误显示）进行代码审查，修复 4 个问题并清理死代码。详见 [`更新日志/20260708-code-review-fixes.md`](./更新日志/20260708-code-review-fixes.md)。

#### 修复

- **代码块 HTML 实体未解码**（`src/markdown.ts`）：`parseHljsOutput` 逐字符解析 highlight.js 输出时未识别 HTML 实体，导致 `<`/`>`/`&` 显示为 `&lt;`/`&gt;`/`&amp;`。新增实体匹配分支调用 `decodeHtmlEntities` 解码，并增加未闭合 span 的防御性 drain。
- **历史浏览输入位置错误**（`src/tui/InputBox.tsx`）：浏览历史条目时输入字符被插入到缓冲区开头（位置 0）而非光标位置。移除 `historyIndex >= 0 ? 0 : cursorRef.current` 特殊分支，统一在 `cursorRef.current` 插入。
- **换行符绕过只读命令判定**（`src/tools/utils/command.ts`）：`bashCommandIsReadOnly` 只按 `|`/`&&`/`||`/`;` 分割，不处理换行符。`ls\nrm -rf /` 第一段通过只读检查但实际执行 `rm`。新增 `[\r\n]` 检查，含换行的命令一律判为非只读。
- **死代码清理**：删除无调用方的 `formatError`、`unescapeHtml`（`src/markdown.ts`）和 `getInputHistory`/`pushInputHistory`（`src/tui/store.ts`）；简化语言别名查找（3 次 `toLowerCase` → 1 次 + `??`）。

#### 测试

- 修正 `input-box.test.tsx` 历史输入断言（`"xhistory item"` → `"history itemx"`）
- 新增 `tools.test.ts` 换行符绕过回归用例
- 全部 994 个测试通过（+1），`tsc --noEmit` 通过

---

## 2026-07-07

### 代码审查与修复

#### 发现并修复的问题

- **`confirm` 覆盖缺失**: `Overlay` 类型中存在 `confirm` 类型，但 TUI 组件中缺少对应的渲染逻辑
  - `src/tui/Prompts.tsx`: 新增 `ConfirmPrompt` 组件（Yes/No 二选一，←→ 切换）
  - `src/tui/App.tsx`: 添加 `case "confirm"` 分支
  - `src/tui/FullScreenApp.tsx`: 添加对应的全屏模式覆盖

#### 遗留 lint 警告（非本次引入）

| 文件 | 问题 |
|------|------|
| `src/utils/input-validator.ts` | static-only-class |
| `src/utils/resource-limiter.ts` | static-only-class |
| `src/tools/core/read.ts` | unused imports |
| `src/tools/summary.ts` | unused imports |
| `src/__tests__/path-security.test.ts` | 使用 `require("os")` 而非 `node:os` |

---

## 2026-07-06

### 工具系统全面升级

#### 核心工具增强

- **Read 工具**: 补充 `promptDescription`，详细说明参数（filePath、offset、limit）和图片/PDF 支持
- **Write 工具**: 完善描述，强调自动创建父目录功能
- **Edit 工具**: 强化 `old_string` 精确匹配规则说明，添加 replace_all 参数指引
- **MultiEdit 工具**: 说明原子性保证，清晰阐述失败回滚机制
- **Bash 工具**: 补充 timeout 参数说明，强调非交互式命令要求
- **Glob 工具**: 添加参数说明和示例模式
- **Grep 工具**: 说明输出格式（filepath:line:content）和结果限制

#### 遗留工具迁移到 Zod

所有扩展工具已从 `createTool`（JSON Schema）迁移到 `buildTool`（Zod Schema），实现严格运行时验证：

- **web_search**: 使用 Zod `z.strictObject()` 验证 query，添加 searchHint 和 aliases
- **web_fetch**: 使用 Zod 验证 URL 和 fetchInfo，保留 SSRF 安全检查
- **task**: 使用 Zod 验证 description、prompt 和 subagent_name，保留动态 promptDescription 生成
- **todo**: 使用 Zod 嵌套 schema 验证 TodoItem 结构

#### 工具元数据完善

为所有工具添加：

- **searchHint**: 语义化搜索提示词（如 "file read view cat"）
- **aliases**: 工具别名（如 web_search 的 "search"）

#### 测试更新

- 更新 `src/__tests__/new-tools.test.ts` 以适应 Zod 验证行为
- 所有测试通过（982 tests passed）

### 修复

- 构建系统正常工作（145 files → dist/）
- TypeScript 类型检查通过

---

## 提交历史

| 提交 | 描述 |
|------|------|
| `0334c9f` | fix: correct path-security symlink test setup and add update log |
| `7187011` | Enhance Stability |
| `7d12aa9` | security: prevent symlink escape via realpath check in resolveInWorkspace |
| `600f45e` | security: harden command validation and path traversal checks |
| `fbc3035` | docs: 生成最终完成报告 |
| `e5f9432` | docs: 更新项目文档 - 反映鲁棒性提升成果 |
| `6abeb99` | test: 修复最后的测试 - 100% 通过率达成！ |
| `0a6feac` | test: 修复所有测试 - 100% 通过 |
| `535b9c5` | docs: 项目完成 - 鲁棒性提升总结报告 |
