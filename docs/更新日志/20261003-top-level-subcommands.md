# 2026-10-03 顶层子命令判定层（agents / auth / doctor / mcp / plugin / ...）

本轮补齐官方 2.1.202 在 commander 层注册的 **12 个顶层子命令** 的判定层。
此前本项目对它们全部 fail-open：首位置参数既不是 flag、也不是已识别的
fast-path/bg 入口时，会被静默丢弃（管道模式）或当作 prompt 喂给模型（交互模式）。

与 fast-path / `--bg` 轮一致：**只实现判定层**，全部以"点名缺口"的命名拒绝收场，
绝不喂给模型。

## 官方行为（先 `--help` 定位，再实跑验证）

`claude --help` 的 `Commands:` 段列出 12 个子命令。对每个执行 `claude <sub> --help`
（commander 只为**真正注册**的命令打印子命令帮助），逐个确认存在：

- `agents` / `auth` / `auto-mode` / `doctor` / `gateway` / `install` / `mcp` /
  `plugin|plugins` / `project` / `setup-token` / `ultrareview` / `update|upgrade`
- 又探测了一批候选隐藏顶层命令（`login`/`logout`/`config`/`review`/`sandbox`/
  `migrate-installer`/`completion`/`release`/`share`/`export`/`status`/`theme`/
  `memory`/`hooks`/`permissions`/`cost`/`usage`/`security-review` 等）——全部打印
  顶层 `Usage:`，即**未注册**，2.1.202 里 `login`/`logout` 已并入 `auth`。

### 关键甄别：bare `agents` 是个漏网之鱼

bg-startup 只处理 `--bg` flag 和 6 个隐藏 job 子命令（logs/attach/stop/kill/respawn/rm），
**不含 bare `agents`**（舰队视图命令）。实测 `ccr agents` 会一路落到交互会话启动并**挂起**。
这是本轮探出的**既有** fail-open（非本轮改动引入），已一并纳入判定层。

## 本项目实现

新模块 `src/cli-commands.ts`（纯判定），在 `src/cli.ts` 中置于 **bg 判定块之后、
会话构建之前**（匹配官方 commander 在 pre-commander fast-path 之后分发的顺序）：

- 12 个子命令（含别名 `plugin|plugins`、`update|upgrade`，共 14 个拼写）→ 命名拒绝，
  文案点名官方该命令做什么、本项目缺什么后端，并指向本项目的实际机制
  （`auth`→.env API key；`mcp`→.claude/mcp.json；`update`→npm；`plugin`→会话内 /plugin）；
  统一后缀 "It was not sent to the model as a prompt."
- **仅按首位置参数匹配**。官方 commander 也会把 `claude --debug doctor` 路由到 `doctor`，
  但可变参 flag（如 `--add-dir`）会合法吞掉后一个词，不做 commander 级解析就无法区分
  "子命令"与"flag 值"。首词匹配精确（零误伤），覆盖主流的 `claude <sub>` 形式；
  少见的 flag 在前形式落回现有 prompt 处理。已在 --help 与本文档诚实标注。

`src/cli-env.ts` `--help` 增补一行，列出全部 12 个子命令并注明"首词匹配、拒绝不喂模型"。

## 验证

- `src/__tests__/cli-commands.test.ts` 25 例全绿（表覆盖 12 命令/14 拼写、别名、
  拒绝文案点名缺口、仅首词匹配、flag 缺位、近似词不误伤、不遮蔽 fast-path/bg token）。
- 全量：197 文件 / 2,629 测试全过；typecheck 0 错；biome 727 警告基线持平、0 错；
  build、smoke、doc-sync 全过。
- **实测对拍**（`node dist/cli.js`）：`doctor`/`auth`/`update`/`mcp`/`plugin`/
  `ultrareview`/`upgrade`/`agents` 均快速拒绝 exit 1，不再挂起、不喂模型。

## 度量

58,483 行 / 280 src 文件 / 197 测试文件 / 2,629 测试。
