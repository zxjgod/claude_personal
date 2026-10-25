# Managed Loop

输入 `/loop` 并回车打开二级管理菜单；一级斜杠菜单中的 `/loop` 条目仍正常可选。
运行中的任务也可以打开菜单查看、暂停或停止。菜单和普通输入框使用相同的淡紫色选择样式。

## Profiles

| Profile | Description | Default Rounds | Cadence | Interval | Token Budget |
| --- | --- | ---: | --- | ---: | ---: |
| Collaborative | Verified iterations with human guidance. | 10 | Adaptive | 3 min | 1,000,000 |
| Autonomous | Independent engineering work with checks and recovery. | 30 | Adaptive | 3 min | 3,000,000 |
| Scheduled | Recurring checks on a fixed schedule until stopped. | Continuous | Fixed | 10 min | 3,000,000 |
| Conservative | Limited iterations with detailed feedback. | 3 | Fixed | 3 min | 200,000 |

所有档位没有总时长上限。`Scheduled` 不设置最大轮数且不因“当前健康”结束，直到停止或预算耗尽。
其余档位设置最大轮数，可在 Limits 修改；失败的已启动迭代同样计入轮数。
配置分别保存到 `settings.json` 的 `loop.profiles`，切换 New profile 不改写正在运行的另一档位任务。
为当前任务所属档位修改设置时会即刻更新当前任务，但累计轮数和消耗保留。

## Menu

| Item | Behavior |
| --- | --- |
| New profile | 左右键选择四个预设，英文介绍显示在标题下方。 |
| Interval | 左右键以1分钟步长调整，最小3分钟，最大30分钟。 |
| 1. Start task | 输入完整目标并启动；替换旧受控循环时保留其历史。 |
| 2. Status | 显示目标、状态、轮数、调度、token消耗、金额估算、下次时间及原因。 |
| 3. Pause | 等待当前轮结束后暂停；保存目标和计数。 |
| 4. Resume | 从暂停或失败处恢复；不清零额度。达到上限时先提高上限。 |
| 5. Stop | 立即阻止后续轮次，并请求中断当前模型及其子代理。 |
| 6. Completion checks | Model、Checks 或 Hybrid；可配置检查命令和必须存在的文件，一行一个。Scheduled 使用 Continuous。 |
| 7. Retry & notifications | 临时错误重试上限、通知模式、历史保留条数。 |
| 8. History | 每轮开始、结果、配置修改、暂停恢复及停止记录；保存最近10个旧任务。 |
| 9. Limits & recovery | 轮数、token／金额上限、主模型输入／输出单价；Tab 切换到恢复、错过轮次、时区与工作时段。 |

上下键选择，左右键调整档位，Enter 执行或编辑，Esc 返回。1～9可直接选择对应操作。
多行编辑可用 Ctrl+J。长状态与历史可以滚动查看。
命令行接口继续支持 `/loop <task>`、`/loop status`、`/loop pause`、`/loop pause now`、`/loop resume`、`/loop stop`、`/loop history`。

## Scheduling And Verification

Fixed 在当前轮结束后等待配置的 Interval。Adaptive 允许模型通过 ScheduleWakeup 建议更长的等待时间，
但最小值由 Interval 决定、最大值为30分钟；模型没有建议时采用 Interval。
模型不能在受控循环中创建独立的 CronCreate、schedule_cron 或 sleep 定时任务。
Scheduled 的固定周期不会在繁忙期间积压多轮，后台子代理未完成时也不启动新轮次。
独立 `/schedule` cron 任务继续使用原有调度器，与受控循环分开管理。

## Progress File And Deliverables

循环与所在会话共享聊天历史，历史超过模型上下文窗口的 85% 时会被自动压缩成摘要，
早期轮次的细节因此丢失。为防止质量随轮数衰减，受控循环默认启用**进度文件**
（`.claude/loops/<session>.progress.md`，可在 settings.json 的
`loop.profiles.<profile>.progressFile` 设为 `false` 关闭）：

- 启动任务时写入模板（Objective / Status / Done / Key findings / Next plan / Blockers）；
- 每轮系统指令要求模型在轮内用文件工具把累计状态更新进该文件——它是跨轮的持久记忆；
- 每轮注入消息会重新携带该文件的当前内容（截断至约 12,000 字符），即使聊天历史被压缩，
  模型每轮仍从磁盘恢复完整上下文；会话回放中不显示这段重注入内容；
- 最终 wrap-up 轮额外要求在该文件写入 `## Final Report`（结果对照目标、验证证据、
  交付物、遗留问题），交付结论落盘而非只留在聊天记录里；
- 循环停止或判定完成时，运行时在文件末尾追加一行带时间戳的备注。

启动任务时若未配置任何完成检查（命令或文件），命令行与菜单都会提示补配——
没有机器可查的验收标准时，循环只能依赖模型自评结束，这正是完成判定要防止的失败模式。

最大轮数前的两轮注入 CONVERGENCE ROUND 系统提示，要求尽快完成必要工作并缩小范围。
最后一轮注入 FINAL WRAP-UP ROUND，要求最终验证、说明完成项和遗留问题，不再安排后续迭代。
提示不能保证模型一定完成；确定性检查或独立模型评估未通过时保存进度并暂停，而不是伪报完成。
完成检查走现有文件与Shell工具的权限、Hooks及取消流程，用户拒绝的检查不会被绕过。
同一会话的 `/goal` 自动续做在受控循环轮内暂停，避免两套控制器同时续跑。

## Limits And Recovery

预算覆盖主模型、子代理、摘要和完成评估；并发请求共享预留额度。
token预算默认启用，输入／输出金额单价可配置，金额限制默认关闭；0表示关闭该预算项。
自定义单价只应用于启动时的主模型，切换模型或子代理采用对应模型的已知价格；未知价格会暂停金额受限任务。
金额仅是本地估算，并非供应商账单硬限额。缺失usage的请求按预留额度保守记账。
暂停恢复继续累计消耗；不能为已经产生未知费用的任务补设金额限制来假装覆盖过去的费用。

临时超时、网络错误、429或5xx可在迭代层递增等待，最大30分钟；成功一轮后清零连续失败次数。
权限／凭据、预算不足、无效验收响应等错误不盲目重试。达到次数上限标为 Failed，可检查后手动 Resume。
Important通知完成、停止、失败或需要处理；Changes额外报告结构化检查结果变化；All每轮报告状态。
普通对话流式输出与工具结果仍会显示，通知模式控制的是附加的循环状态通知。

运行状态保存在工作区 `.claude/loops/<session>.json`，原子写入并记录当前进程归属。
同一会话被另一CLI活动占用时不会重复启动；占用进程退出或租约过期后可恢复。
默认 Confirm 恢复为暂停；Auto仅自动恢复已等待的任务，运行中断的任务仍要求人工恢复。
错过执行可选 Skip、Once 或 Confirm；无积压重放。Manual只恢复记录、不自动执行。
时区使用IANA名称，工作时段支持跨午夜；周末可跳过。整个循环没有有效期或总时长限制。
CLI关闭期间不会执行任务。停止和暂停不会撤销已经完成的文件修改或外部操作。
