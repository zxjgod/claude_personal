# 更新日志 — 沙箱/剪贴板/插件审查问题全量修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-09-13
> 类型：fix | security | feature
> 模块：native-sandbox、sandbox-policy、clipboard、MCP elicitation UI、plugins/marketplace、HelpPanel/i18n、tool-output
> 主题：清掉 09-13 外部审查核实清单上的全部条目——2 个 P0 blocker(沙箱 C# 编译失败、中文 /copy 乱码)、沙箱绕过面、elicitation 校验缺失、远程插件只下 manifest、writeMarketplace 死代码
> 状态：已落地（含第六节第二轮修复）
> 验证：`npx tsc --noEmit` 0 错误、`npx biome check src --diagnostic-level=error` 0 error、`npx vitest run` **138 文件 / 1709 用例全绿**;本机(CP936)对沙箱与剪贴板做了进程级 e2e 实测(见第五、六节)
> 关联文档：`20260910-tui-batch1-batch2-fixes.md`(上一批)、记忆 `sandbox-review-verify-2026-09`(原始核实清单)

---

## 一、现象

| # | 级别 | 现象 |
|---|------|------|
| 1 | P0 | `native` 沙箱 100% 失败:`runWindowsSandbox` 恒返回 `code:1` 且**无任何诊断输出**——本仓库自带 `.claude/sandbox.json`(enabled+native),等于所有 win32 用户的 Bash/PowerShell 工具装上即废 |
| 2 | P0 | 中文 Windows(CP936)上 `/copy` 复制含中文内容,粘贴得到乱码("中文" → "涓枃") |
| 3 | P1 | 沙箱策略三个绕过面:cwd 大小写敏感比较、`deniedCommands` 子串可被引号/脱字符拆散、网络黑名单正则漏 `irm`/`Invoke-RestMethod` |
| 4 | P2 | MCP elicitation UI:声明了 `minimum/maximum/enum` 不校验,非数字输入把 `NaN` 发给服务器;粘贴(单事件多字符)被静默丢弃;Backspace 键实际插入 `\x7f` 控制字符而非删除 |
| 5 | P2 | `installRemotePlugin` 对 URL 只下载 `plugin.json`——"安装成功"但组件(skills/commands/agents)全不存在;`writeMarketplace` 零调用方 |
| 6 | P3 | 帮助面板文案硬编码 "800ms"(与 `EXIT_DOUBLE_PRESS_MS` 漂移风险);diff 行号槽 `padStart(4)` 在行号 >9999 时撑宽错位 |

## 二、根因与修复

### 1. native 沙箱(`src/native-sandbox.ts`,重写)

| 根因 | 修复 |
|------|------|
| C# 字符串用了相邻 `""` 引号(Pascal/CSV 惯用法,**C# 不存在该转义**)→ Add-Type 编译失败 | 引号字符改由 `((char)34).ToString()` 构造——本文件的 C# 从此**不可能出现**任何需要 TS/C# 双层转义的引号或反斜杠,并在模板字面量旁立了防回归注释 |
| 宿主 powershell 的 stdout/stderr 从未接 data handler → 编译错误、win32 错误码全部丢失 | 接 `child.stderr` 原始字节(GBK 错误信息经 `decodeCapturedOutput` 还原),随 result.stderr 上抛;`bash.ts`/`powershell.ts` 的"启动失败"错误信息现在携带这些诊断 |
| (修复过程中实测新暴露)`Process.GetProcessById` 在命令秒退后抛"进程当前未运行" | 改为直接 `WaitForSingleObject(pi.process)` + `GetExitCodeProcess`,不依赖 pid 注册竞态 |
| (实测新暴露)`echo x 1>&2` 这类用户侧重定向与追加式 `> out 2> err` 左结合打架,stderr 被交换进 stdout 文件 | 用户命令包进 `( )`,我们的重定向放括号外——cmd 重定向按"先外后内"绑定,语义正确 |
| (实测新暴露)`\"` 引号转义被 cmd 内建(echo)按字面输出 | 不再转义:`/s` 模式下 cmd 只剥离首尾引号,内部引号原样传给外部程序(其自带 argv 解析器正确处理) |
| 受限令牌 `CreateProcessAsUser` 需要普通用户没有的特权 | 失败时**静默回退**到同 Job Object 内的普通 `CreateProcess`(资源上限、超时 kill-on-close 仍生效);硬失败才打 win32 错误码 |
| powershell `exit` 把哨兵负码映射进 uint32 空间 | TS 侧仅还原 -10..-16 这一已知带域,程序自身的负退出码/NTSTATUS 维持原样 |
| cmd 重定向文件按 GBK 写出,UTF-8 解码乱码 | `decodeCapturedOutput`:strict-UTF-8 → GBK → lossy UTF-8 三级解码 |

> **追记(2026-09-26,Top10 #7)**:上表"静默回退"一行已被用户决策更新为**回退必告警**——
> 内嵌 C# 新增 `Warn()`,在「受限令牌拿不到」与「`CreateProcessAsUser` 失败回退」两处向宿主
> stderr 发**哨兵行**,格式固定为前缀 `ccr-sandbox: WARNING: `(注意 WARNING 后带冒号;硬失败
> 的 `Fail()` 行是 `ccr-sandbox: <op> failed ...`,**不带** WARNING,两者靠前缀精确区分)。
> TS 侧 `splitSandboxWarnings()` 按行剥离哨兵(干净命令的 `result.stderr === ""` 契约不变,
> `sandbox-policy.test.ts` win32 e2e 锁定),`reportSandboxDegraded()` 把首条升级为
> **每进程一次**的 `console.error` 通知(`__resetSandboxWarnedForTests()` 供测试复位)。
> 防回归要点:① C# 的 Warn 文案仍受"平铺字面量、禁引号转义/反斜杠/注释反引号"守则约束;
> ② 新增哨兵文案必须带 `ccr-sandbox: WARNING:` 前缀否则会被当作命令 stderr 泄漏给模型;
> ③ 不要把告警直接写进 result.stderr——工具层把 stderr 当命令诊断喂给模型,沙箱自身降级
> 不属于命令输出。

### 2. 剪贴板(`src/utils/clipboard-text.ts`)

- 主路径改 **`Set-Clipboard`**,脚本(含文本)整体走 `-EncodedCommand` base64 UTF-16LE——文本完全绕开 argv 引号与一切代码页。
- clip.exe 降为回退:实测确认它对 UTF-16LE+BOM 能保住中文(不再"涓枃"),但会把 **BOM 混入剪贴板文本并追加尾部 `\r\n`**(实测捕获),故不再做主路径。
- 修复后本机实测:`中文测试ABC line1\nline2 漢字` 写入→读回**逐字节相等**。

### 3. 沙箱策略(`src/sandbox-policy.ts`)

- cwd 与 allowedDirectories 比较走 `normalizePath`(win32 小写归一,与 `tools/utils/path.ts` 的 containment 规则同构);
- 新增 `normalizeForMatching`:剥离 `"` `'` ^ 反引号后再做 deniedCommands 子串与网络正则匹配;
- 网络黑名单补 `irm|Invoke-RestMethod`;
- 函数头注释明确定位:**这是启发式 deny-list,不是能力边界**——真正的边界只有 native runner 的 token/job,且它限资源不限网络/文件系统。

### 4. ElicitationPrompt(`src/tui/Prompts.tsx`)

- 提交前按 schema 校验:`enum` 白名单、数字 `Number.isFinite`(NaN 不再外流)、`minimum/maximum` 界内;违规显示行内错误、不 resolve,再次编辑自动清除;
- 接受多字符 `input`(粘贴),过滤控制字符;
- **Backspace 分支移到可打印字符分支之前**(Ink 把 Backspace 作为 `\x7f` 字符送达,原先的 `length===1` 分支会先命中并把 DEL 插进值里——审查未点名、本轮新发现的实打实 bug)。

### 5. 插件(`src/plugins.ts`、`src/commands/plugin.ts`)

- 新增零依赖 `extractZip`(中央目录扫描 + stored/deflate,拒 Zip64、拒 `..`/绝对路径条目 = zip-slip 防护);
- `installRemotePlugin`:字节以 `PK\x03\x04` 开头 → 解包整个插件(自动下降一层常见包裹目录找 plugin.json);裸 manifest URL → 按声明的组件路径相对 manifest URL 逐个补拉;
- 暂存目录从 `pluginRoot()`(新工作区不存在时 mkdtemp 直接 ENOENT——原代码就有的 bug)改到 OS 临时目录;
- `validatePluginManifest` 拒 `..` 段(`path.isAbsolute("../x")` 是 false,原来的校验挡不住);
- `writeMarketplace` 接上调用方:`/plugin marketplace add <url> | remove`,`/plugin install <name>` 支持按 marketplace 名字解析源安装。

### 6. 小项

- `ui.help.shortcut.exit` 文案改 `{ms}` 插值,HelpPanel 传 `EXIT_DOUBLE_PRESS_MS`——文案与常量单一真源;
- `renderNumberedDiffLine` 增加 `gutterWidth` 参数,`toolOutputLines` 按最大行号定宽(>9999 行不再错位)。

## 三、测试

- `sandbox-policy.test.ts`:去掉 win32 短路;新增网络别名/引号/脱字符绕过用例、win32 cwd 大小写用例;新增 **5 个 win32 端到端用例**(`it.runIf`):echo+stdout 捕获、exit code 传递、`1>&2` stderr 捕获、引号+`&&` 复合命令、超时 kill——C# 一旦再次编译失败,全量测试当场红,而不是只废掉用户。
- `elicitation-ui.test.tsx`(新文件,4 用例):min/max、NaN、enum、粘贴+退格。
- `plugins.test.ts`:手写 zip 构造器(stored+deflate+CRC32),extractZip 往返、zip-slip 拒绝;起**真实本地 HTTP server** 测 zip 安装(组件文件落盘)、manifest 组件补拉、`addMarketplaceFromUrl`/`findMarketplacePlugin`。

## 四、修一次编译失败暴露出的两层旧 bug(为什么必须 e2e)

首轮进程级实测(T1 echo / T2 exit / T3 中文 / T4 超时)证明"看着对"和"能跑"的差距:
`GetProcessById` 竞态、`1>&2` 重定向互踩、`\"` 内建字面化——三个问题都编译得过去、单元测试(纯策略层)全测不出来。这也正是旧版本能带着编译错误发布的原因:**win32 路径此前零端到端覆盖**。

## 五、验证记录(本机 CP936,win32)

```
T1 echo:        {"code":0,"stdout":"hello-sandbox \r\n","stderr":""}
T2 exit /b 3:   {"code":3}
T3 中文 echo:    "中文测试ABC \r\n"          ← GBK 解码正确
T3b 1>&2:       stderr 含 "oops",code 0      ← 括号重定向修复后
T4 timeout:     {"timedOut":true}
T5 clipboard:   exact match: true            ← Set-Clipboard 路径,逐字节
```

---

## 六、第二轮(09-13 复审后修复)

复审确认第一轮全部落地后,又核实出 **1 个第一轮引入的新 bug + 4 个第一轮未覆盖的遗留项**,本轮全部修复:

### 1. 超时误报为"沙箱无法启动"(第一轮引入,工具出口层)

超时 kill 后 runner 返回 `code:null, timedOut:true`,而 `bash.ts`/`powershell.ts` 的拒绝分支先判 `code === null` → 用户看到的是 "Native Windows sandbox could not be started; command refused",下面的 `timedOut` 分支成死代码,已捕获的部分输出也被丢掉。修复:拒绝条件加 `!result.timedOut &&`;超时 metadata 对齐非原生路径(`{exitCode:-1, timedOut:true}`)。

### 2. abortSignal 未接入原生路径(P2-5 遗留)

runner 支持 `options.signal`,但两个工具调用时都没传 `context.abortSignal` → Ctrl+C 中断不了沙箱内命令,只能干等超时(与 #1 叠加更糟)。修复:传入 signal;`aborted` 时返回与非原生路径一致的 `{content:"Command aborted.", metadata:{exitCode:-1, aborted:true}}`。

### 3. PowerShell 工具原生路径带引号命令必挂(P1-3 遗留)

`-Command ${JSON.stringify(cmd)}` 的 `\"` 是 MSVCRT argv 惯用法,**不是 cmd 的引号转义**——cmd 把反斜杠当字面量、把引号当 quote-state 开关,`Write-Host "a & b"` 实测 ParserError(字符串缺少终止符)。修复:命令写入临时 `.ps1`(**带 BOM**,PS 5.1 读无 BOM 文件按 ANSI/GBK,中文字面量会花)+ `-File` 执行;`-ExecutionPolicy Bypass` 必带(`-File` 与 `-Command` 不同,受执行策略管,客户端默认 Restricted)。解析链上只剩一个带引号的路径 token,转义问题整体消失。

### 4. KNOWN_SETTINGS_KEYS 白名单虚设(P1-13 遗留)

`statusLine`、`apiKeyHelper`、`additionalDirectories`、`cleanupPeriodDays`、`includeCoAuthoredBy`、`enableAllProjectMcpServers` 六键全仓 **0 消费**却被列为"已知"→ `warnUnknownSettings` 恰恰对它们不警告,与其 doc 注释直接矛盾(用户配了 statusLine 无警告也不生效)。修复:白名单收缩到真实消费的六键(hooks/permissionMode/permissions/telemetry/env/model),其余键现在会触发启动警告。

### 5. 小项

- `mcp/auth.ts` 的 `authDir()` 从 `process.cwd()` 改为 `getWorkspaceRoot()`(WORKSPACE_ROOT env 优先,与其余配置层同一真源);
- `plugins.ts` extractZip 加解压炸弹下限:声明的 uncompSize 与 `inflateRawSync({maxOutputLength})` 双重上限(64MB/条目,头部可以说谎);
- `mcp/index.ts` `handleElicitation` 的 mode==="url" 死分支合并(两臂原本完全相同),顺手清掉未使用的 `os` import;
- `native-sandbox.ts` doc-comment 记录 `( )` 分组的固有限制:**未加引号的不配对 `)`**(如 `echo )`)会提前闭合分组导致 cmd 语法错;引号内/配对的括号安全。不要为此拆掉分组——它防的 `1>&2` 互踩更严重。

### 第二轮测试与验证

- 新文件 `sandbox-tools.e2e.test.ts`(`it.runIf(win32)`,4 用例,**工具层** e2e):Bash 超时报"timed out"且保留部分输出、Bash abortSignal 中断、PowerShell 带双引号+中文命令(temp .ps1 + BOM 验证)、PowerShell 超时;
- `plugins.test.ts` +1:中央目录声明超大 uncompSize → 拒绝(/cap/);
- `hooks-config.test.ts` +2:六个未消费键全部触发警告、六个消费键静默;null settings 返回 []。
- 定向 37/37 绿;tsc 0 错误;biome 无新增告警(7 条均为存量 `noNonNullAssertion` style)。全量回归见下方追记。

> 遗留(明确不修,语义如此):插件 URL 用裸 `fetch` 不做私网拦截——`/plugin install <url>` 是用户亲手输入,等同 curl,与模型自选 URL 的 web-fetch(有 SSRF 规则)信任级不同;`/add-dir` 仍是 stub(在 TUI 待办清单上)。
