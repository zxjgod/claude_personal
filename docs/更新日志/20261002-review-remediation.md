# v1.6.1 审查问题修复

日期：2026-10-02。依据：[问题清单核验](../问题清单核验-20261002.md)。本轮修改当前工作区，不修改外部服务、真实用户凭据或原生沙箱的既有取舍。

## 权限与安全

- WebFetch 域名与绝对 URL 规则使用 URL 解析：处理 userinfo、大小写、默认端口和 DNS 尾点；带明确端口的规则继续限制端口，不把路径误当裸域名放宽。官方 `WebFetch` 等内建名称映射到实际 `web_fetch` 等工具名，执行和工具可见性使用相同命名规则；MCP 自定义名字不去除下划线。
- 项目 `.claude/lsp.json` 需要针对路径与配置内容的指纹信任。交互启动可确认；非交互启动跳过未信任定义，配置改变须重新确认。用户目录与主动安装插件仍遵循既有信任边界。普通文件工具不能改写新的信任存储。
- MCP URL 只接受无凭据的 HTTP(S)，先确认打开，再启动浏览器，最后确认认证完成。Windows 使用固定 PowerShell 命令读取环境中的 URL；URL 不进入 shell 命令文本。
- 跨项目 user memory 写入需要审批通道或显式许可规则；直接 `.call()` 也保留保护。local 与 project 分开存储，scope 输出与实际落点一致。JSONL 去重、索引与 agent memory 的读改写增加跨进程锁；索引采用原子替换。
- Agent 的直接入口拒绝 plan 模式。没有真实计划审批渠道时，ExitPlanMode 留在 plan，明确报告不可批准。
- MCP 批准按会话与完整工具定义指纹记录；工具变更、移除、断开和恢复会话后重新验证。审批 UI 的“始终允许”键包含定义指纹，内部指纹不显示给用户。缺少审批回调时默认拒绝。
- 插件 mcpServers / lspServers 文件路径采用相同的路径逃逸校验。程序化 Hook 的 deny 不被后续 allow 覆盖。

## 会话与可靠性

- headless 依据循环返回的 Terminal 判定结果。可恢复压缩错误不会污染最终成功状态；真实取消、失败与上限仍保持失败。TTY 的 stream-json 给出明确错误，不进入等 EOF 的隐式交互。
- goal 保存 objective、complete、checks、reason 和 suspended。旧字符串快照因没有完成状态而保持暂停，避免自动续跑。评估失败会保留未完成目标并暂停自动续做；取消保持取消分类。headless 的 goal_state 与 `/goal` 显示当前状态。
- `/resume` 刷新 goal holder，保存并释放旧会话目标和调度缓存；原会话可以恢复未过期任务及已排队输入。无归属 cron / wakeup 不被新会话“收养”。清理、删除会话时释放目标。
- Hook 的 session_id 与 transcript_path 在调用时读取最新会话，转录保留原存储根。相对 Hook 命令保持在已信任配置的执行工作区，避免切目录后执行未信任的同名脚本。
- MCP JSON 除语法外还校验结构；非法配置与服务器条目被诊断和隔离，不使整体 CLI 崩溃。
- LSP 初始化失败清理进程与缓存，退出重置 ready 并拒绝 pending；下一次请求重新启动。普通请求超时重置连接；tsserver 项目诊断的 requestCompleted 正确结束跟踪，避免健康服务器被误判超时。stdin 错误和 stderr 流也有生命周期处理。

## 其余已确认问题

- `--resume` 不吞下一项开关；缺值参数和非法／空数值上限明确报错，保留显式 unlimited / 0 的既有语义。
- 工作树已删除但分支清理失败时明确报告保留分支，不能把已不存在的工作树标为 retained。
- 递归扩展发现采用确定顺序，并对同名覆盖显示诊断。
- 必填 elicitation 字段为空或仅空白时，表单保持打开并显示校验反馈。
- additionalDirectories 也做 realpath；盘符根和 POSIX 根的包含判断不重复拼接分隔符。
- 非交互 onboarding 不创建 `.env`；已提供 LLM_API_KEY 时不强制要求 `.env`。

第 1 项“Hook 放行持久写回父 policy”已反证，保持当次作用域并保留回归。合法 YAML block scalar 的分隔线保持支持。

## 回归与验证

新增 [review-regressions.test.ts](../../src/__tests__/review-regressions.test.ts)、[review-state-details.test.ts](../../src/__tests__/review-state-details.test.ts)、[external-url.test.ts](../../src/__tests__/external-url.test.ts)、[memory-concurrency.test.ts](../../src/__tests__/memory-concurrency.test.ts)、[worktree-partial-cleanup.test.ts](../../src/__tests__/worktree-partial-cleanup.test.ts)。已有 LSP、MCP、计划审批和 TUI 测试同步更新。

验证包含实际临时进程／Git 流程、本地 stdio MCP、并发进程写入、审批前无浏览器调用、LSP 重启及 `/resume` 后目标与输入归属。没有调用真实模型或支付 API。

最终检查：

- `npm run typecheck`：通过。
- `npm run test:coverage`：180 个文件、2,223 项测试通过；Statements 71.15%、Branches 62.47%、Functions 74.56%、Lines 72.95%，通过已有门禁，未再次降低阈值。
- `npm run check`：通过，保留非阻断警告；没有通过关闭 lint 规则隐藏问题。
- `npm run smoke`：构建、版本／帮助、无 key 退出、TUI 信息入口、会话路径检查通过。
- `npm audit`：零项漏洞。
- `git diff --check` 与当前文档路径／计数检查：通过。

实际平台为本机 Windows；本地检查不能代替远端 Linux／Windows CI。
