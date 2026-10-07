# 更新日志 — a9e50bc 复审（批次三）修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-09-19
> 类型：fix | security | robustness
> 模块：native-sandbox、sandbox-policy、bash/powershell 工具、plugins(zip)、Prompts(elicitation)
> 主题：修复对 `a9e50bc`（批次一/二）复审发现的残留问题——原生沙箱输出无上限（OOM 面）、C# 失败路径泄漏挂起进程、网络黑名单两个高频别名绕过、`( )` 分组不平衡引号静默吞 stdout、原生路径 `cd` 不持久、integer 字段放行小数、zip 无总量预算
> 状态：已落地
> 验证：`npx tsc --noEmit` 0 错误；biome 对改动文件无新增告警；`npx vitest run` **138 文件 / 1718 用例全绿**（新增 9 个，含 4 个 win32 全路径 e2e）
> 关联文档：`20260913-sandbox-clipboard-plugin-fixes.md`（被复审的批次一/二）

---

## 一、问题清单（复审结论）

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| 1 | P1 | 原生沙箱对重定向文件整读（`readFileSync`），命令可在超时窗口内写数 GB → agent OOM；job 也未设内存上限，commit 声称的 "resource limits" 只有 kill-on-close | `native-sandbox.ts` |
| 2 | P1 | 网络黑名单：`npm i`（install 别名，会执行 install 脚本）与 `pip3 install`（`\bpip\b` 无边界）均可绕过 | `sandbox-policy.ts:88` |
| 3 | P2 | C# `return -13` / `return -15` 路径：CREATE_SUSPENDED 的 cmd.exe 永不恢复也不被杀（不在 job 内，宿主退出带不走）→ 挂起进程泄漏；`SetInformationJobObject` 失败仅记日志继续 → job 无 kill-on-close，此后超时击杀形同虚设、整棵树存活 | 内嵌 C# |
| 4 | P2 | 退出码哨兵带 `0xFFFFFFF0..F6` 与用户 `exit /b -12` 碰撞 → 误报 "sandbox could not be started" | `native-sandbox.ts` finish() |
| 5 | P2 | `( )` 分组 + `/s` 剥外层引号：用户命令中**不平衡的 `"`** 使引号状态错位，把 runner 的重定向路径折进用户字符串 → stdout 静默丢失（旧文档只记录了不平衡 `)` 这一半） | `native-sandbox.ts` / `bash.ts` |
| 6 | P3 | 原生路径成功后不调 `rememberCd` → 本仓库（enabled+native）下 M39 会话 cwd 持久化静默失效 | `bash.ts` / `powershell.ts` |
| 7 | P3 | `run_in_background` + native 的拒绝文案误导（"use a supported Windows environment"，实为不支持后台） | `bash.ts` |
| 8 | P3 | elicitation `integer` 字段只查 `isFinite`，`3.7` 可提交给声明为整数的字段 | `Prompts.tsx` |
| 9 | P3 | zip 解压只有单条 64MB 上限，无总量/条目数预算 → 千条 63MB 条目可填满磁盘 | `plugins.ts` |

## 二、修复

### 1. 捕获封顶（#1）

`finish()` 不再 `readFileSync` 整读：`statSync` 后按 `min(size, cap+16)` 分块读（+16 字节余量防止多字节字符被切断导致解码器误判回退 GBK），超限置 `truncated` 并在 stderr 追加说明行。`NativeSandboxResult` 新增 `truncated` 字段，bash/powershell 工具映射到 `ToolResult.truncated`（格式化器会标记数据丢失）。上限 10MB 与工具层内存守卫一致；`maxCaptureBytes` 选项仅供测试注入。

### 2. C# 失败路径（#3）

- 新增 `TerminateProcess` P/Invoke；`CreateJobObject` / `AssignProcessToJobObject` 失败时先 `TerminateProcess(pi.process)` 再返回哨兵——挂起子进程不再泄漏。
- `SetInformationJobObject` 失败改为硬失败（哨兵 + 终止）：没有 kill-on-close 的 job 无法保证超时拆解，宁可拒绝启动。

### 3. 哨兵带迁移（#4）

初始化失败哨兵从 `-12..-16`（uint32 落在 `0xFFFFFFF0..F6`，与用户负数退出码碰撞）迁至 **`0x4CC0000n`** 独立带——避开 cmd 的 0-255、NTSTATUS 的 `0xC0000000+` 与小负数带。TS 侧只重映射该带，`exit /b -12` 现在如实上报 `4294967284`。

### 4. 引号奇偶守卫（#5）

`bash.ts` 新增 `cmdQuoteToggles()`：按 cmd 语义计数引号翻转（裸 `"` 翻转；引号外 `^` 吃掉下一字符，故 `^"` 不翻转；引号内 `^` 为字面量）。奇数 → 在 spawn 前拒绝并给出可行动的错误，替代原先的静默丢输出。PowerShell 工具不受影响（命令暂存 .ps1，cmd 行由固定平衡引号构成）。文档同步补全"不平衡引号"这一半限制。

### 5. 网络黑名单（#2）

正则补齐：`npm (i|ci|install|publish)`、`pnpm (i|add|install)`、`yarn (add|install)`、`pip3? install`、`certutil -urlcache`、`bitsadmin /transfer`、`Start-BitsTransfer`、`scp`/`ftp`。词边界保证 `npm init`（i 后跟 n）仍放行。清单依旧是启发式（非能力边界），注释如实声明。

### 6. 其余小修（#6/#7/#8/#9）

- 原生路径成功（非超时、code 0）后调用 `rememberCd`，与非原生路径 M39 行为对齐。
- 后台拒绝文案改为如实说明"native 沙箱不支持后台执行"。
- `integer` 字段提交前校验 `Number.isInteger`，内联报错 "must be a whole number"。
- zip 解压新增 `MAX_ZIP_TOTAL_BYTES = 256MB`（按**实际**写出/解出字节累计，写在写盘之前）与 `MAX_ZIP_ENTRIES = 20_000`（EOCD 声明即拒）。

## 三、测试（+9）

| 文件 | 新增 |
|------|------|
| `sandbox-policy.test.ts` | 黑名单别名（npm i/ci、pip3、pnpm、yarn、certutil、bitsadmin；`npm init` 放行）；runner 级 win32：2KB 封顶截断 + `exit /b -12` 以 `0xFFFFFFF4` 原样穿透（哨兵带无碰撞） |
| `plugins.test.ts` | 27×10MB deflate 跨条目总量炸弹（压缩后 <2MB）触发 total budget；EOCD 声明 20001 条目被拒 |
| `elicitation-ui.test.tsx` | `3.7` 对 integer 字段被拒（"must be a whole number"），改 `7` 后以数值提交 |
| `sandbox-tools.e2e.test.ts` | `cmdQuoteToggles` 纯逻辑 4 断言（平衡/奇数/`^"` 转义/引号内 `^` 字面）；win32 全路径 e2e：不平衡引号 spawn 前被拒；`echo ^"quoted`（奇偶 0）正常执行并捕获 |

## 四、验证记录

- `npx tsc --noEmit`：0 错误。
- `npx biome check`（改动文件）：无新增告警（存量 8 条为 Prompts.tsx 既有 noNonNullAssertion/useTemplate）。
- `npx vitest run`：138 文件 / **1718** 用例全绿（68.9s，win32）。
- `node scripts/doc-sync.mjs --check`：0 漂移（srcLines 44,548；tools 47 的存量漂移一并修正）。

---

## 五、批次三自身复审的追加修复（2026-09-19 同日）

- **P2 截断 UTF-8 输出整段乱码**：`readCapped` 按 `cap+16` 切断时若切在多字节字符中间，严格 UTF-8 解码失败 → GBK 回退把**整段**捕获（最多 10MB）变成乱码（原注释声称 +16 slack 可防止，不成立）。新增 `trimToUtf8Boundary()`：解码前回退到 UTF-8 字符边界（最多丢 3 字节）；GBK 内容至多损失尾部一个残缺字符，可接受。
- 测试 +4：`trimToUtf8Boundary` 纯逻辑 3 断言（干净切口不动 / 3 字节序列两种切法 / 4 字节 emoji）；win32 e2e 用 `node -e` 输出 2000×"中"（6000B、cap 1000 → 读 1016B，`1016%3=2` 必切断），断言含 "中中中" 且不含 GBK 乱码 "涓"。已做负向验证：去掉 trim 后该 e2e 如实失败（输出全为 "涓…"）。
- 验证：`npx tsc --noEmit` 0 错误；biome 无新增告警；sandbox-policy + sandbox-tools.e2e 共 24 用例全绿。
