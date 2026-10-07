# 更新日志 — Bash 工具死循环 / 转圈卡死修复

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-26
> 主题：修复「本地执行 task 有概率进入死循环、AI 一直转圈无响应、Ctrl+C 无效」
> 验证：`npm run build` 通过，`npx vitest run tools/agent-loop/permissions` **63 / 63 全过**；手动复测死循环命令约 2s 返回超时、无孤儿进程、Ctrl+C 约 1.3s 返回

---

## 一、现象

在工作空间执行 `bash` 指令（或模型自行发起带 bash 的 task）时，**有概率**进入死循环：

- AI 回复一直转圈（`✶ Thinking…`），无法继续响应；
- Ctrl+C 常常无效，只能强制关闭终端；
- 任务管理器里能看到残留的 `node.exe` / 命令进程（孤儿进程）。

完整根因分析见 [`archive/bash-deadlock-analysis.md`](../bash-deadlock-analysis.md)，本次修复即针对该文档列出的全部缺陷。

---

## 二、根因（两条缺陷叠加放大）

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | `exec`/`execAsync` 超时只 `SIGTERM` 直接子进程（cmd.exe），孙进程（真实命令）成孤儿并占住管道写端 | `src/tools.ts` BashTool | `tool.call()` 的 promise **永不 settle**，agent loop 卡死 |
| 2 | BashTool 标记 `isConcurrencySafe: true` 走并行路径；并行路径不响应 abort | `src/tools.ts` + `src/agent-loop.ts` | 一个永不返回的工具拖死整批并行工具，Ctrl+C 失效 |

**机制（Windows 特有）：** `exec(cmd, { shell: 'cmd.exe' })` 的进程树是
`主进程 → cmd.exe → node.exe(真实命令)`。`exec` 超时只杀 cmd.exe，孙进程成孤儿
继续持有管道写端且永不退出 → 管道永不关闭 → `execAsync` 的 promise 永久 pending。
agent loop 卡在 `for await (event of loop)` 等工具结果，`store.setBusy(true)`
永远不被置回 → UI 永远转圈。

---

## 三、改动明细

### 修复 A（根因）：BashTool 改用 `spawn` + 进程树杀，弃用 `exec`/`execAsync`

**文件：`src/tools.ts`**

弃用 `execAsync`（基于 `exec`），改用 `spawn` 自行管理子进程。超时 / abort 时
**杀整棵进程树**，保证管道关闭、promise 必 settle：

```ts
const child = spawn(input.command, [], {
  cwd: context.workspaceRoot,
  shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
  windowsHide: true,
  detached: process.platform !== "win32", // Unix 下用进程组信号
});

const killTree = () => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // /T = 连同子树一起杀；taskkill 比 child.kill() 可靠得多
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      }).unref();
    } else {
      process.kill(-child.pid, "SIGKILL"); // 进程组
    }
  } catch { /* 已退出 */ }
};
```

要点：
- **`taskkill /T /F`**（Windows）才能杀掉 cmd.exe 之下的孙进程；
- Linux/mac 用**进程组**杀（`spawn(..., { detached: true })` + `process.kill(-pid)`）；
- `abortSignal` 触发时同样 `killTree()`，保证用户中断能立即让 promise settle；
- 超时用显式 `timedOut` 布尔标志判断（见下）。

#### 修复 A.2（验证中发现）：超时检测不能靠 `exitCode === null`

在验证过程中发现：Windows 上 `taskkill /T /F` 杀进程树后，cmd.exe 会以 **exit code 1**
退出（不是 `null`），导致原来用 `if (exitCode === null)` 判断超时的逻辑失效——死循环
命令会被误报成"正常非零退出"而非超时。改为用 `timedOut` 布尔标志：

```ts
let timedOut = false;
const timer = timeout > 0
  ? setTimeout(() => { timedOut = true; killTree(); }, timeout)
  : null;
// ...
if (timedOut) {
  return { content: ..., error: `Command timed out after ${timeout}ms`,
           metadata: { exitCode: -1, timedOut: true } };
}
```

### 修复 B（放大器）：并行执行路径响应 abortSignal

**文件：`src/agent-loop.ts`**

并行路径的 `Promise.race(pending.values())` 原来完全不响应 abort——只要有一个工具
promise 永不 settle，`Promise.race` 永远拿不到它，`pending.size` 永不为 0，整批卡死。
加入 abort 竞速：

```ts
let settled: IndexedResult;
if (abortSignal) {
  const abortPromise = new Promise<IndexedResult>((_, reject) => {
    if (abortSignal.aborted) reject(new AbortError("Aborted"));
    else abortSignal.addEventListener("abort",
      () => reject(new AbortError("Aborted")), { once: true });
  });
  try {
    settled = await Promise.race([Promise.race(pending.values()), abortPromise]);
  } catch {
    // Aborted: 为每个仍 pending 的调用 yield aborted 结果后 return
    for (const { call, index } of parallelCalls) { if (pending.has(index)) { ... yield ...; } }
    return;
  }
} else {
  settled = await Promise.race(pending.values());
}
```

新增本地 `AbortError` sentinel class（仅在本文件内抛出/捕获，不外泄）。

### 修复 C（放大器）：BashTool 不应标为并发安全

**文件：`src/tools.ts`**

`isConcurrencySafe: true` → `false`。Bash 命令之间有副作用依赖（写操作互相覆盖），
本就不该并行。改后 bash 全部走串行路径（该路径已正确检查 abort），即便仍卡死也只卡
单个工具，且 Ctrl+C 能生效。

### 修复 E（预防）：危险命令静态拦截补充

**文件：`src/permissions.ts`**

在 `checkDangerousPattern` 里补充易致死命令模式，把"死循环"从执行期提前到权限期，
执行前就拒绝/确认：

- `while(true)` / `while(1)` / `while(!)` —— 无限循环
- `for(;;)` —— 无限循环
- `tail -f` —— 持续 follow
- `watch` —— 循环执行
- `npm/yarn/pnpm run dev|serve|start`、`vite`、`webpack-dev-server`、`next dev`、`ng serve` —— 常驻 dev server
- `ssh` —— 交互式
- 裸 REPL（`python`/`node`/`php`/`irb`/`pry` 直接结尾 或带 `-i`）—— 等待输入

### 配套类型变更

**文件：`src/types.ts`**

- `ToolResultMetadata.exitCode` 从 `number` 改为 `number | null`（`close` 事件 code 可为 null）；
- 新增 `ToolResultMetadata.timedOut?: boolean`。

---

## 四、验证结果

手动复测（修复后的 dist）：

| 场景 | 结果 |
|---|---|
| 正常命令 `echo hello` | `exitCode:0`，正常返回 |
| 死循环 `node -e "while(true){}"` + 1.5s 超时 | **约 2.1s 返回** `timedOut:true`，无孤儿进程（旧代码永久挂起） |
| 死循环 + 60s 超时但 800ms 后 Ctrl+C | **约 1.3s 返回** `aborted:true`（旧代码 Ctrl+C 无效） |
| stderr 捕获 `echo err 1>&2` | 正常捕获 `err` |

```
1 normal:   {"content":"hello","exitCode":0}
2 timeout:  {"elapsed":2101,"exitCode":-1,"timedOut":true,"error":"Command timed out after 1500ms"}
3 abort:    {"elapsed":1363,"exitCode":-1,"aborted":true}
4 stderr:   {"content":"err"}
ALL DONE - no deadlock
```

| 验证项 | 结果 |
|---|---|
| `npm run build`（`tsc`） | 通过，0 错误 |
| `npx vitest run tools/agent-loop/permissions` | **63 / 63 全过** |
| 死循环命令超时返回 | 修复前永久挂起 → 修复后 ~2s 返回超时错误 |
| Ctrl+C 中断生效 | 修复前无效 → 修复后 ~1.3s 返回 aborted |
| 孤儿进程 | 修复后无残留 |

---

## 五、受影响文件

**修改**
- `src/tools.ts`（BashTool 弃用 `execAsync`，改 `spawn` + `taskkill /T /F` / 进程组；`isConcurrencySafe` 改 false；`timedOut` 标志判超时）
- `src/agent-loop.ts`（并行路径加 abort 竞速 + `AbortError` sentinel）
- `src/permissions.ts`（补充易致死命令模式拦截）
- `src/types.ts`（`exitCode: number | null`、新增 `timedOut`）

---

## 六、设计决策记录

1. **杀整棵进程树而非只杀直接子进程** —— `exec` 的 timeout / AbortSignal 只杀直接子进程
   （cmd.exe），孙进程成孤儿占住管道是死锁根因。`taskkill /T /F`（Windows）/ 进程组
   SIGKILL（Unix）是唯一能保证管道关闭、promise settle 的方式。
2. **超时用 `timedOut` 标志而非 `exitCode === null`** —— Windows `taskkill /T /F` 后
   cmd.exe 退出码是 1（实数），不是 null，靠 exitCode 区分会把超时误判成正常失败。
3. **BashTool 改为非并发安全** —— bash 命令有副作用依赖，并行本身就不安全；改走串行
   路径后即便单工具卡死也只影响自身，且串行路径已正确响应 abort。
4. **并行路径加 abort 竞速** —— 即便某个并发安全工具（Read/Glob/Grep）因故永不返回，
   abort 也能打断 `Promise.race`，不再死等。这是对修复 A 的纵深防御。
5. **易致死命令静态拦截** —— 把"死循环"从执行期提前到权限期，模型写出 `while(true)`、
   `npm run dev` 等命令时执行前就确认，从源头减少触发概率。
