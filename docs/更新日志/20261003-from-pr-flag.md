# `--from-pr [value]` — 按 PR 恢复会话（2026-10-03）

对标本机官方 CLI **2.1.202**。本轮实现官方 `--from-pr`。

## 考古结论

help 原文一句：

```
--from-pr [value]    Resume a session linked to a PR by PR number/URL, or open
                     interactive picker with optional search term
```

选项注册（offset 162039064）：

```js
.option("--from-pr [value]", "Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term", (s) => s || !0)
```

**注意 `[value]` 而非常规的 `<value>`** —— 值是可选的，`argParser` 是
`(s) => s || !0`，也就是**裸 `--from-pr` 合法**（= 打开交互式选择器），
空值同样映射到 `true`。这和 `--tools <tools...>`（裸 flag 报错）是两种形状。

再往下挖到三处关键证据：

1. **argv 分类**（offset 228903856）——`--from-pr` 和 `-r` / `--resume` 归进
   **同一个 `"resume"` 桶**：

   ```js
   E1i(argv) { let r = argv.slice(0, indexOf("--"));
     if (r.includes("-r") || r.includes("--resume") || r.includes("--from-pr")
        || r.some(n => n.startsWith("--resume=") || n.startsWith("--from-pr="))) return "resume";
     if (r.includes("-c") || r.includes("--continue")) return "continue";
     return "fresh" }
   ```

2. **互斥检查**（offset 244894949）——`--resume` 和 `--from-pr` 被**显式配对**，
   官方自己会拒绝同时给：

   ```js
   if (e.resume || e.fromPr) { let n = e.resume ? "--resume" : "--from-pr";
     return `Error: ${t} cannot be combined with ${n}.` }
   ```

3. **会话元数据**（offset 235373670 / 245459448 / 245484563）——官方在会话
   索引里按 sessionId 存了三个 map，并在列表条目上摊平：

   ```js
   prNumber: e.prNumbers.get(n) ?? t.prNumber,
   prUrl:    e.prUrls.get(n)    ?? t.prUrl,
   prRepository: e.prRepositories.get(n) ?? t.prRepository,
   ```

   也就是说 **`--from-pr` 是按 `prNumber` 查会话**，和 `--resume` 是同一类
   操作："选哪个存档会话"，而不是"开一个新会话做 PR"。

4. **PR 事实来自 `gh` CLI**（offset 233344059 的 Bash 只读白名单里
   `gh pr view` / `gh pr list` / `gh pr diff` 都在），失败文案是具名的
   （offset 132834070）：

   ```
   gh CLI is required but not found.     (gh_not_found)
   gh pr view failed:                    (gh_failed)
   couldn't find PR #<n> in <repo>       (no open PR found for branch "<b>". Create a PR first, then retry.)
   unexpected PR URL format: <s>         (bad_pr_url，配套正则 /([^/]+)\/([^/]+)\/pull\//)
   ```

## 实机探针：**官方这个 flag 在普通 CLI 里几乎是空操作**

两次 `claude -p`（各约 $0.12）：

```
$ claude --from-pr 12345 -p "hi" --output-format json --max-turns 1
→ 正常返回 {"type":"result","subtype":"success",...}，没有任何 PR 相关输出

$ claude --from-pr -p "hi" --output-format json --max-turns 1
→ 同样正常返回，裸 flag 在非 TTY 下也没有报错
```

两次都是**静默开一个全新会话**。原因很清楚：官方那三个 PR 字段来自它
**自己 GitHub 集成**打的标，普通本地 CLI 的会话没有这个 linkage，所以查不到
→ 落空 → 走 fresh 分支。裸 `--from-pr` 的选择器只在 TTY 交互模式下才出现。

> 承上一轮的规矩：注册表只能用来定位，运行时行为要实跑确认。这次实跑直接
> 推翻了"照抄选项声明就等于实现了功能"的天真读法——`--from-pr` 的**声明**
> 承诺了选择器，实机在非交互下什么都不做。

## 实现

| 路径 | 改动 |
| --- | --- |
| `src/from-pr.ts`（新） | `parsePullRequestRef()`（PR 号/URL 文法）、`resolvePullRequest()`（`gh pr view` 往返 + 具名错误）、`matchSessionForPullRequest()`（纯匹配）、`lookupPullRequestSession()`、`describePullRequest()` |
| `src/cli-session-flags.ts` | `parseFromPrFlag()`——只摊平 argv：裸 flag / 空值 → `picker`，否则 → `{raw}` |
| `src/cli.ts` | 互斥校验、选择器未实现提示、`gh` 往返、把查到的会话 id 交给 `initSession` |
| `src/cli-session.ts` | `initSession()` 新增 `pullRequestSessionId` / `pullRequest` 两个可选入参 |
| `src/session-memory.ts` | `SessionData` / `SessionMeta` 加 `prNumber` / `prUrl` / `prRepository`（字段名与官方逐字一致）；`setSessionPullRequest()` + `pendingPullRequests` 延迟写入；`listSessions` / `getCatalogEntry` / `searchSessions` 摊平 |
| `src/cli-env.ts` | `--help` 条目 |
| `src/__tests__/from-pr.test.ts`（新） | 39 项（flag 9 / 文法 11 / gh 往返 7 / 匹配 6 / 组合 3 / 文案 2） |
| `src/__tests__/from-pr-linkage.test.ts`（新） | 11 项，真实文件落盘的 linkage 往返 + 走真实 `initSession` 的 link→resume 端到端 |

### 三条设计决策

1. **解析在 `initSession` 之前完成。** 会话 id 一旦定下来，checkpoint 绑定
   （`bindCheckpointSession`）和 runtime 恢复（`restoreSessionRuntime`）都跟着它
   走。先建会话再换 id，等于要在两处补一次重绑定。
2. **linkage 由用户显式建立，不从当前分支自动推断。** 官方靠它自己的 GitHub
   集成打标，本项目没有对应物；而在每次会话启动时多打一次 `gh` 调用去猜
   "当前分支有没有 PR"，是把一个网络往返塞进所有人的启动路径。改成：
   **第一次 `--from-pr 42` 把新会话链到 PR #42，之后同样的 `--from-pr 42`
   就会真的恢复它。** 语义是通的，代价为零。
3. **匹配以 number 为键，repository 必须一致才算数。** 官方也以 number 为键，
   但同时存了 url / repository；没有 repository 约束，A 仓库的 PR #7 会恢复
   出 B 仓库 PR #7 的会话。仓库名按 GitHub 的规则**大小写不敏感**比较。
   只有一方知道 repository 时，**不匹配**——无法证明是同一个 PR，就不能认。

### URL 文法：像 URL 就必须按 URL 校验

`--from-pr https://github.com/o/r/pulls/7` 如果直接掉进"是不是整数"的分支，
报错会变成 `expects a PR number or PR URL, got "…"`——把真正的问题（拼错成
`pulls`）掩盖掉了。所以先看形状：有 `://` 或 `a/b/` 前缀就**必须**满足
`<host>/<owner>/<repo>/pull/<n>`，否则按官方的 `bad_pr_url` 报
`unexpected PR URL format: <原值>`。允许 GitHub Enterprise 主机名。

## 明确记录的偏差

1. **未链接时不静默开新会话。** 官方两次实机都是无声无息开新会话（见上）。
   本项目改为打印
   `No session linked to owner/repo PR #42 yet — starting a new one and linking it to that PR.`
   ——用户点名了一个 PR，悄悄开个不相干的会话是最坏的失败方向。
2. **`gh` 不可用是硬错误。** 沿用官方措辞 `gh CLI is required but not found.`
   并 exit 1。**不**降级成"开新会话"：那会让 flag 看起来生效了。
3. **裸 `--from-pr`（选择器）直接报错退出**，而不是像官方那样在非 TTY 下
   悄悄开新会话。文案点名未实现并给出替代写法。
4. **与 `--worktree` 组合的规则未加。** 官方只把 `--from-pr` 和 `--resume`
   配对互斥，本项目对齐这一条；`--worktree` 与它的交互留待后续（官方那段
   互斥函数本身还牵扯 connect/SSH/assistant/teleport 一整组，不在一条消息
   字符串的证据范围内，不猜）。

## 明确未实现（不应暗示已具备）

- 官方裸 `--from-pr` 的**交互式 PR 选择器**（需要 TTY 列表 UI + 搜索）。
- **按当前分支自动建立 PR linkage**（官方来自它的 GitHub 集成）。
- `gh pr list` / `gh pr view --comments` 的 richer 字段（title / state / draft /
  reviewDecision / statusCheckRollup / additions / deletions）——官方选择器和
  `/autofix` 会用，本轮只需要 number / url / repository。
- `/autofix` 相关的 `MERGED` / `CLOSED` / `DRAFT` 状态机（那是另一个功能，
  不在 `--from-pr` 面上）。

## 验证

- `npm run typecheck`：通过
- `npm test`：**192 文件 / 2,477 用例全通过**（+2 文件 +50 用例）
- `npx biome check src`：**零 error**，**727 warnings**（与上轮同数，基线未增长 —— 新增的两
  个测试文件本身零 warning，实现文件零 warning）
- `npm run build`：transpiled 275 files ✓ ／ `npm run smoke`：PASSED
- `node --import tsx scripts/doc-sync.mjs --check --with-tests`：全 ✓ ——
  version 1.6.1、srcLines **57,317**、srcFiles **275**、testFiles **192**、
  commands 49、tools 49、tests **2,477**

### 端到端（走真实 `initSession` 的 link→resume）

`src/__tests__/from-pr-linkage.test.ts` 里最后两项不是手工拼 save，而是：

1. 第一次：`initSession({ pullRequest: 42 })` → 生成新会话并挂上 linkage，
   真实 `save()` 落盘；
2. 第二次：`listSessions()` → `lookupPullRequestSession()`（注入 `GhRunner`
   桩）→ 拿到 sessionId → `initSession({ pullRequestSessionId })` →
   断言 **session id 与第一次相同**、transcript 已载入共享 `messages` 数组。

第三项断言跨仓库不复用：`owner/repo` 的 PR #42 不会被 `other/repo` 的 PR #42 恢复出来。

### 实机核对（本项目，`dist/cli.js` 真实进程）

本机**没有装 `gh`**，正好是最重要的一条路径。六条全部在发模型请求**之前**退出，
没有产生任何 API 调用：

```
$ node dist/cli.js --from-pr -p hi --output-format json
Error: --from-pr without a value opens the official interactive PR picker, which is not implemented. Pass a PR number or URL instead, e.g. --from-pr 42.            exit 1

$ node dist/cli.js --from-pr 42 --continue -p hi …
--from-pr cannot be combined with --resume or --continue.                                                                              exit 1

$ node dist/cli.js --from-pr 42 --resume -p hi …
--from-pr cannot be combined with --resume or --continue.                                                                              exit 1

$ node dist/cli.js --from-pr https://github.com/o/r/pulls/7 -p hi …
Error: unexpected PR URL format: https://github.com/o/r/pulls/7                                                                           exit 1

$ node dist/cli.js --from-pr main -p hi …
Error: --from-pr expects a PR number or PR URL, got "main"                                                                              exit 1

$ node dist/cli.js --from-pr 42 -p hi --output-format json
Error: gh CLI is required but not found.                                                                                                 exit 1
```

`gh` 缺失这条用的是**官方原话** `gh CLI is required but not found.`，且是硬错误
——没有降级成"开新会话"，那会让 flag 看起来生效了。

**未实机验证**：真实 `gh` 成功往返（本机无 `gh`、本仓库也非 git 仓库，无法实跑）。
成功路径由注入 `GhRunner` 的单元/集成测试覆盖，命令形状
`gh pr view <n|url> --json number,url,headRepository` 与官方 Bash 只读白名单里
`gh pr view` 的用法一致，但**没有对着真的 `gh` 验过 JSON 字段名**。

