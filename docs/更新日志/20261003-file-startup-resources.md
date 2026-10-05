# `--file <specs...>` — 启动文件资源（2026-10-03）

对标本机官方 CLI **2.1.202**。本轮实现官方 `--file`，即"会话启动时把设备端
上传的文件按 id 拉到工作区"。

## 官方语义（先考古，再实现）

help 原文只有一句：

```
--file <specs...>    File resources to download at startup.
                     Format: file_id:relative_path
                     (e.g., --file file_abc:doc.txt file_def:img.png)
```

`variadic` + 可重复，足以推出"位置参数"和"可多次出现"，但推不出**落地
目录**、**重试预算**、**API 不通时怎么办**——而这三项正是最容易照着直觉
写错的部分。本轮照 `--brief` 那轮的办法，用 Node REPL 对 native binary 做
latin1 字节搜索，拿到了实现（`--file` 的解析器 / 下载器 / 聚合函数）。

| 环节 | 官方行为（来自二进制，非 help 文本） |
| --- | --- |
| 规格解析 | `flatMap(n => n.split(" "))`（引号里可塞多条）→ 按**第一个** `:` 切分 |
| 落地路径 | `<cwd>/<sessionId>/uploads/<relativePath>` |
| 前缀折叠 | 只有当 spec **本身就写全了** `<cwd>/<sessionId>/uploads/` 才会被折叠回去；裸 `uploads/x` 不会被剥掉（Windows / POSIX 均如此） |
| 目录逃逸 | 对 **normalize 之后**的路径判前缀 `..`，命中即拒（所以 `a/../../b` 同样被拒） |
| 端点 | `GET ${baseUrl}/v1/files/${fileId}/content`，`Authorization: Bearer …` |
| 头部 | `anthropic-version: 2023-06-01` + `anthropic-beta: files-api-2025-04-14` |
| 超时 | 60s |
| 状态映射 | 401 → `Authentication failed: invalid or missing API key`；403 → `Access denied to file: <id>`；404 → `File not found: <id>` |
| 重试 | **3 次**，`500ms · 2^(n-1)` 退避；除上述三个具名状态外**一律重试**（含 5xx） |
| 并发 | 有界池宽度 **5**，保持入参顺序 |
| 失败语义 | **从不抛出**：逐文件返回 `{success:false, error}`，会话照常启动；官方侧只额外发一条 `api_files_download` 遥测（`partial_failed` / `all_failed`） |

### 一处照着直觉写就必错的地方

第一版把"可重试"写成 `status < 500`，被 503 的测试当场抓出来。官方用 axios 的
`validateStatus: s => s < 500`：**≥500 是抛进 catch 的**，catch 同样返回可重试
结果；而没被具名处理的 4xx 落到同一个 "not done" 分支。两边都重试。
只有 401/403/404 是终态。已按此修正并锁进测试。

## 实现

| 路径 | 改动 |
| --- | --- |
| `src/startup-files.ts`（新） | 规格语法、`uploadPathFor` 路径解析、`filesApiRoot` base URL 归一、单文件下载（含重试与状态映射）、批量有界池、报告行 |
| `src/cli-session-flags.ts` | `parseFileSpecTokens()`——只把 argv 摊平成 token 列表，不碰 `file_id:path` 语法（两层分离） |
| `src/cli.ts` | `initSession` 之后、系统提示构建之前下载；结果同时进控制台和系统提示 |
| `src/system-prompt.ts` | `buildStartupFilesSection()` → `[STARTUP FILES]` 块，进 dynamic 段（末位但一，让最易变的 MCP 指引仍居最末） |
| `src/cli-env.ts` | `--help` 增补，含全部偏差说明 |
| `src/__tests__/startup-files.test.ts`（新） | 24 项（解析 6 / 路径 5 / 下载 8 / 批量 3 / 提示段 3） |

### 三条设计决策

1. **失败也必须进系统提示。** 控制台报一行不够：用户随后问"我刚发的那份
   PDF 呢"，模型若不知道下载失败就会凭空作答。`[STARTUP FILES]` 里失败项
   显式列出并写明"不要当它们存在"。
2. **落地在 `<cwd>/<sessionId>/uploads/`。** 与官方逐字一致（`sessionId`
   这一层官方有，本项目会话 ID 形态相同），所以官方会话报告出的绝对路径
   可以原样粘回来而不会多出一层 `uploads/uploads/`。
3. **base URL 做 `/v1` 归一。** 官方 `baseUrl` 是**不带** `/v1` 的 API 根，
   而本项目 OpenAI 兼容 provider 的 base URL 是**带** `/v1` 的
   （`https://host/v1`）。直接拼接会请求 `/v1/v1/files/...`。
   `filesApiRoot()` 剥掉尾部的 `/v1` 再生成本地路径，有专门测试。

## 明确记录的偏差

1. **畸形 spec 一律告警，不静默丢弃。** 官方对无 `:` 的 spec 是
   `continue`（一个字都不说），对半空的只 log 一行。本项目对**两种**形状都
   告警并点名——一条没下载的 spec 绝不能看起来像下载成功了。
   另有：裸 `--file`（后面不跟值）直接报错，而不是当作"没要求任何文件"。
2. **凭据来源不同。** 官方用 Claude.ai OAuth token 打自家网关；本项目没有
   OAuth 流程，改用会话已配置的 provider key / base URL。第三方网关多半
   **没有** Files API——那种情况表现为逐文件报错（如
   `File not found: …` 或 `status 404`），而不是启动失败。已在 `--help`
   里写明。
3. **不发官方那条 `api_files_download` 遥测。** 本项目无对应遥测通道。

## 明确未实现（不应暗示已具备）

- **文件上传的另一半。** 官方同一模块还有上传（500MB 上限、
  `POST /v1/files`），本轮只做下载方向。
- **设备端上传通道。** `--file` 的 `file_id` 来自用户从手机/桌面端上传的
  文件；本项目没有产生这种 id 的入口，只能消费外部给定值。
  （这也是上一轮 `SendUserMessage` 的 `attachments` 对象形状被拒的原因。）
- `api_files_download` 遥测事件的 success / partial / all 三态。

## 验证

- `npm run typecheck`：通过
- `npm test`：**189 文件 / 2,412 用例全通过**（+1 文件 +24 用例）
- `npx biome check src`：**零 error**，727 warnings（与上轮同数；本轮新增的
  2 条 warning 已消除，warning 基线未增长）
- `npm run build`：transpiled 273 files ✓ ／ `npm run smoke`：PASSED
- `node --import tsx scripts/doc-sync.mjs --check --with-tests`：全 ✓ ——
  version 1.6.1、srcLines **56,677**、srcFiles **273**、testFiles **189**、
  commands 49、tools 49、tests **2,412**

**实机核对**（真实 provider，`--output-format json`）

```
node dist/cli.js --file file_000000000000:a.txt "noColon" ../escape.txt \
  -p "Reply with exactly: OK" --output-format json
```

```
Warning: Invalid file spec: noColon — expected file_id:relative_path. Both are required.
Warning: Invalid file spec: ../escape.txt — expected file_id:relative_path. Both are required.
Failed to download file_000000000000: File not found: file_000000000000
{"type":"result","subtype":"success","is_error":false,"result":"OK",...}
```

已实机确认：两种畸形 spec 都点名告警；真实 HTTP 请求打到了
`https://openrouter.ai/api/v1/files/file_000000000000/content`（base URL 无尾部
`/v1`，`filesApiRoot` 原样透传），404 被映射成具名错误；**下载全部失败时
会话照常启动并完成**（官方语义）。

**未实机验证**：所配网关（OpenRouter）不提供 Files API，因此**没有跑通
一次 200 成功下载**。落盘、头部内容、重试与退避、成功后的 `[STARTUP
FILES]` 提示注入，均由 `fetchBytes` 测试替身逐项覆盖，但真实成功路径未经
实机确认。这一点不隐瞒。
