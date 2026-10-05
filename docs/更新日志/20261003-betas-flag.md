# `--betas <betas...>` — 用户可请求的 API beta 头（2026-10-03）

对标本机官方 CLI **2.1.202**。本轮实现官方 `--betas`。

## 考古结论：**源码读出来的"纯透传"是错的**

help 原文一句：

```
--betas <betas...>    Beta headers to include in API requests (API key users only)
```

先看二进制的选项注册，结论似乎是"裸 variadic、无 argParser、纯字符串透传"——
因为对比之下 `--effort` 明确带 `argParser`（`C1s(s)` 返回 `{level, warning}` 并
往 stderr 写 `Warning:`），而 `--betas` 什么都没有。

**这个读法被实机探针推翻了。** 直接打官方二进制：

```
$ claude -p "hi" --betas made-up-beta-xyz --output-format json
Warning: Beta header 'made-up-beta-xyz' is not allowed. Only the following betas
are supported: context-1m-2025-08-07
```

```
$ claude -p "hi" --betas long_context context-1m-2025-08-07 --output-format json
Warning: Beta header 'long_context' is not allowed. Only the following betas
are supported: context-1m-2025-08-07
Error: When using --print, --output-format=stream-json requires --verbose
```

于是回二进制取确切实现（`m9s` / `pJd` / `f9s`）：

```js
f9s = new Set([WX])                       // WX = long_context = context-1m-2025-08-07
M_s = new Map(PDd.map(e => [e.header, e])) // 注意：按 header 建键，不是按 name
Xxr(e)  { return M_s.get(e) }
YGn(e)  { return M_s.get(e) ?? {name:e, header:e} }   // 未注册 → 原样透传
pJd(e)  { for n of e: Xxr(n) && f9s.has(Xxr(n)) ? keep : reject }
m9s(e)  { if (Eo()) { warn("…API key users…") 一次; return }
          for n of rejected: warn(`Beta header '${n}' is not allowed. …`)
          return allowed.length ? allowed : undefined }
```

### 确认下来的六条语义

1. **允许清单是硬编码的单条**：`f9s = new Set([WX])`，只有
   `context-1m-2025-08-07`。两次实机探针（换模型、换 flag 组合）打印的
   支持列表都恰好是这一条。
2. **按 header 匹配，不按短名**。`M_s` 以 `e.header` 为键，所以
   `--betas long_context` **被拒**——尽管这个名字在注册表里就指向那个被允许的
   header。探针专门验了这条，是最容易想当然写错的地方。
3. **逐条告警**，按请求顺序，每个被拒的值一条，措辞逐字照抄。
4. **拒绝 = 丢弃，不是失败**。会话照常启动、照常发请求。
5. **API key 门**（`Eo()`，即"当前不是 API key 用户"）触发时**只告警一次**，
   而不是逐条，然后全部丢弃。
6. 28 条的 `PDd` 注册表（effort / tool_search / files_api / …）是官方**自己**
   按模型和能力自动派生的，**不给用户选**。可用户选的只有那一条。

> 上一轮（`--file`）立下的规矩是"以官方二进制为事实来源"；本轮补一条更硬的：
> **注册表长什么样不等于运行时怎么用**。`--betas` 的选项注册看起来是透传，
> 实机一句话就否掉了。二进制里的常量/注册表只能用来**定位**，最终行为要靠
> 实跑确认。

## 实现

| 路径 | 改动 |
| --- | --- |
| `src/api-betas.ts`（新） | `SUPPORTED_BETAS` 允许清单、`resolveBetas()` 分区、`betaWarnings()` 两条官方原文告警、`betaHeaderValue()` |
| `src/cli-session-flags.ts` | `parseBetaTokens()`——只摊平 argv（variadic / 可重复 / `--betas=`），裸 `--betas` 直接报错 |
| `src/cli.ts` | `loadConfig()` 之后立刻校验并告警；存活值进 `modelConfig.options.betas` |
| `src/anthropic-adapter.ts` | 构造 SDK client 时按需加 `defaultHeaders["anthropic-beta"]`；没有存活值就**不加**（不发空头） |
| `src/__tests__/api-betas.test.ts`（新） | 13 项（解析 3 / 允许清单 7 / 头值 2 / 名称≠header 1） |
| `src/__tests__/anthropic-gating.test.ts` | +2 项，复用既有 SDK mock 断言 adapter 真的发了 / 真的没发头 |

### 两条设计决策

1. **校验放在 `cli.ts` 而不是 adapter。** 官方是在启动时、第一次请求之前逐条
   告警的，用户当场能看见并改。放进 adapter 会把告警推迟到第一次调用，而且
   每次 provider 切换都可能重复一遍。
2. **存活值才允许进 `options.betas`。** 被拒的值根本到不了 adapter，所以
   这个通道没法被拿来往线上塞任意 beta——这也是官方允许清单存在的意义。

### 官方有、本项目没有的一条路径

`Eo()` 那道 API-key 门在本项目**永远不会触发**：本项目没有 OAuth /
订阅登录态，每个 provider 都是配 API key。分支仍然实现并测试了
（`resolveBetas(tokens, { notApiKeyUser: true })`），这样将来若接了 OAuth，
行为已经在那儿，而不是要临时去猜官方文案。

## 明确记录的偏差

1. **beta 的承载方式不同。** 官方在 Messages 请求上把它放进**请求体字段**
   `anthropic_beta`（数组），Files 资源才用 `anthropic-beta` **头**。本项目
   走 Anthropic SDK，后者把 beta 建模为 header param
   （`Header param: Optional header to specify the beta version(s)…`），
   `messages` 的 body 类型里没有 `betas` 字段——所以这里用**头**。
   两者在服务端是同一个 beta 通道，但**不是同一条 HTTP 线路**，不假装一致。
2. **本项目的允许清单不会随模型/能力变化。** 官方那份 `f9s` 本来也是硬编码
   单条，所以这里 1:1 对齐；但要说清：本项目**没有**官方那套按模型自动派生
   beta 的机制（`Iro` / `XGn` 等），因此不存在"自动补一个 beta"的可能。
3. **不发 `init` 帧的 `betas` 字段。** 官方 `init` 帧里的 `betas` 来自
   `Ob()` → `Ft.sdkBetas`，那是 **Agent SDK 宿主注入**的路径，与 `--betas`
   不是同一条线；本项目没有 SDK 宿主，本轮不动 `init` 帧。

## 明确未实现（不应暗示已具备）

- 官方那 28 条按模型/能力**自动派生**的内部 beta（`PDd` 全表）。
- 非 Anthropic provider 的 beta 透传（本项目只在 Anthropic 适配器上加头；
  OpenAI 兼容线路没有这个概念）。
- `CLAUDE_CODE_EXTRA_BODY` 的 `anthropic_beta` 合并逻辑。

## 验证

- `npm run typecheck`：通过
- `npm test`：**190 文件 / 2,427 用例全通过**（+1 文件 +15 用例）
- `npx biome check src`：**零 error**，727 warnings（与上轮同数，基线未增长）
- `npm run build`：transpiled 274 files ✓ ／ `npm run smoke`：PASSED
- `node --import tsx scripts/doc-sync.mjs --check --with-tests`：全 ✓ ——
  version 1.6.1、srcFiles **274**、testFiles **190**、commands 49、tools 49

**实机核对（本项目，真实 provider，OpenRouter）**

```
$ node dist/cli.js --betas long_context made-up-a context-1m-2025-08-07 \
    -p "Reply with exactly: OK" --output-format json

Warning: Beta header 'long_context' is not allowed. Only the following betas are supported: context-1m-2025-08-07
Warning: Beta header 'made-up-a' is not allowed. Only the following betas are supported: context-1m-2025-08-07
{"type":"result","subtype":"success","is_error":false,"result":"OK",...}
```

**告警文案与官方逐字一致**（含引号、句号、支持列表），被允许的那条没有告警、
照常发出，且真实第三方网关接受了这个 `anthropic-beta` 头、请求成功返回。

```
$ node -e "spawnSync(node, ['dist/cli.js','--betas'])"
Fatal error: --betas requires at least one beta header value
exit 1
```

裸 `--betas` fail-closed。

**官方侧实机对照**：三次 `claude -p` 探针（每次约 $0.12），结论见上文"确认下来
的六条语义"。**未实机验证**：官方 `init` 帧在**带合法 beta** 时是否多出
`betas` 字段——第三次探针在发请求前就被 `--verbose` 校验挡掉了，没花掉那次
调用的钱；该行为据源码判断与 `--betas` 无关（见偏差 3），未做实机确认。
