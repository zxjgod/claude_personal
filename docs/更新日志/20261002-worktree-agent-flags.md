# 工作树与会话代理开关对齐官方（v1.6.1 增量·第二轮）

日期：2026-10-02。基线：本机官方 CLI 2.1.202 的 `claude --help`。上一轮补齐了 `--tools`／`--effort`／`-n, --name`／`--debug`／`--debug-file`／`--fallback-model`／`--disable-slash-commands`（见 [上一轮日志](20261002-session-cli-flags.md)）。本轮补齐其中**核心会话语义**的两项：`-w, --worktree` 与 `--agent` / `--agents`。

## 新增能力

| 开关 | 语义 | 与官方一致处 | 明确偏差 |
|---|---|---|---|
| `-w, --worktree [name]` | 在新建 git worktree 中运行整个会话 | 可选名；缺名自动生成；与 `--resume` / `--continue` 互斥 | 会话与 checkpoint 仍存放在**原始检出**而非 worktree 内；会话结束**不**自动删除 worktree |
| `--agent <name>` | 用该 agent 的人设驱动本次会话 | 按名字解析已注册 agent，未知名字报错并列出全部可用名 | 人设**叠加**在默认 identity 之前，而非完全替换它 |
| `--agents <json>` | 仅本次会话生效的内联 agent 定义 | JSON 对象 `名字 → 定义`；`prompt` 为必填 | 额外接受 `systemPrompt` 作 `prompt` 同义词；未知字段告警而非拒绝 |

## 实现要点

### `-w, --worktree`

- **创建时机被刻意前移到权限模式、设置、信任门、CLAUDE.md 读取之前**：这个开关的意义就是"这次会话等价于在那个目录里启动"。若在这些读取之后才切换，工作区配置会来自错误的目录。
- **`sessionStorageRoot` 仍指向原始检出**：会话与 checkpoint 集中存放，不会每个 worktree 散落一份，`/cd` 回主检出也找得到。
- **工作树在 `initSession` 之后才压入会话栈**，因为那时才有 session id；此前所有环节都已经以 worktree 路径作为 `workspaceRoot` 运行。
- **不自动删除**：删除用户数据是不可逆动作，交由用户在确认无未提交改动与未合并提交后自行处理。`--help` 里写明了这一点。
- **名字生成器收敛到 `worktrees.ts` 的 `randomWorktreeName(prefix)`**：Agent 工具的 worktree 隔离与 CLI 现在共用同一实现，因此生成的名字**构造上**就满足 `createIsolatedWorktree` 的校验，而不是碰巧通过。
- 名字非法、非 git 仓库、与 `--resume`/`--continue` 冲突，都直接报错退出（退出码 1），不做静默降级。

### `--agents` / `--agent`

- 新增 `src/agents/inlineAgents.ts`，负责 JSON → `SubagentType` 及校验，**不读 argv**；`cli-session-flags.ts` 只负责取出原始文本。两层职责分开，形状规则可独立测试。
- **校验分两档**：结构性错误（不是对象、缺 `description`／`prompt`、名字不合法、已知字段类型不对）是硬错误；**未知字段只告警**——为更新版本官方写的定义仍能启动，只是明确告知那部分没被读取。两种情况都不会静默丢弃。
- **全有或全无**：只要有一个条目有问题就一个都不注册。只注册恰好合法的子集，会得到"部分请求的 agent 静默消失"的会话——恰恰是这个开关要避免的失败模式。
- **`tools` 省略 = 继承父级工具集**，与 `.md` 加载器一致；读成"零工具"会给用户一个什么都做不了的 agent。
- **注册时机在 `setupTools` 之后**：命令行上手敲的定义优先级高于同名磁盘／插件 agent。
- **`--agent` 名字未知直接报错并列出全部可用名**：一个拼写错误静默退回默认人设，与开关生效看起来完全一样。
- **`--agent` 后接下一个开关会报错**：否则 `--agent --print` 会被当成"选择一个叫 `--print` 的 agent"，同时悄悄丢掉 print 模式。

### 人设注入方式（与官方的一处有意偏差）

`--agent` 的 prompt 以 `[SESSION AGENT: <name>]` 段**前置**到 identity 段，而不是替换 identity。理由：coding rules、工具说明、权限边界这些 harness 契约正是让模型对自己"实际能做什么"保持诚实的东西，agent 定义不该有能力把契约抹掉。`--help` 与本日志都写明这是偏差。

identity 段的缓存键按 agent 名单开（`identity:agent:<name>`），因此切换人设只重算这一段，不会让整个静态前缀（provider 缓存）失效。

## 回归与验证

`src/__tests__/cli-session-flags.test.ts` 增至 **47 项**（上一轮 25 项），本轮新增 22 项，覆盖：

- 三个开关的解析契约（可选名 vs 必填值、缺值报错、`-w` 后接开关即视为无值）；
- `randomWorktreeName` 生成的 20 个名字全部满足校验正则；
- **真实 git 仓库**中创建 worktree：文件存在、分支为 `codex/<name>`、HEAD 等于 base commit、`git worktree list` 能看到；非法名字与非 git 目录都按预期报错（名字校验必须在真仓库里才够得着，否则会被 git 前置条件掩盖——第一版测试就踩了这个坑）；
- `--agents` 12 类结构错误逐条断言错误信息点名了**哪个 agent 的哪个字段**，且一次报出全部坏条目而非只报第一个；
- 未知字段告警但仍注册；一个条目坏掉则一个都不注册；
- 人设段位于默认 identity 之前；`CODING RULES` 不会被 agent 定义抹掉；A 人设不泄漏到 B 人设（identity 段是记忆化的，共用键会串味）。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：**186 个文件、2,348 项测试全部通过**。
- `npm run build` + `npm run smoke`：通过。
- `npm run docs:sync -- --check`：通过（`docs/项目总览.md` 指标已同步为 55,464 行 / 269 源文件 / 186 测试文件 / 2,348 用例）。
- **实机核对**（真实 provider，非 mock）：
  - `--agents '{"terse":{…}}' --agent terse -p` → 打印 `Session agents: terse` / `Session agent: terse — Answer in one line`，模型按人设作答；
  - `--agent definitely-not-an-agent -p` → `Unknown --agent "…". Available agents: code-explorer, code-reviewer, general`；
  - 在真实 git 仓库中 `-w probe --verbose -p` → 打印 `Worktree: …\.claude\worktrees\probe (branch codex/probe, from 4908c6b1)`，且 `Workspace:` 指向 worktree 而非原目录；
  - 裸 `-w` → 自动生成 `ccr-b519660c` 并正常完成一轮问答；
  - 探针仓库与其两个 worktree 已全部删除。
- 未调用真实模型之外的任何付费接口；本地平台为 Windows，本地检查不能代替远端 CI。

### 一个实测到的使用约束（不是缺陷）

在 PowerShell / cmd 下把 JSON 直接写进 `--agents` 会被 shell 剥掉双引号（`SyntaxError: Expected property name or '}'`）。这是 shell 引号规则，不是本项目的解析缺陷——官方面对同一命令行也如此。绕过方式是用能精确控制 argv 的调用方（`spawnSync` 的参数数组、bash 单引号等）。已知行为，记录在此以免下一个人重复踩。

## 本轮未覆盖（留待下一轮）

同一份官方 `--help` 里**仍未实现**、不应在文档或回复中暗示已具备的开关：

- `--include-hook-events`（stream-json 输出 hook 生命周期事件，影响消费方契约）、`--prompt-suggestions`、`--from-pr`、`--betas`、`--brief`、`--file`、`--tmux`、`--ax-screen-reader`；
- 跨进程后台会话入口 `--bg` 与 `claude agents`。

建议下一轮优先 `--include-hook-events`：它是自动化消费方的契约面，比其余开关影响面更大。