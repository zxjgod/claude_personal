# 项目收紧与发布包白名单

- 日期：2026-10-07
- 类型：refactor / build / docs
- 范围：无调用源码、发布包、开发脚本与文档目录

## 行为变化

删除未接入 CLI、TUI 或 SDK 的 `src/utils/health-check.ts`、`resource-limiter.ts` 及其两份独立测试。实际 `/doctor`、执行器超时与并发控制保持原实现。删除未调用的 `changedFiles`、`terminalRows`、`buildKeystroke`、`keystrokesEqual` 与绕过信任检查的旧 hook 加载包装。移除未导入的 `commander` 依赖和锁记录。

`llm-adapter` 的错误判断函数虽无仓库内调用，但该模块有独立发布入口，因此保留对外兼容接口。测试用重置函数、SDK、LSP 回退与全部模型 provider 保留。

`package.json` 增加发布文件白名单。发布 JavaScript、四个入口、Python SDK、配置示例与用户文档；不发布 source map、源码、测试、开发脚本、历史材料或本地配置。开发构建仍生成 source map。供应商模板改为 `examples/providers.json`。新增根 README 与 `npm run smoke:package`，后者实际打包、解包并验证入口和版本说明，使用现有 external 依赖，不访问模型 API；Linux 和 Windows CI 都执行该检查。

## 归档与本地材料

30 篇根目录阶段报告与参考分析、65 篇早期更新日志、6 篇 9 月架构分册、5 篇旧升级计划及2个实验脚本移至 `docs/archive/`。旧版局限性说明另行归档，当前页面只列现有边界；相关 Markdown 链接与根路径引用同步调整。

本地参考材料、样例工作区与旧覆盖率报告移至仓库外 `../claude_personal-self-local/`。样例工作区内的会话保留，主工作区 `.claude` 运行数据与本地设置不变。

## 验证口径

- `npm run typecheck` 与 `npm run check`：类型与源码风格检查。
- `npm test`：保留产品回归测试；只移除两份孤立实现的35项测试，预期 Windows 共222文件、2940用例。
- `npm run smoke`：构建、CLI信息命令、无key退出与会话路径。
- `npm run smoke:package`：实际归档文件检查、解包后CLI与SDK入口、`/release-notes`；不替代独立环境中的依赖安装验证。
- `npm run docs:sync -- --check`：当前数量、路径与架构验证口径。

整理前发布包为826文件、解压27.64 MiB、压缩6.47 MiB。最终实测为64文件、解压7.40 MiB、压缩1.59 MiB，解压体积减少约73%，均不包含安装的依赖。当前文档主目录从42篇减少至12篇。

最终验证：类型检查通过；源码代码检查通过（仍有既有非阻塞警告）；全量222测试文件、2940用例通过；CLI与发布包冒烟检查通过；文档指标与170份Markdown本地链接检查通过。首次并行验证中CLI子进程测试触及15秒超时，单独复查及随后全量重跑均通过。
