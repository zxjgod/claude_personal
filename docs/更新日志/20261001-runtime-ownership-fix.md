# 架构审查修复：执行约束与运行时状态归属

- 日期：2026-10-01 开始，2026-10-02 完成
- 版本：1.5.0
- 提交主题：`fix: preserve execution policy and runtime ownership`
- 范围：包含前次未提交的 TUI prompt、ScheduleWakeup schema 与磁盘 loader 修复。

## 修复后的行为

- Task、Agent、Team、Workflow 都保留父会话的权限规则；`ask` 规则经过受限审批器时仍交给父审批。
- 同一次 agentLoop 使用一个有效 HookRunner；子代理的 PreToolUse、PostToolUse 与 Stop 能进入真实执行流程。
- checkpoint 绑定会话的存储工作区，工具切换目录不改变旧 blobs 的读取位置。用户消息持久保存回合与会话标记，恢复后 `/rewind` 可以还原对应文件；内容丢失时报告失败并保留回退记录。
- cron 与 wakeup 保存工作区 / 会话归属；持久任务按所属工作区加载并原子写回，跨工作区相同任务 ID 也互不覆盖。
- 已到期但尚未送达的输入保留身份；停止 loop 或取消任务覆盖排队状态。非当前会话的输入留给原会话。
- `schedule_cron`、CronCreate/Delete/List、sleep、ScheduleWakeup、`/schedule` 与 `/loop` 共用归属和取消规则。
- `/tools` 读取当前注册表，MCP 更新后与执行集同步。
- 历史架构、维护与项目概况已归档；当前导航、领域词汇、设计取舍与文档事实检查已更新。

## 测试证据

回归包含四种委派入口的 deny / ask / hook、Agent 的 post-tool / stop、切目录后旧快照移出内存、重启后的实际 `/resume → /rewind`、缺失 blob、两个工作区任务文件、重复任务 ID、排队取消、恢复会话隔离和真实 setupTools 刷新。

本机 Windows / Node 24 验证：

- 类型检查通过。
- 164 个测试文件、2156 个用例全量通过。
- Biome 0 error，681 warning、1 info 为现有代码基线。
- esbuild 构建及 smoke 通过。
- 文档指标、链接路径、验证口径检查通过；源码 245 文件、50,418 行，49 个内建命令、47 个注册工具定义。
- 最终 diff 审查与空白检查通过。

本机结果不等于 Linux / Node 20 CI 或真实云网关、模型 provider 的联网验证。

## 兼容边界

旧版消息没有持久回合标记，无法可靠补出文件关联，仍仅回退对话。Shell 修改不进入 checkpoint。调度持久文件仍为 best-effort 单进程注册表，并非跨进程事务存储。安装即信任、沙箱降级告警与暂缓大型重构的既有决策继续采用。
