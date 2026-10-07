# 2026-10-03 — `--brief` 简报通道（SendUserMessage）

> Loop 第四轮。目标：补齐官方 `--brief`。
> 校验：`npm run typecheck` 通过；`npm test` **188 文件 / 2,388 用例全通过**（上轮 187 / 2,374，+1 文件 +14 用例）；
> `npx biome check src` **零 error**（727 warnings，全为既有 `noNonNullAssertion` / `useTemplate` ratchet，与上轮同数）；
> `npm run build` transpiled 272 files；`npm run smoke` PASSED；`doc-sync --check` 全 ✓。

## 一、为什么这个 flag 不是它看起来的样子

上一轮排期时把 `--brief` 记作"print 输出形态开关"。**这是错的**，本轮先做二进制考古推翻了自己：

官方 help 原文只有一句

```
--brief    Enable SendUserMessage tool for agent-to-user communication
```

它与 `--print` / `--output-format` 毫无关系。继续在 240MB 二进制里按字节搜索，定位到一个独立常量池：

```js
ct(aRe, {
  BRIEF_TOOL_NAME:        () => "SendUserMessage",
  LEGACY_BRIEF_TOOL_NAME: () => "Brief",          // 旧名，已被取代
  DESCRIPTION:            () => "Send a message to the user",
  BRIEF_TOOL_PROMPT:      () => "Send a message the user will read. Text outside this tool is visible in the detail view, but most won't open it — the answer lives here.\n\n…",
  BRIEF_PROACTIVE_SECTION:() => "## Talking to the user\n\n…",
  BRIEF_ENFORCE_SENTINEL: () => "You ended the turn without calling SendUserMessage.",
  PEWTER_OWL_TOOL_PROMPT: () => "Send a message the user will read verbatim. Use this for content they need to see exactly as written between tool calls…",
});
```

由此确定了实现面：**工具本身就是这个开关的全部内容**。参数为 `message`（必填，markdown）、`attachments`、`status`（`normal` / `proactive`）。

另外顺带在同一二进制里看到官方还有 `SendUserFile`（`SEND_USER_FILE_TOOL_NAME`）与 settings 键 `briefView.defaultView`（`chat` = 只看 SendUserMessage 检查点 / `transcript` = 全量）——均属另一块投递/视图能力，本轮未做，见第五节。

## 二、实现

### 新增

| 路径 | 内容 |
|---|---|
| `src/tools/extended/send-user-message.ts` | `SendUserMessageTool`，官方名称/描述/参数，`call()` 做投递与附件校验 |
| `src/__tests__/brief-send-user-message.test.ts` | 14 项测试 |
| `docs/更新日志/20261003-brief-send-user-message.md` | 本文件 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/cli-session-flags.ts` | `parseBriefFlag()`——裸布尔，不消费取值 |
| `src/cli-args.ts` | `CliArgs.brief` |
| `src/cli-tools.ts` | `parseBriefFlag` 为真时注册 `SendUserMessageTool` |
| `src/system-prompt.ts` | `SystemPromptOptions.brief` + `buildBriefChannelSection()`，挂在**静态前缀**末尾 |
| `src/cli.ts` | 把 `cliArgs.brief` 透进 `buildSystemPrompt` |
| `src/cli-env.ts` | help 增补 `--brief`（含全部偏差说明） |
| `docs/项目总览.md` | 指标 + 本日志链接 |
| `docs/20261002-claude-code差距评估.md` | 新增核验小节，`--brief` 移出"仍未实现" |

### 三条实现决策

**1. 工具只在 `--brief` 下注册，且注册点早于 `--tools`**

无条件注册会让每个默认会话都向模型兜售一个用户没要过的通道。放在 `applyToolSelection` 之前，则 `--tools Read,SendUserMessage` 这种"只要这一个"的写法才真正成立——否则注册晚一步会被静默忽略。两条都有测试。

**2. 消息本身即结果，不引入新协议**

`content` 就是消息原文，`formatResult` 只回 `content`（绕开默认格式化器给每条用户要读的消息追加的 `[0ms]`）。这样**不新增任何流式帧类型**：交互模式走既有的工具卡渲染，`--output-format stream-json` 走既有的 `tool_result.content = formatted`，消费方零改动。没有证据支持官方另有专用帧，就不去发明一个。

**3. 提示块放静态前缀，不是动态后缀**

`--brief` 是进程级开关，一会话内不变，所以放缓存前缀里，开了的会话只付一次；没开的会话保持原来更短的前缀不被撑大。测试锁住它位于 DYNAMIC_BOUNDARY 之前。

## 三、明确记录的偏差

### 偏差 1：`attachments` 只接受路径，对象形式报错拒绝

官方接受两种：文件路径，或 `{file_uuid, file_name, size, is_image}` 精确对象。后者指向设备端上传通道——本项目没有对应物，模型也不可能合法持有这种引用（拿到只可能是幻觉）。按 fail-closed 处理：**报错并点名**（"references a device upload channel this CLI does not have"），而不是静默丢弃——静默丢弃会让模型以为附件挂上了。路径形式走 `resolveAllowedWorkspaceFile`，逃出工作区 / 命中屏蔽路径一律拒绝。

### 偏差 2：提示段没有照抄官方的可见性断言

官方 `BRIEF_PROACTIVE_SECTION` 的核心论断是："工具外的文字，用户展开 detail view 才看得见，多数人不会展开，所以**假定没人看**"。

那是官方 chat view 的事实。**本终端里普通助手文字完全可见**（`cli-repl.ts` 逐字渲染）。照抄这段会教模型不信任用户真正读得到的输出，让它在 `--brief` 下反而变差。因此：

- 保留行为内核：ack → work → result、只在相位边界发 checkpoint 而非"running tests..."式填充、第二人称、消息要短
- 去掉那条断言，改成对本终端成立的说法：SendUserMessage 是"不经由其他工具调用、逐字送达"的专用通道
- 测试 `does not repeat official's detail-view claim` 专门锁住这一点，防止日后有人"顺手对齐"回去

### 偏差 3：`status:"proactive"` 不触发任何特殊路由

照收照校验，但本项目没有后台投递通道，`proactive` 不比 `normal` 走任何不同的路——那是 `--bg` / `claude agents` 的地盘。

## 四、实机核对（真实 provider）

```
node dist/cli.js --brief -p "Say exactly one short line to the user using SendUserMessage: what is 2+2? Then stop." --output-format stream-json
```

`init` 帧的 `tools` 里出现 `SendUserMessage`（54 个工具）；模型随即调用：

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"SendUserMessage","input":{"message":"2 + 2 = 4.","status":"normal"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"2 + 2 = 4.","is_error":false}]}}
```

逐字送达、渲染不带耗时后缀、单轮结束——均符合预期。**未验证**的部分：交互模式下的工具卡渲染（本轮未开 TUI 手工核对，只由既有渲染路径与单测覆盖）。

## 五、明确未实现（不应暗示已具备）

- **settings `briefView.defaultView`**（chat = 只看 SendUserMessage 检查点 / transcript = 全量）——TUI 视图层，本轮未做。这其实是官方 `--brief` 在交互体验上的另一半
- **`BRIEF_ENFORCE_SENTINEL`**："You ended the turn without calling SendUserMessage."。二进制里确认存在该常量，但通过导出对象读取，压缩后无法定位触发条件；触发时机靠猜会写出错误行为，本轮不实现（提示段已承担引导职责）
- **`PEWTER_OWL_TOOL_PROMPT` / `SendUserFile`**：服务于官方的手机/桌面投递通道，本项目无对应物
- **对后台 agent 的主动投递**：`--bg` / `claude agents` 未实现

## 五、仍然未实现的官方开关

`--from-pr`、`--betas`、`--file`、`--tmux`、`--ax-screen-reader`，以及跨进程后台会话入口 `--bg` / `claude agents`。

## 六、测试

新增 14 项，四组：

1. **解析**（2）：裸布尔；`--brief review the diff` 不得吞掉位置参数；透进 `CliArgs`
2. **注册**（2）：默认不注册、`--brief` 注册且 registry 与 live 数组一致；`--tools` 双向作用（只要它 / 排除它）
3. **工具行为**（6）：逐字送达且渲染不带 `[0ms]`；纯空白消息拒绝；`status` 不污染正文；工作区相对路径解析成功；`../../etc/passwd` 逃逸拒绝；设备上传对象形式报错并点名文件
4. **提示段**（4）：默认缺席；出现且含行为指引；不含 `detail view`；位于静态前缀

其中一条测试假设在编写时被推翻并修正：最初把工作区临时目录建在 `describe` 作用域，`afterEach` 在第一个用例后就把它删了，导致后续用例写文件 ENOENT——改为每个用例自建。