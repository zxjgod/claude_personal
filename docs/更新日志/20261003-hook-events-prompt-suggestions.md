# 流式输出契约对齐官方（v1.6.1 增量·第三轮）

日期：2026-10-03。基线：本机官方 CLI 2.1.202 的 `claude --help`。第一轮补齐了会话级开关（见 [第一轮日志](20261002-session-cli-flags.md)），第二轮补齐了工作树与会话代理（见 [第二轮日志](20261002-worktree-agent-flags.md)）。本轮补齐**自动化消费方契约**相关的两项：`--include-hook-events` 与 `--prompt-suggestions`。

选这两项的理由：官方 `--help` 里仍未实现的开关中，它们是唯二直接影响 `--output-format stream-json` 消费方的——前者决定自动化能看见哪些 hook 生命周期，后者给每轮结果追加一条可写入草稿框的预测帧。影响面大于其余纯交互类开关。

## 新增能力

| 开关 | 语义 | 与官方一致处 | 明确偏差 |
|---|---|---|---|
| `--include-hook-events` | 把 hook 生命周期帧写进 stream-json 输出 | 三种官方 subtype（`hook_started`／`hook_progress`／`hook_response`）的字段名与形状；官方事件名白名单；`hook_name` = `${event}:${matcher}`；SessionStart／Setup 无条件上报 | 只上报 **settings.json 声明的 hook**（进程内回调没有独立进程可观测）；官方"未解析 stdout 变更"的进度节流按 1 秒实现 |
| `--prompt-suggestions [value]` | 每轮结束后预测下一条用户提示，输出一帧 `prompt_suggestion` | 帧位置在 `result` **之后**；只在 `--output-format stream-json` 下出现；失败时省略该帧 | 官方调用专用 suggestion 端点，本项目复用会话模型；官方带"同一条预测不重复输出"的去重，本项目未实现 |

## 实现要点

### 事件出口放在「执行层」而不是「注册层」

生命周期帧必须由**拥有真实生命周期的那一层**产出。本项目的 `HookRegistry` 里混着两种 hook：

- `hooks-config.ts` 从 `.claude/settings.json` 载入的 hook —— 会真的 spawn 子进程，有 stdout/stderr/退出码/超时/被杀；
- 程序内注册的回调 hook（如测试与插件代码直接 `registry.register(...)`）—— 同步跑完，没有可观测的进程边界。

官方同样**只为 command/http/agent/mcp 这类 hook 发帧**，`type:"callback"` 分支直接 return、不进发帧函数。因此本项目也只在 `runSpecs()` 的每个 spec 前后发帧。若挂在 `HookRegistry` 上，会出现两个后果：配置 hook 被发两遍（一次空的、一次带输出的），且回调 hook 凭空多出官方没有的帧。

### 事件清单与命名规则来自官方二进制，不是推测

`hookEvent` 白名单与两条门控规则直接取自本机官方 CLI 2.1.202 的实现：

- 允许上流的 31 个事件名（`PreToolUse` … `MessageDisplay`）构成白名单，**名单外的事件名永不上流**——消费方对没有契约的 subtype 无从解释；
- 门控不是"有没有开关"这么简单：`SessionStart` 与 `Setup` **无条件上报**，其余事件才需要 `--include-hook-events`；
- `hook_name` 在配置项带 matcher 时是 `${hook_event_name}:${matcher}`，否则是裸事件名。

这三条容易凭直觉写错，因此 `src/hook-events.ts` 顶部逐条注明出处。

### 帧结构（`src/hook-events.ts`）

`hookLifecycleMessage()` 是唯一构造帧的地方，`session_id`／`uuid` 在此附加，与官方"每帧冲刷时统一补齐"一致：

```
{"type":"system","subtype":"hook_started","hook_id":…,"hook_name":…,"hook_event":…}
{"type":"system","subtype":"hook_progress",…,"stdout":…,"stderr":…,"output":…}
{"type":"system","subtype":"hook_response",…,"output":…,"stdout":…,"stderr":…,"exit_code":…,"outcome":…}
```

`exit_code` 仅在有退出码的 hook 类型上出现（HTTP 用状态码，prompt/agent/mcp 没有）。

### outcome 分类：把「hook 坏了」暴露到流上，但不改变失效保护

五档与官方一致：`success`／`blocking`／`non_blocking_error`／`cancelled`／`error`。分类里新增的一档判断是 `malformed`——**hook 跑了但产出不可读**（非零且非 2 的退出码、无可解析 JSON、stdin 写失败、spawn 失败）。

这里刻意把两件事分开：

- **执行语义不变**：坏 hook 仍然被当作 no-op（allow / continue）。改掉这一条会破坏项目既定的失效保护方向，代价是"一个拼错的 hook 脚本能锁死用户的会话"。
- **流上可见**：它不再静默。`non_blocking_error` 让自动化能告警"你的 hook 没按协议输出"，这正是这批帧存在的意义。

`cancelled` 覆盖超时（官方同为 `hook_cancelled` + `timed_out`），与"HTTP 状态码不对"的 `error` 区分开：前者是超时哨兵对象，后者是传输失败。

### hook_progress 的节流从"钩子起始时刻"起算

官方是 1 秒轮询、且仅在输出**有变化**时才发。实现里 `lastProgressAt` 初值取本次 hook 的起始时刻而非 0——否则第一块 stdout 就会触发一帧，让"1 秒内跑完的 hook 也发进度帧"。测试同时锁住两端：快 hook 只发 `started`+`response`，跨过 1 秒边界的慢 hook 必须出现 `hook_progress`。

### sink 的安装时机必须早于 SessionStart

`cli.ts` 在 `initSession` 之后、**任何 hook 运行之前**安装 sink（仅 `--print` + `stream-json`）。若等到 `runHeadless` 里再装，`SessionStart` 事件（`cli.ts` 中在进入 print 分支之前就跑了）会被整个丢掉——而它恰好是官方**无条件上报**的那两个事件之一。

`runHeadless` 同时保留自装能力，供直接调用它的 SDK/测试使用；两者用 `hookLifecycleSinkActive()` 区分，**调用方先装的 sink 不会被抢走、也不会被提前摘掉**——因为 `SessionEnd` hook 在 `runHeadless` 返回**之后**才跑，摘早了它就成了哑巴。`clearHookLifecycleSink()` 放在 `cli.ts` 的 `SessionEnd` 之后。

### `--prompt-suggestions` 的取值解析

官方声明是 commander `[value]`，而帮助文本只列出八个字面量：`true false 1 0 yes no on off`。本项目**只在下一个 token 命中这八个之一时才消费它**——否则 `--prompt-suggestions review the diff` 会把位置参数提示词吞掉。未识别的字面量解析为**启用**：用户确实要了这个功能，把看不懂的值读成"关闭"会静默丢掉用户明确要求的东西。

### 预测调用：成本不隐藏

官方走专用 suggestion 端点。第三方 OpenAI 兼容 provider 没有对应端点，于是复用**会话模型**：一次无工具、`maxTokens=120`、`temperature=0` 的短补全，整条回复就是预测结果。

三点是刻意的：

- **走 `budgetCaller`**，预测的花费计入 `--max-budget-usd`，不绕过预算闸门；
- **永不抛出**：API 失败、被 abort、返回空，都只表现为"这一轮没有建议帧"，不会改变该轮的成败；
- **失败轮不预测**：官方条件含 `shouldQuery`，本项目对应的是 `!error`——对已经出错的一轮猜"用户下一步会问什么"没有意义。

模型常见的装饰（代码围栏、`Next prompt:` 前缀、成对引号、多行回复）在 `cleanSuggestion()` 里剥掉——带引号的预测被原样插进草稿框，从不是用户想要的。事件帧在 `result` **之后**发出，保证按序读取的消费方先看到本轮结束。

## 回归与验证

新增 `src/__tests__/hook-events.test.ts`（21 项），`src/__tests__/cli-session-flags.test.ts` 增至 **52 项**（本轮新增 5 项）。覆盖：

- **门控两条规则**：SessionStart 无开关也上报、PreToolUse 需要开关；名单外事件名不注册也不发帧；
- **帧结构逐字段断言**：`started`／`progress`／`response` 三种形状，`exit_code` 在有/无退出码两种情况下的出现与否；
- **真实子进程 hook 的四种结局**：`success`（带 stdout 与退出码，两个帧共用同一 `hook_id`）、`blocking`（exit 2，阻断原因正确回传）、`non_blocking_error`（exit 3，且执行语义仍是放行）、`cancelled`（超时）；
- **`hook_progress` 两端**：快 hook 无进度帧、跨 1 秒边界的慢 hook 有；
- **预测生成**：清洗各类装饰、API 失败降级为无建议、无上下文时不调用模型、`maxTokens` 受限、不传工具；
- **端到端帧序**：`prompt_suggestion` 紧跟在 `result` 之后；无开关不发；text 模式不发（没有流可承载）；失败轮不发；
- **sink 归属**：调用方先装的 sink 在 `runHeadless` 之后仍然有效（CLI 的 `SessionEnd` 依赖这一点），独立调用者自装的 sink 在结束后被释放。

### 实机核对（真实 provider）

- `-p "What is 2+2? ..." --output-format stream-json --prompt-suggestions` → `result` 帧 `result:"4"`，其后紧跟
  `{"type":"prompt_suggestion","suggestion":"What is 3+3? Answer with just the number.","session_id":…,"uuid":…}`，帧序与字段与官方一致。
- `--include-hook-events` + 临时用户配置目录（`CCR_USER_CONFIG_DIR`）里三个真实 hook 脚本，提示词要求"读 package.json 再执行 `echo hi`"：

  | 帧 | hook_name | outcome | exit_code | 说明 |
  |---|---|---|---|---|
  | `hook_started` → `hook_response` | `SessionStart:*` | `success` | 0 | **无开关也会报**（官方硬编码的两个事件之一） |
  | `hook_started` → `hook_response` | `PreToolUse:Read` | `success` | 0 | 带真实 stdout |
  | `hook_started` → `hook_response` | `PreToolUse:Bash` | `blocking` | 2 | 真实阻断，模型收到原因并改口 |

  每个 `hook_started` 与其 `hook_response` 共用同一 `hook_id`；`tool_name` 未归一化不影响匹配（matcher 大小写不敏感）。过程中还意外撞到一次
  `outcome:"non_blocking_error"`（`exit_code:1`，stderr 是 cmd.exe 吃掉引号后的 Node 语法错误）——**坏 hook 被当作 no-op放行**，正是预期的失效保护加流上可见。探针脚本与临时目录已删除。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：**187 个文件 / 2,374 项测试全部通过**（上一轮为 186 / 2,348）。
- `npx biome check src`：无 error（仅项目既有的非空断言等 warning；共 727 条）。
- `npm run build` + `npm run smoke`：通过（transpiled 271 files）。
- `npm run docs:sync -- --check`：通过（`docs/项目总览.md` 指标同步为 56,090 行 / 271 源文件 / 187 测试文件 / 2,374 用例）。
- 顺带清掉三处让 `biome check src` 退非零的既有问题：`cli.ts` 的未使用导入 `resolveMaxTurns`、`agent-guards.test.ts` 的未使用导入 `listJobs`，以及 `cli-tools.ts` 的格式漂移。

### 一处测试环境约束（非缺陷，已记录）

hook 子进程的 cwd 设为 workspace 根，因此测试**不使用临时目录**：Windows 上被杀的 hook 进程会锁住自己的 cwd，导致临时目录清理抛 `EPERM`，进而把该文件后续所有用例一并判失败（本轮实跑踩过一次，21 项里 15 项连带失败）。改用 `process.cwd()` 后消失。已有的 `hooks-config.test.ts` 同样使用临时目录，其用例均为短命进程，未触发该问题。

## 本轮仍未覆盖（留给下一轮）

官方 `--help` 中*仍未实现*、不应在文档或回复中暗示已具备：

- `--from-pr`、`--betas`、`--brief`、`--file`、`--tmux`、`--ax-screen-reader`；
- 跨进程后台入口 `--bg` 与 `claude agents`。

建议下一轮优先 `--brief`：它是 `--print` 的输出形态开关，与本轮刚补齐的 stream-json 契约同属一条线，且实现面比 `--bg` 小得多。