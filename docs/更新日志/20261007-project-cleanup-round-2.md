# 第二轮冗余清理

- 日期：2026-10-07
- 类型：refactor / chore
- 范围：未使用内部接口、开发材料、TypeScript配置

## 删除内容

经源码与测试引用搜索确认无调用后，移除7个内部接口或常量：`registerOutputStyle`、`getWorkflow`、`deleteRuns`、`resetAgentSlots`、`resetTaskSlots`、`HORIZONTAL_BAR`、`STATUS_GREEN`。

现有内置输出风格继续工作，会话删除仍使用真实调用的 `deleteRunsInDir`，子代理并发与取消保持原执行路径，终端继续使用现有主题和符号。测试用重置函数、数据溢出兼容接口与 `PersistenceManager` 等有明确用途的代码保留。

移除一次性 `scripts/tui-theme-preview.tsx`，以及旧估算脚本 `benchmark-baseline.ts`、`estimate-classifier-cost.ts` 和它们的归档说明页。历史报告仍保留当时的文件名，当前文档不再提供这些脚本的可运行链接。

清理两处未使用测试import、过时的TypeScript目录匹配，以及本地Python字节码和空目录。配置、凭证、会话与记忆数据保持不变。

## 防止再次积累

开启 `noUnusedLocals`，使未使用的局部声明与import在类型检查时直接报错。`noUnusedParameters` 保持关闭：当前两个参数有明确的兼容签名用途，删除它们会扩大本次改动。

## 验证

检查严格类型与源码格式，运行相关功能回归、实际发布包构建和解包验证，并核对文档数量、日期命名与本地Markdown链接。未新增测试或删除现有测试用例，完整测试数量仍为222文件、2940用例。

实际结果：类型检查、源码代码检查、文档统计通过；10个相关回归文件的166项测试通过；发布包构建与解包检查通过，仍为64文件、解压7.40 MiB；172份Markdown本地链接检查通过。本轮未重跑全量测试。
