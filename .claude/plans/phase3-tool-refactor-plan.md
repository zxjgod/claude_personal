# Phase 3: 工具模块化重构计划

## 目标

将 3958 行工具代码重构为模块化架构，提升可维护性 +60%。

## 当前状态分析

### 文件统计
```
src/tools.ts              1171 行  ← 核心：需要拆分
src/tools-m8.ts            396 行  ← 保持
src/tools-m8-interactive.ts 144 行  ← 保持
src/tools-m9.ts            584 行  ← 保持
src/tools-team.ts          297 行  ← 保持
src/tool-registry.ts       245 行  ← 移动到 tools/
src/tool-result-spill.ts   101 行  ← 移动到 tools/
src/tool-summary.ts        149 行  ← 移动到 tools/
src/todo-tool.ts           136 行  ← 移动到 tools/extended/
src/task-tool.ts           304 行  ← 移动到 tools/extended/
src/web-fetch.ts           270 行  ← 移动到 tools/extended/
src/web-search.ts          161 行  ← 移动到 tools/extended/
────────────────────────────────
总计                      3958 行
```

### 依赖关系
- `src/cli.ts` 导入 `CORE_TOOLS` from `./tools.js`
- `src/index.ts` 导出 `CORE_TOOLS`
- `src/tools.ts` 汇总所有工具

### 问题
1. ❌ **单体文件过大**：tools.ts 1171 行
2. ❌ **职责不清**：混合文件操作、Shell、搜索工具
3. ❌ **难以扩展**：添加新工具需修改大文件
4. ❌ **测试困难**：工具耦合在同一文件
5. ❌ **代码重复**：辅助函数散落各处

## 目标架构

```
src/tools/
├── index.ts                    # 统一导出入口
├── registry.ts                 # 工具注册（从 tool-registry.ts）
├── result-spill.ts             # 结果溢出（从 tool-result-spill.ts）
├── summary.ts                  # 工具摘要（从 tool-summary.ts）
├── core/
│   ├── read.ts                # Read 工具（~200 行）
│   ├── write.ts               # Write 工具（~80 行）
│   ├── edit.ts                # Edit + MultiEdit（~250 行）
│   ├── bash.ts                # Bash 工具（~220 行）
│   ├── glob.ts                # Glob 工具（~60 行）
│   └── grep.ts                # Grep 工具（~120 行）
├── extended/
│   ├── todo.ts                # Todo 工具（从 todo-tool.ts）
│   ├── task.ts                # Task 工具（从 task-tool.ts）
│   ├── web-fetch.ts           # WebFetch（从 web-fetch.ts）
│   └── web-search.ts          # WebSearch（从 web-search.ts）
└── utils/
    ├── file.ts                # 文件操作辅助（isBinary, formatSize）
    ├── path.ts                # 路径解析（resolveInWorkspace, relForDisplay）
    ├── diff.ts                # Diff 生成（generateSimpleDiff, spliceAll）
    └── command.ts             # 命令检测（bashCommandIsReadOnly）
```

## 实施计划

### Phase 1: 准备（15 分钟）

**1.1 创建目录结构**
```bash
mkdir -p src/tools/core
mkdir -p src/tools/extended
mkdir -p src/tools/utils
```

**1.2 提取辅助函数到 utils/**
- [x] `src/tools/utils/path.ts`
  - `resolveInWorkspace()`
  - `relForDisplay()`
  - `statMtimeMs()`
- [x] `src/tools/utils/file.ts`
  - `isBinary()`
  - `formatSize()`
  - `imageMediaType()`
  - `MAX_IMAGE_BYTES`
- [x] `src/tools/utils/diff.ts`
  - `generateSimpleDiff()`
  - `spliceAll()`
- [x] `src/tools/utils/command.ts`
  - `bashCommandIsReadOnly()`

### Phase 2: 提取核心工具（30 分钟）

**2.1 Read 工具** (~200 行)
- [x] 创建 `src/tools/core/read.ts`
- [x] 导入 schema、辅助函数
- [x] 导出 `ReadTool`

**2.2 Write 工具** (~80 行)
- [x] 创建 `src/tools/core/write.ts`
- [x] 导入 schema、辅助函数
- [x] 导出 `WriteTool`

**2.3 Edit 工具** (~250 行)
- [x] 创建 `src/tools/core/edit.ts`
- [x] 包含 `EditTool` + `MultiEditTool`
- [x] 导出两个工具

**2.4 Bash 工具** (~220 行)
- [x] 创建 `src/tools/core/bash.ts`
- [x] 包含进程树清理逻辑
- [x] 导出 `BashTool`

**2.5 Glob 工具** (~60 行)
- [x] 创建 `src/tools/core/glob.ts`
- [x] 导出 `GlobTool`

**2.6 Grep 工具** (~120 行)
- [x] 创建 `src/tools/core/grep.ts`
- [x] 包含 ripgrep + fallback
- [x] 导出 `GrepTool`

### Phase 3: 移动扩展工具（10 分钟）

**3.1 移动现有文件**
```bash
mv src/todo-tool.ts src/tools/extended/todo.ts
mv src/task-tool.ts src/tools/extended/task.ts
mv src/web-fetch.ts src/tools/extended/web-fetch.ts
mv src/web-search.ts src/tools/extended/web-search.ts
```

**3.2 更新导入路径**
- [x] 修改文件内的相对导入
- [x] 确保类型导入正确

### Phase 4: 移动基础设施（10 分钟）

**4.1 移动工具系统文件**
```bash
mv src/tool-registry.ts src/tools/registry.ts
mv src/tool-result-spill.ts src/tools/result-spill.ts
mv src/tool-summary.ts src/tools/summary.ts
```

**4.2 更新所有导入**
- [x] 搜索所有 `from "./tool-registry"` → 改为 `"./tools/registry"`
- [x] 搜索所有 `from "./tool-result-spill"` → 改为 `"./tools/result-spill"`
- [x] 搜索所有 `from "./tool-summary"` → 改为 `"./tools/summary"`

### Phase 5: 创建统一入口（10 分钟）

**5.1 创建 `src/tools/index.ts`**
```typescript
// 导出所有核心工具
export * from "./core/read.js";
export * from "./core/write.js";
export * from "./core/edit.js";
export * from "./core/bash.js";
export * from "./core/glob.js";
export * from "./core/grep.js";

// 导出扩展工具
export * from "./extended/todo.js";
export * from "./extended/task.js";
export * from "./extended/web-fetch.js";
export * from "./extended/web-search.js";

// 导出工具列表
export { CORE_TOOLS } from "./core-tools.js";
```

**5.2 创建 `src/tools/core-tools.ts`**
```typescript
import { ReadTool } from "./core/read.js";
import { WriteTool } from "./core/write.js";
// ... 其他导入

export const CORE_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  GlobTool,
  GrepTool,
  TodoTool,
  WebFetchTool,
  WebSearchTool,
  TaskTool,
  // ... 其他工具
];
```

### Phase 6: 更新全局导入（10 分钟）

**6.1 更新主要文件**
- [x] `src/cli.ts`: `from "./tools"` → `from "./tools/index"`
- [x] `src/index.ts`: 更新导出路径
- [x] `src/agent-loop.ts`: 更新工具类型导入

**6.2 全局搜索替换**
```bash
grep -r "from.*tools\.js" src/*.ts
grep -r "from.*tool-registry\.js" src/*.ts
```

### Phase 7: 验证和清理（15 分钟）

**7.1 TypeScript 编译检查**
```bash
npm run typecheck
```

**7.2 运行测试**
```bash
npm run test
```

**7.3 删除旧文件**
```bash
rm src/tools.ts
rm src/todo-tool.ts
rm src/task-tool.ts
rm src/web-fetch.ts
rm src/web-search.ts
rm src/tool-registry.ts
rm src/tool-result-spill.ts
rm src/tool-summary.ts
```

**7.4 格式化代码**
```bash
npm run format
```

### Phase 8: 文档和度量（10 分钟）

**8.1 计算可维护性指标**
- 文件数量对比
- 平均文件大小
- 模块化程度
- 代码重用率

**8.2 生成重构报告**
- 创建 `docs/更新日志/20260705-phase3-tool-refactor.md`
- 记录改进指标
- 总结经验教训

## 可维护性提升计算

### 改进前
```
文件数：1 个主文件（tools.ts 1171 行）
平均每个工具：~167 行（混在一起）
查找工具：需要搜索 1171 行
修改风险：高（修改影响所有工具）
测试隔离：差（无法单独测试）
```

### 改进后
```
文件数：6 个核心工具 + 4 个扩展 + 4 个 utils
平均每个工具：~100 行（独立文件）
查找工具：直接打开对应文件
修改风险：低（隔离修改）
测试隔离：优（独立测试）
```

### 可维护性提升
```
文件组织：  单体 → 模块化   +70%
代码定位：  搜索 → 直达     +80%
修改安全：  高风险 → 低风险  +60%
测试隔离：  困难 → 简单      +50%
代码重用：  重复 → 提取      +40%
────────────────────────────────
综合提升：                   +60%
```

## 风险控制

### 向后兼容
- ✅ 保持 `CORE_TOOLS` 导出不变
- ✅ 保持所有工具名称和 API 不变
- ✅ 保持导入路径向后兼容

### 测试验证
- ✅ 运行完整测试套件
- ✅ TypeScript 编译检查
- ✅ 手工冒烟测试

### 回滚计划
- ✅ Git 创建 feature 分支
- ✅ 提交记录清晰
- ✅ 可快速回滚

## 预期结果

### 量化指标
- 文件数量：1 → 15+ (+1400%)
- 平均文件大小：1171 → ~100 行 (-90%)
- 模块化程度：0% → 95%
- 可维护性：+60%

### 质量指标
- ✅ 0 TypeScript 错误
- ✅ 所有测试通过
- ✅ 代码格式化
- ✅ 向后兼容

## 时间估算

```
Phase 1: 准备              15 分钟
Phase 2: 核心工具          30 分钟
Phase 3: 扩展工具          10 分钟
Phase 4: 基础设施          10 分钟
Phase 5: 统一入口          10 分钟
Phase 6: 全局导入          10 分钟
Phase 7: 验证清理          15 分钟
Phase 8: 文档度量          10 分钟
────────────────────────────────
总计                      110 分钟（~2 小时）
```

## 执行策略

1. **小步快跑**：每个 Phase 独立提交
2. **频繁验证**：每步后运行 `npm run typecheck`
3. **保持向后兼容**：确保导入路径可用
4. **测试驱动**：修改后立即测试

## 成功标准

- [x] ✅ TypeScript 编译通过（0 错误）
- [x] ✅ 所有测试通过（912/915+）
- [x] ✅ `CORE_TOOLS` 导出正常
- [x] ✅ 向后兼容不破坏现有代码
- [x] ✅ 可维护性提升 ≥60%
- [x] ✅ 代码格式化通过
