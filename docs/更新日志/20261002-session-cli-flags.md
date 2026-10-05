# 会话级 CLI 开关对齐官方（v1.6.1 增量）

日期：2026-10-02。基线：本机官方 CLI 2.1.202 的 `claude --help`。本轮只补齐**会话级开关**这一类核心能力，不触碰外部服务、用户凭据或原生沙箱的既有取舍。

## 背景：为什么是这批开关

对照本机官方 `--help` 逐项核对后，发现项目已经实现了 49 个工具、49 条内建命令、hooks 事件全集、MCP、skills、插件与子代理，但**会话级开关几乎全部缺失**：官方有、本项目没有或未接线的包括 `--tools`、`--effort`、`-n/--name`、`--debug`、`--debug-file`、`--fallback-model`、`--disable-slash-commands`。用户把一条官方命令行原样搬过来时，这些开关会被**静默忽略**——不会报错，也不会生效，这是最难排查的一类差距。

本轮定位：把这一类补齐，并保持"声明即可验证"的口径。

## 新增能力

| 开关 | 语义 | 与官方一致处 | 明确偏差 |
|---|---|---|---|
| `--tools <list>` | 限定本次会话可用的内建工具 | 逗号／空格分隔、`""` 全禁、`default` 全开、可重复 | — |
| `--effort <level>` | 会话推理档位 | 取值集合与 `/effort` 一致 | — |
| `-n, --name <name>` | 会话显示名 | 短长选项都支持 | 本项目额外把它写进 `/sessions` 列表并纳入搜索 |
| `--debug [filter]` | 运行时调试日志 | 可选类别过滤、默认全开 | 类别名沿用本项目 debugLogger 的 `info,text,tools,commit` |
| `--debug-file <path>` | 日志落盘（隐含 `--debug`） | 语义一致 | 额外支持按需创建父目录并在打开时截断旧文件 |
| `--fallback-model <list>` | 逗号分隔的降级链 | 同 provider 顺序回退 | 官方限 `--print`；本项目的降级链已在 agent loop 实现且 provider 无关，故对所有入口开放 |
| `--disable-slash-commands` | 禁用全部 skills | 磁盘与插件 skills 一并跳过 | 内建斜杠命令与 MCP 提供的 prompt 不是 skill，仍可用 |

`--help` 同步补齐，并按上表逐条写明偏差，不做无声扩权。

## 实现要点

新增 `src/cli-session-flags.ts`（kernel 层纯函数，无 I/O、不读 `process.env`），承载全部解析规则：

- **工具名比对复用 `canonicalToolKey`**——与执行路径、权限规则同一套命名映射，因此 `--tools Read`、`--tools read`、`--tools READ` 指向同一个工具，`--tools WebFetch` 也能命中内部的 `web_fetch`。
- **`--tools` 采取"注销"而非"调用时过滤"**：`setupTools` 在注册完全部来源（含 MCP、skills、插件、breadth 工具）之后才应用选择，因此注册表、稳定执行数组、子代理工具集与系统提示的 AVAILABLE TOOLS 天然一致——沿用 MCP 刷新路径已有的同一条不变量。
- **MCP 工具集变化后重新应用** `--tools`，否则服务器重连会把用户刚移除的工具"复活"。这条不回退的回归已写入测试。
- **矛盾输入取更严格的一侧**：`--tools Read --tools ""`、`--tools default --tools ""` 解析为"全禁"。放宽是更糟的错误方向。
- **空值请求不吞掉分隔符**：`--tools Read,` 里的尾部逗号只是分隔符，不等于 `--tools ""`。
- **缺值快速失败**：`--tools` 不带值直接报错，而不是退化成"全部工具"——用户要求收窄却拿到全集，看起来和成功无异。
- **`--fallback-model` 只取一个值 token**，不吞掉后面的位置参数（官方文档为逗号分隔列表），避免静默吃掉用户 prompt。
- **`--name` 用挂起写入**：会话文件可能还不存在，且保存调用点很多（TUI onSave、headless、agent loop 自动保存）；`SessionMemory.setSessionName()` 只记录，由下一次保存落盘，且不会被之后的保存清空。
- **调试日志落盘失败不拖垮会话**：不可写路径降级回 stderr 并提示一次；运行中磁盘满或文件被删同样降级，不在日志调用里抛异常。

## 回归与验证

新增 [cli-session-flags.test.ts](../../src/__tests__/cli-session-flags.test.ts)，25 项，覆盖：

- 六个开关的解析契约（含大小写、重复、矛盾组合、缺值报错、紧邻下一个开关即停止）；
- `setupTools` 端到端：注册表、`tools` 数组、子代理工具集三者同步收窄，`--tools ""` 三者同时为空，未知名给出告警而非静默忽略；
- debug 日志落盘（写文件而非 stderr、打开即截断、不留上一轮残留）；
- 会话显示名的写入、保留、搜索命中与"空名不算名"。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：186 个文件、2,326 项测试全部通过。
- `npm run lint`：无错误；本文件新增的告警与项目既有风格一致（非空断言），未通过关闭规则隐藏问题。
- `npm run docs:sync -- --check`：通过（`docs/项目总览.md` 指标已同步为 55,464 行 / 269 源文件 / 186 测试文件 / 2,348 用例）。
- 未调用真实模型或支付 API。

实际平台为本机 Windows；本地检查不能代替远端 Linux／Windows CI。

## 本轮未覆盖（留待下一轮）

同一份官方 `--help` 里还有这些会话/自动化开关本轮**没有**实现，不应在文档或回复中暗示已具备：

- `-w, --worktree [name]`、`--agent`、`--agents <json>`、`--include-hook-events`、`--prompt-suggestions`、`--tools` 之外的 `-v/--verbose` 之外的 `--from-pr`、`--betas`、`--brief`、`--file`、`--tmux`。
- `--bg` / `claude agents` 跨进程后台会话管理入口。
- `--ax-screen-reader` 屏幕阅读器输出模式。

其中 `--worktree` 与 `--agent` 属于核心会话语义，建议优先；`--include-hook-events` 影响 stream-json 消费方契约，次之。
