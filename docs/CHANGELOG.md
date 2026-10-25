# 更新日志 (Changelog)

> 安装版本以 `package.json` 的 `version` 为准。每个版本使用 `## v版本号` 标题，并提供非空的“使用影响”段落；构建会校验当前版本。旧版和未标明版本的记录保留为历史资料。

## v1.6.1

### 使用影响

- **受控循环进度锚定（2026-10-25 本地增量）**：`/loop` 默认启用进度文件 `.claude/loops/<session>.progress.md`，对抗长循环中聊天历史自动压缩导致的质量衰减——启动时写入模板（Objective/Done/Key findings/Next plan/Blockers），每轮系统指令要求模型把累计状态更新进该文件，每轮注入消息重新携带其当前内容（约 12,000 字符截断，回放不显示重注入段），最终 wrap-up 轮要求写入 `## Final Report`（结果对照、验证证据、交付物、遗留问题），停止/完成时运行时追加带时间戳的备注。settings.json 的 `loop.profiles.<profile>.progressFile` 可关闭。另：启动任务若未配置任何完成检查（命令/文件），命令行与菜单都会提示补配，避免循环只能依赖模型自评结束。
- **全面代码审查修复（2026-10-24 本地增量）**：六域审查（权限安全 / 子代理 / 持久化调度 / 模型 MCP / CLI·TUI·SDK / 构建发布）后集中修复。安全：always-allow 存储迁移到用户目录并按工作区分键（仓库不再能预置免审批）；项目 agent 的 hooks 与预加载 skill 的 shell 指令进入一次性指纹信任门；权限命令分段补齐裸 `&` 与换行；Windows 引号语义（`%VAR%` 展开、单引号重定向）纳入只读判定；shell/沙箱改用 System32 绝对路径杜绝 CWD 劫持；文件权限规则按解析路径匹配；`@file` 拒绝指向工作区外的符号链接；hooks 信任库不再回退到仓库目录；`/cd` 重载新工作区的权限策略与记忆审批；SSRF 私网识别覆盖 6to4。数据：checkpoint 读错误不再被当作"文件不存在"导致误删（ENOENT 与 EACCES 三态区分，索引写入/GC 加跨进程锁）；审计日志并发写不再丢条目；durable 一次性任务改为"投递后才删除"，跨进程注册/触发/删除加文件锁并双向合并，`+N` 延时改用单调时钟，recurring 忙时按到期分钟入队不再吞次；同进程 `/resume` 不再覆盖存活的后台任务与 team 成员；双终端保存改为公共前缀合并、退出保存等待锁。模型/MCP：`@modelcontextprotocol/sdk` 升级至 1.32.1（修复 GHSA-6qxp-vccf-f47h / GHSA-6prh-2h8m-c8cw），旧未绑定 issuer 的令牌一次性作废重授权；Anthropic 缓存断点避开 thinking 块、`pause_turn` 进入有界续写、缓存断裂检测修复 scope、无法压缩的超长上下文直接报错不再重试；MCP 非文本与结构化结果可见；`finishAuth` 有超时；agent 作用域 MCP 连接失败如实报错。CLI/TUI/SDK：`ccr -p "指令"` 现在会读管道正文并合并（空闲管道带超时防挂）；TS/Python SDK 对异常退出显式报错；TUI `/exit` 等待最终保存并触发 SessionEnd；`!command` 可取消；空 MCP 表单可退出；合并按键块末尾 Enter 正常提交；TUI resume 回放历史；删除当前会话后轮换新 id 防复活。构建发布：`prepack` 自动构建，`exports` 提供 `./sdk` 等入口，随包发布 `.d.ts` 与 LICENSE；发布包校验改为进程内 Node 解包，不再依赖系统 tar（Windows runner 的 bsdtar 3.8 在英文 locale 下把 npm 写入 ustar 头的 UTF-8 文件名判为不可读并退出非零）；评估脚本无结果帧按失败计；冒烟检查改为驱动真实会话保存。

- **PDF 与多模态（2026-10-08 本地增量）**：PDF 改为本地提取文字与渲染 PNG 页图，再发送给模型，兼容 Kimi 等不支持原生 PDF 的聊天接口。Read 新增 `pages`，默认前 5 页、单次最多 5 页；PDF 最大 20 MiB，本地处理超时或文件损坏会返回工具错误。恢复旧会话时自动转换已有 PDF 附件，避免后续输入持续失败。已知纯文本模型只读取 PDF 文字，图片输入会给出明确提示；自定义接口可设置 `LLM_SUPPORTS_IMAGES=false`。
- **项目收紧（2026-10-07 本地增量）**：发布包仅包含运行代码、SDK、必要示例与用户文档，不再包含 source map、测试源码、历史报告或本地 `.claude` 设置；开发构建仍保留 source map。供应商模板移至 `examples/providers.json`，按需复制到自己的工作区。未接入产品的旧健康检查与资源限制实现已移除，实际 `/doctor`、并发限制和超时控制保持现有行为。
- **受控循环（2026-10-06 本地增量）**：输入 `/loop` 后回车打开二级管理菜单。`Collaborative`、`Autonomous`、`Scheduled`、`Conservative` 分别保存配置，均不限制总时长。`Collaborative`、`Autonomous` 和 `Conservative` 设置最大轮数，倒数阶段注入收敛提示，最后一轮仅做验证与收尾；未通过验收会暂停并保存进度。`Scheduled` 固定周期巡检不限轮数，直到手动停止或预算耗尽。间隔可用左右键调整为3～30分钟；菜单提供状态、暂停、恢复、停止、完成检查、重试与通知、执行历史、限额及恢复时段设置。累计预算计入子代理与评估调用；未知单价使用token限制，启用金额限制前应配置输入／输出单价。程序关闭期间不执行，默认恢复后需手动继续。

- **终端输入与帮助（2026-10-06 本地增量）**：多行消息的上下键现在只移动光标，到首尾行停留；单行或空输入仍可回顾已发送消息。输入 `@` 即显示当前项目的文件，继续输入可筛选，Tab 插入所选路径。按 `?` 打开的帮助页已加宽并统一两列对齐，长介绍完整换行，超出窗口时可用上下键或 PgUp/PgDn 查看。
- **消息与选择器（2026-10-06 本地增量）**：用户消息使用整行灰底和白字；回复带圆点并统一缩进；普通输入框使用两条横线。帮助、通知和选择器使用淡紫色高亮，模型、会话与供应商选择器的当前项圆点为绿色。启动欢迎框保持原样，无需调整主题配置。
- **会话回退（2026-10-06 本地增量）**：空闲时连按两次 Esc，或执行 `/rewind`，选择消息后可恢复对话。恢复对话创建新会话并保留原会话，所选请求回填到输入框；没有代码变更时不显示代码恢复选项。两种摘要分别总结所选消息及之后的内容、或它之前的内容，会调用已配置的模型；摘要失败时保留原对话。文件还原仅覆盖被文件工具记录的修改，手动或 Bash 修改不保证还原。
- **恢复与权限**：`/resume` 会切换目标、定时任务及 MCP 审批的会话归属；修改项目 `.claude/lsp.json` 后需要重新确认信任。MCP 工具定义改变或切换会话后可能再次请求审批，这属于权限重新验证。
- **运行环境**：最低 Node.js 版本为 `22.22.1`。启动前运行 `node --version` 检查；低于该版本时先升级 Node.js，再安装依赖和构建。
- **版本说明（2026-10-06 本地增量）**：`/release-notes` 只显示当前安装版本，标题、列表、加粗和代码示例按 Markdown 渲染。使用 `/release-notes all` 查看全部历史；缺少当前版本或使用影响说明时，构建会明确报错。

### 使用示例

```text
?                      查看快捷键帮助
@                      打开当前项目的文件候选
/rewind                打开会话回退菜单
/resume                选择已保存会话
/release-notes         查看当前版本及使用影响
/release-notes all     查看完整历史记录
```

### 变更依据

- [v1.6.1 审查问题修复与运行环境调整](./更新日志/20261002-review-remediation.md)
- 2026-10-06 本地增量：消息布局、输入与文件补全、帮助页、选择器配色、会话回退和版本说明。
- 2026-10-07 本地增量：发布白名单、无调用代码清理、文档与旧计划归档。
- [2026-10-08 PDF 故障修复与多模态检查](./更新日志/20261008-multimodal-pdf.md)。

---

## v1.6.0 - 2026-10-02

### 使用影响

- **配置迁移**：用户配置默认位于 `~/.claude-code-replica/`，已有 `.claude` 项目配置继续可用，不读取官方登录令牌。旧用户目录需要显式设置 `CCR_USER_CONFIG_DIR`；Windows 下可在 PowerShell 执行 `$env:CCR_USER_CONFIG_DIR = 'C:\path\to\config'` 后启动。
- **只读与排障**：`--safe-mode` 用于禁用自定义扩展排障；需要只读执行时使用 `--read-only` 或 `--permission-mode plan`。`--bare` 跳过扩展和项目指令的自动加载。
- **委派与工作树**：子代理和 fork Skill 保留父会话的权限限制。工作树有修改、独有提交或执行异常时会保留，结束任务后可继续检查成果。
- **LSP 与自动化**：LSP 需要自行安装对应语言服务器。TypeScript 和 Python 自动化接口需要已构建的本地程序；它们使用本项目协议，不能直接假定兼容官方 Agent SDK 的全部控制消息。

### 变更依据

[v1.6.0 全面升级、配置迁移及能力边界](./更新日志/20261002-comprehensive-upgrade.md)

---

## 2026-08-02

### 文档同步 + 测试封闭化

- 新增 `scripts/doc-sync.mjs`（`npm run docs:sync`）一键复核项目指标（版本/行数/文件数/命令数/工具数/测试文件数），`--check` 与 `项目总览.md` 比对，已挂 `.husky/pre-commit` 作警告。
- `new-tools.test.ts` 的 WebFetchTool URL 测试改为 stub `fetch`，不再依赖真实网络（此前受限网络下超时，套件 951/952）。
- `package.json` version 定为 **1.2.0**（唯一版本真源），`项目总览.md`/`架构.md`/`维护方案.md`/`快速开始.md`/`.env.example`/CHANGELOG 同步校正。详见 [`更新日志/20260802-doc-sync-and-hermetic-tests.md`](archive/历史更新记录/20260802-doc-sync-and-hermetic-tests.md)。

---

## v1.2.0 - 2026-07-11

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

## 2026-07-09

### 安全 / 工程基建 / i18n（`f471601`）

- **token 估算**：新增 `src/token-estimator.ts` —— 分档估算（代码 3.0 / 自然语言 3.5 / 结构化数据 2.5 字符-token）。
- **错误恢复模块化**：从 agent-loop 拆出 `src/error-recovery.ts`，集中错误分类与恢复策略。
- **审计日志**：新增 `src/audit-log.ts`，追踪破坏性操作。
- **文件缓存**：新增 `src/file-cache.ts`（LRU 淘汰 + mtime 校验）—— 后随 07-11 重构移除。
- **i18n 国际化**：新增 `src/tui/i18n.ts`，中/英文双语；错误消息统一为英文。
- **vitest 配置**：新增 `vitest.config.ts`（include `src/**/*.test.ts`、排除参考目录），修复 `npm test` 超时（移除非法 `--dir` 标志）。

**测试**：新增 audit-log / file-cache / i18n 测试共 34 个（合计 947 通过）。

---

## 2026-07-08

### 安全与架构修复（`0ca3cd4`：S-2 / S-4 / P1-1 / P1-4 / M-7）

详见 [`更新日志/20260708-three-week-security-architecture-fixes.md`](archive/历史更新记录/20260708-three-week-security-architecture-fixes.md)。

- **S-2 子代理权限继承**：Team 子代理改用 `createSubAgentApprover()`，破坏性工具（bash/write/edit）不再绕过父级审批，与 task.ts fork 模式一致。
- **S-4 统一 usage 口径**：移除 Anthropic 路径的 cache token 重复计数，`input_tokens` 用 provider 上报值。
- **P1-1 WebFetch 统一 URL 校验**：改用 `InputValidator.validateUrl()`，删除重复的 BLOCKED_HOSTS 实现（-45 行）。
- **P1-4 MCP schema 类型安全**：拒绝非对象属性，防恶意 schema 注入。
- **M-7 异步 I/O**：session-memory 改用 `fs/promises`，避免大会话文件阻塞事件循环。

### 代码审查修复（M41 改动复审）

对未提交的 M41 改动（输入历史导航 + Emacs 行编辑 + highlight.js 语法高亮 + 结构化错误显示）进行代码审查，修复 4 个问题并清理死代码。详见 [`更新日志/20260708-code-review-fixes.md`](archive/历史更新记录/20260708-code-review-fixes.md)。

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
| `41321e1` | refactor: architecture improvements and quality fixes (P1-P2) |
| `f471601` | fix: security, architecture, i18n improvements (P0-P3) |
| `0ca3cd4` | fix: security and architecture improvements (S-2, S-4, P1-1, P1-4, M-7) |
| `eda2a18` | feat: M41 TUI upgrades — history, syntax highlight, confirm prompt, risk levels |
| `7f30422` | fix: code review — abort delay, HTML entity decode, --force flag, and cleanup |
| `dd121f3` | feat: 工具系统全面升级 - promptDescription 补充 + Zod 迁移 |
| `0334c9f` | fix: correct path-security symlink test setup and add update log |
| `7187011` | Enhance Stability |
| `7d12aa9` | security: prevent symlink escape via realpath check in resolveInWorkspace |
| `600f45e` | security: harden command validation and path traversal checks |
| `fbc3035` | docs: 生成最终完成报告 |
| `e5f9432` | docs: 更新项目文档 - 反映鲁棒性提升成果 |
| `6abeb99` | test: 修复最后的测试 - 100% 通过率达成！ |
| `0a6feac` | test: 修复所有测试 - 100% 通过 |
| `535b9c5` | docs: 项目完成 - 鲁棒性提升总结报告 |
