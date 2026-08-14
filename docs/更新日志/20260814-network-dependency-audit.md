# 更新日志 — 网络依赖审计 + web 工具代理/端点配置

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：fix（含一次网络依赖审计）
> 模块：web_search / web_fetch（网络工具）
> 主题：审计出全工具集里仅 web_search / web_fetch 依赖外网；补可配置搜索端点 + 可操作的网络错误提示
> 状态：已落地
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/web-search.test.ts` 5/5 全过
> 关联 commit：待提交
> 关联文档：[项目评审报告](../项目评审报告.md)（Web SSRF 历史见 `20260708-three-week-security-architecture-fixes`）

---

## 一、现象 / 用户反馈

用户在断网/受限网络环境（LLM 走 `api.deepseek.com` 可达）中调用工具，两个网络工具报错：

```
● Web_search(...)  ⎿ Error: Search failed: fetch failed
● Web_fetch(...)   ⎿ Error: Fetch failed: fetch failed
```

而 read/edit/grep/glob/bash/repl/lsp/workflow/task 等其余工具全部正常。

---

## 二、根因

| # | 缺陷 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | 用 Node 全局 `fetch`，默认不读 `HTTP(S)_PROXY` | `web-search.ts:103`、`web-fetch.ts:102` | 有代理也无法走代理 |
| 2 | 目标端点不可达（DuckDuckGo、docs.anthropic.com 被墙） | `web-search.ts:15`（`html.duckduckgo.com`） | `fetch failed` |
| 3 | 错误文案是 undici 裸信息 `fetch failed` | 两处 `catch` | 用户无从排查 |

**机制：** Node 的全局 `fetch`（undici）不像 `curl` 会自动读 `HTTPS_PROXY`/`HTTP_PROXY`；需显式 `NODE_USE_ENV_PROXY=1` 才走 env 代理。而 LLM 用的是 `@anthropic-ai/sdk`/`openai` 自带客户端，走的是可达的 `api.deepseek.com`，故模型正常、仅 web 工具断。

---

## 三、改动明细

### `src/tools/extended/web-search.ts`

- 搜索端点可配置：`WEB_SEARCH_ENDPOINT` 环境变量覆盖默认的 `https://html.duckduckgo.com/html/`（解析器为 DDG HTML 专用，故只能指向 DDG 兼容镜像/代理）。
- `catch` 分支把 `Search failed: fetch failed` 换成可操作提示：检查网络 / 设 `HTTPS_PROXY`（+ `NODE_USE_ENV_PROXY=1`）/ 覆盖 `WEB_SEARCH_ENDPOINT`。

### `src/tools/extended/web-fetch.ts`

- `catch` 分支把 `Fetch failed: fetch failed` 换成可操作提示（网络 / 代理）。

要点：错误信息同时会进模型上下文（经 `formatResult` → `Error: ...`），故**不加 ANSI 颜色**，纯文本提示。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过，0 错误 |
| `npx vitest run src/__tests__/web-search.test.ts` | 5 / 5 全过（解析逻辑未变，无回归） |
| 手动复测 | 无法在本机复现「代理可用」路径；断网路径已从裸 `fetch failed` 变为带提示文案 |

---

## 五、受影响文件

**修改**
- `src/tools/extended/web-search.ts`（端点可配置 + 错误提示）
- `src/tools/extended/web-fetch.ts`（错误提示）

**未改（仅审计结论，供后续决策）**
- `.mcp.json` 两个 server 均 `disabled`：`github`（http，需外网）、`filesystem`（stdio，但 `npx -y` 首次需联网下包）——若启用，前者断网即废，后者首次调用会失败。

---

## 六、设计决策记录

1. **不自动设 `NODE_USE_ENV_PROXY=1`** —— 该开关是全局的，会连带影响 LLM SDK 的 `fetch` 也走代理；若用户的代理只用于墙外站点而 DeepSeek 需直连，会自动把 LLM 也绕进代理。故只写进错误提示，让用户按需在环境里显式开启。
2. **`WEB_SEARCH_ENDPOINT` 只支持 DDG 兼容端点** —— 解析器 `parseSearchResults` 依赖 DDG 的 `result__a`/`result__snippet` class，指向其它引擎（Bing/百度）会解析不到结果；故定位为「镜像/代理」逃生口，而非「换引擎」。
3. **不默认换搜索引擎** —— 换默认引擎涉及产品决策（可达性 vs 结果质量 vs 隐私），暂不动，仅留可配入口。

---

## 七、二次修复（同日，可选）

〈无〉
