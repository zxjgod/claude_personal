# 更新日志 — 对齐官方 Claude Code 的五大能力补齐

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-13
> 类型：feature
> 模块：自定义命令（commands/loadCommandsDir）、自定义子代理（agents/loadAgentsDir）、输出风格（output-style）、配置驱动 hooks（hooks-config）、测试基建（vitest 纳入 tsx）、frontmatter 工具
> 主题：补齐与官方 Claude Code 对齐的五项用户可感知能力 + 修复 vitest 漏跑 `.test.tsx`
> 状态：已落地
> 验证：`npm run typecheck` 通过、`npm test` 87 文件 / 1,064 用例全过、`npm run build` 157 文件、`npm run smoke` PASSED、`npm run check` 0 错误、`npm run docs:sync -- --check` 全绿
> 关联 commit：〈待提交〉
> 关联文档：`docs/项目总览.md`、`docs/项目架构.md`（数字已同步）

---

## 一、现象 / 用户反馈

对照官方 Claude Code 盘点差距后，归类出五类「用户可感知但本仓库缺失」的能力：

1. **自定义斜杠命令**（`.claude/commands/*.md`）—— 官方支持用户在项目/用户目录定义自己的 `/命令`，本仓库只有 39 条内置命令。
2. **自定义子代理**（`.claude/agents/*.md`）—— 官方支持自定义 agent 定义，本仓库子代理类型硬编码在 `subagents.ts`。
3. **输出风格**（`/output-style`）—— 官方有 default/explanatory/learning 等响应风格预设，本仓库 OUTPUT STYLE 段写死为「简洁」一种。
4. **配置驱动 hooks**（`.claude/settings.json`）—— 官方 hooks 是 settings.json 里的 shell 命令，本仓库 `HookRegistry` 只能程序化注册（`cli.ts` 里空注册，`/hooks` 提示「在 cli.ts 或 project config 注册」却无 config 加载器）。
5. **测试漏跑**—— `vitest.config.ts` 的 include 只匹配 `*.test.ts`，7 个 `.test.tsx` TUI 组件测试写了却没跑（文档亦标注「`*.test.tsx` 当前不在 `npm test` 内」）。

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | 无磁盘命令/子代理加载器，skill 已有 `loadSkillsDir` 但 commands/agents 没有对应实现 | `src/commands/`、`src/agents/`（缺失） | 无法扩展 `/命令` 与子代理 |
| 2 | OUTPUT STYLE 段 `buildOutputStyleSection()` 无参数、无注册表 | `src/system-prompt.ts` | 风格不可切换 |
| 3 | `HookRegistry` 只有内存注册、无 settings.json 加载；`matching()` 只支持严格相等 + `*`，不支持正则 matcher | `src/hooks.ts` | 无法用配置文件声明 hook |
| 4 | `vitest.config.ts` include 漏 `.test.tsx` | `vitest.config.ts` | 7 个 TUI 测试从不执行 |
| 5 | frontmatter 解析器私有于 `loadSkillsDir`，三个 `.md` 加载器会各自实现 | `src/skills/loadSkillsDir.ts` | 解析行为分叉风险 |

## 三、改动明细

### 共享 frontmatter（新增 `src/utils/frontmatter.ts`）

把 `loadSkillsDir.ts` 内私有的 `parseFrontmatter` 提为共享实现；`loadSkillsDir.ts` 重导出保持兼容（`ParsedSkillFile` 别名）。三个 `.md` 加载器（skills/commands/agents）共用同一解析。

### 自定义斜杠命令（新增 `src/commands/loadCommandsDir.ts`）

- 扫描 `~/.claude/commands` + `<root>/.claude/commands` 的 `<name>.md`，注册为 prompt 注入命令。
- 模板展开：`$ARGUMENTS` / `${ARGUMENTS}` / `${ARGS}`、位置参数 `$1..$9`、`` !`cmd` ``（受信 shell，同 skill 信任模型）。
- `commands.ts`：`handleSlashCommand` 在 `COMMAND_MAP` 未命中后查 `getCustomCommands()`；`help.ts` 改 `bindCommandList` 为惰性 getter，`registry.ts` 绑定 `[...COMMANDS, ...custom]` 使 `/help` 运行期合并显示。
- `cli.ts` 启动时 `loadCommandsDir(workspaceRoot)`。

### 自定义子代理（新增 `src/agents/loadAgentsDir.ts`）

- 扫描 `~/.claude/agents` + `<root>/.claude/agents` 的 `<name>.md`，frontmatter `name`/`description`/`whenToUse`/`tools`/`maxTurns`/`memory` → `SubagentType`，body 为 system prompt。
- `cli.ts` 启动时 `loadAgentsDir(workspaceRoot)`；`/agents` 与 Task 工具 `subagent_name` enum 自动可见。

### 输出风格（新增 `src/output-style.ts` + `/output-style` 命令）

- 注册表内置 default/explanatory/learning，`outputStylePrompt(name)` 未知名回退 default。
- `system-prompt.ts`：`buildOutputStyleSection(style)` 参数化，memoize key 改为 `output_style:${style}`（切换风格只重算该段，前缀其余仍缓存）。
- `cli.ts`：`buildTurnSystemPrompt()` 每轮重建（读 `outputStyleHolder` + `goalHolder`），替换原 `const systemPrompt` 拼接；`CommandContext` 增 `outputStyle?` holder。
- 新增 `/output-style`（无参列样式 + 高亮当前；`/output-style <name>` 切换）。

### 配置驱动 hooks（新增 `src/hooks-config.ts`）

- `readSettings()` 合并 `.claude/settings.json` + `settings.local.json`（local 优先）；`parseHooksConfig()` 容错解析 `PreToolUse`/`PostToolUse`/`Stop`。
- `buildPhaseHook()` 把每条命令包装为 `Hook`：`spawn(command, { shell: true })` 跑 shell，JSON 走 stdin、stdout JSON 的 `decision` 字段裁决；`shell: true` 规避 Windows `cmd /c` 引号剥离 bug（含空格路径如 `Program Files`）。
- `hooks.ts` `matching()` 扩展支持正则 matcher（`Edit|Write`），对纯工具名向后兼容。
- **fail-open**：命令出错/超时/非 JSON → 视为 `{}`（放行），损坏的 hook 永不阻断用户。
- `cli.ts` 启动时 `loadHooksFromSettings(workspaceRoot, hooks)`。

### 测试基建

- `vitest.config.ts` include 增 `src/**/*.test.tsx`（7 个 TUI 测试纳入 `npm test`）。
- `scripts/doc-sync.mjs` `isTestFile` 增 `.tsx` 匹配（与 vitest include 对齐）。
- 新增 4 个测试文件：`loadCommandsDir` / `loadAgentsDir` / `output-style` / `hooks-config`（24 用例）。

## 四、验证结果

- `npm run typecheck`：0 错误。
- `npm test`：87 文件 / 1,064 用例全过（原 76 文件 / 957 用例 + 7 个 tsx + 4 个新模块）。
- `npm run build`：157 文件（原 151）。
- `npm run smoke`：PASSED。
- `npm run check`：0 错误（5 个预存 warning 非阻塞）。
- `npm run docs:sync -- --check`：全绿。

## 五、已知边界（非本次范围）

- 自定义命令/子代理的 `model` frontmatter 仅解析、不覆盖会话模型（子代理继承父模型配置）。
- hooks 仅实现 PreToolUse/PostToolUse/Stop 三阶段；官方还有 UserPromptSubmit/SessionStart/Notification 未接。
- 自定义命令在 TUI 的 `/` 自动补全列表里暂不出现（分派仍生效，`handleSlashCommand` 两条路径共用）。
