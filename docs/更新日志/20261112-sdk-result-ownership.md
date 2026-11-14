# SDK 结果帧对应输入标识

> 2026-11-12 · fix / test · stream-json、TypeScript SDK、Python SDK

当两个用户输入已经发送时，原 TypeScript SDK 会把第一轮的重复结果计作第二轮。夹具让 CLI 正常退出且始终缺少第二轮结果，修复前两个定向用例都错误地完成了查询。

本项目的双向 stream-json CLI 在 `system/init` 宣告 `capabilities.result_input_id`。TS 和 Python SDK 发送带唯一 `input_id` 的 `user` 帧，CLI 在对应 `result` 帧回传该值。SDK 只接受当前队首输入的结果，重复、迟到、乱序及缺少必需标识的结果作为诊断。`error_scope: "session"` 标记预检或输入协议错误，保留机器可读的终止结果。CLI 会拒绝同一进程里重复提交的输入标识。

旧 CLI 仍可按提交顺序返回不带 `input_id` 的结果。若存在稳定的结果 UUID，SDK 会识别重复 UUID。旧 CLI 在省略输入标识且重复帧没有相同 UUID 时，无法可靠区分重复结果和下一轮结果。Python 发送已写入管道后即保留该输入的记录，调用者取消等待发送缓冲区时仍可接收其结果。

定向验证 5 文件、44 项通过，Python 独立协议集 24 项通过。真实 CLI 的 TypeScript 测试覆盖中断、恢复、恢复过程超时及再恢复，检查已完成回合的标识各自独立。Python 的真实 CLI 测试核对中断、继续和新进程恢复。离线夹具核对重复或乱序帧不会补齐缺失的第二轮结果。

类型检查与代码检查通过。Windows `npm test -- --maxWorkers=2` 全量 259 文件、3,268 项通过、1 项跳过，耗时 342.70 秒。发布包烟测通过，核对了解包后 CLI 的能力声明和会话级预检错误帧。
