# 更新日志 (Changelog)

## [待发布] - 2026-07-06

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
