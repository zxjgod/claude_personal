# Bash 工具执行死循环 / 转圈卡死问题分析

> 现象：在本地工作空间执行 `bash` 指令时，有概率进入死循环，此时 AI 回复一直转圈，
> 无法继续响应，Ctrl+C 也常常无效，只能强制关闭终端。

---

## 一、结论先行

根因是 **Windows 下 `child_process.exec` 的超时杀进程机制只杀“直接子进程”，
不杀“孙进程”**，结合本项目的工具执行与 UI 状态机设计，导致 promise 永久挂起。

具体由两条缺陷叠加放大：

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | `exec` 超时只 `SIGTERM` 直接子进程（cmd.exe），孙进程（真实命令）成孤儿并占住管道 | `src/tools.ts` BashTool `execAsync` | `tool.call()` 的 promise **永不 resolve**，agent loop 卡死 |
| 2 | BashTool 标记为 `isConcurrencySafe: true`，走并行路径；并行路径不响应 abort | `src/tools.ts:635` + `src/agent-loop.ts:292` | 一个永不返回的工具拖死整批并行工具，且 Ctrl+C 无效 |

---

## 二、调用链与卡死点

```
用户提交 ─> agentLoop() ─> executeToolCalls()
                              │
                 ┌────────────┴────────────┐
                 │ 并行路径(parallelCalls)  │  BashTool 在此！
                 │ Promise.race(...)       │
                 │   └ executeSingleTool() │
                 │        └ tool.call()    │
                 │           └ execAsync() │  ★ 永久 await
                 └─────────────────────────┘
                              │
            for await (event of loop)  ← 卡在这里，永远拿不到 tool_result
                              │
              store.setBusy(true) 永远不被置回 false
                              │
                    UI 一直转圈 ✶ Thinking…
```

### 关键代码

BashTool 执行体（`src/tools.ts:637-678`）：

```ts
async call(input, context): Promise<ToolResult> {
  const timeout = input.timeout ?? 120_000;
  try {
    const { stdout, stderr } = await execAsync(input.command, {
      cwd: context.workspaceRoot,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
    });
    ...
```

并行执行（`src/agent-loop.ts:292-307`）：

```ts
if (parallelCalls.length > 0) {
  const pending = new Map<number, Promise<IndexedResult>>();
  for (const { call, index } of parallelCalls) {
    pending.set(index, executeSingleTool(...).then(result => ({ index, result })));
  }
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());  // ← 永远不返回
    pending.delete(settled.index);
    yield settled;
  }
}
```

> 注意：`abortSignal` 在并行路径里**完全没有检查**（只在串行路径 `src/agent-loop.ts:311` 检查），
> 所以即便用户按 Ctrl+C 触发 `controller.abort()`，并行分支里的 `execAsync` 也照常挂起。

---

## 三、根因一：`exec` 超时不能杀孙进程（Windows 特有）

### 机制

Windows 上 `exec(cmd, { shell: 'cmd.exe' })` 实际进程树是：

```
主进程(本项目)
  └─ cmd.exe          ← exec 直接 spawn 的“子进程”
       └─ node.exe    ← cmd.exe 启动的“孙进程”（真正执行 while(true)）
```

`exec` 的 `timeout` 到期时，Node 只对**直接子进程 cmd.exe** 调用 `kill()`（发 `SIGTERM`）。
cmd.exe 被杀后，它启动的 **孙进程 node.exe 成为孤儿继续运行**，并且：

1. 孙进程仍持有 `exec` 管道（stdout/stderr）的写端；
2. 孙进程是无限循环，永不退出，永不关闭管道；
3. `execAsync` 的 promise 要等**管道彻底关闭 + 子进程 exit 事件**才 resolve/reject；
4. 结果：promise **永久 pending**。

### 实验复现（已在本机验证）

实验脚本：用 `execAsync` 跑 `node -e "while(true){}"`，设 1.5s 超时。

观察：

```
cmd parent exited after 1529 ms, code null sig SIGTERM   ← cmd.exe 1.5s 就死了
check exitCode: null signal: undefined pid: 216332       ← 主进程以为结束了
parent gone                                              ← 3s 后 cmd.exe 确实没了
```

但随后 `wmic process where "commandline like '%while(true)%'"` 列出**仍有多个孤儿 node 存活**：

```
ProcessId
215400
218736
216008
181756
... (最多一次列出 11 个孤儿)
```

并且整个 `execAsync(...)` 的 `.catch()` 回调**迟迟不触发**（要等到管道被 GC 或进程被外部杀掉），
期间主进程的 `await` 一直挂起——这就是 UI 转圈的直接来源。

> 对照实验：直接 `exec('node -e "while(true){}"')`（不经 cmd.exe，node 就是直接子进程），
> 超时后 `exit` 事件 1.5s 准时触发，promise 立即 reject。**只要不经过 cmd.exe 这一层
> shell 转发，就不会卡。** 这反证了“孙进程孤儿”是根因。

### 触发概率的来源

“有概率”死循环的几种实际命令形态：

1. **真正死循环命令**：模型偶尔写出 `while(true){}`、`for(;;)`、`watch`、`tail -f`、
   `npm run dev`（常驻服务）等永不退出的命令。
2. **交互式命令等待输入**：如 `npm install` 弹交互提示、`ssh`、`git` 需要密码、
   `python` 进入 REPL——这些命令不会自己结束，也无 stdin 可喂，等同于挂起。
3. **命令本身不卡，但被 cmd.exe 包了一层**：例如 `cmd /c "node script.js"`，
   即便 script 正常退出，路径中任何一处异常都可能让 cmd 不返回。
4. **超长输出 + 缓冲**：`maxBuffer` 触发时 `execAsync` 会 reject（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`），
   但若输出是细水长流式的（如 `setInterval` 持续 write），管道不关闭，reject 也会被推迟。

> 注意：`execSync` 路径（如 `git-context.ts` 用的 `execFile`）超时是同步阻塞主进程，
> 不会有“孙进程孤儿”问题，但会**阻塞事件循环**——那是另一类卡顿，不是本次死循环主因。

---

## 四、根因二：并行执行 + 不响应 abort 放大了故障

### 4.1 BashTool 被标为并发安全

`src/tools.ts:635`：

```ts
export const BashTool: Tool = createTool<BashInput>({
  ...
  isConcurrencySafe: true,   // ← 走并行执行路径
```

Bash 显然**不是**并发安全的（写操作之间有依赖、会互相覆盖），但被标成了 `true`。
这意味着当模型一轮里发起多个 bash 调用时，它们会进入 `parallelCalls`，用 `Promise.race` 收集。

### 4.2 并行路径里只要有一个永不返回，整批全卡

`src/agent-loop.ts:302-306`：

```ts
while (pending.size > 0) {
  const settled = await Promise.race(pending.values());  // 任意一个 pending 永不 settle → 死等
  pending.delete(settled.index);
  yield settled;
}
```

只要这一批里有一个 bash 命令触发了根因一（孙进程孤儿），`Promise.race` 永远拿不到它，
`pending.size` 永不为 0，**整批工具结果全部无法上报**，agent loop 卡在 STEP 5。

### 4.3 并行路径不检查 abortSignal，Ctrl+C 失效

`abortSignal` 的检查只在两处：

- `src/agent-loop.ts:67`：循环顶部（每轮一次）；
- `src/agent-loop.ts:311`：**串行路径**的每个工具前。

并行路径（`292-307`）**完全没有 abort 检查**。于是：

- 用户按 Ctrl+C → `controller.abort("用户中断")`；
- 但 `execAsync` 内部不感知这个 signal，照常挂起；
- `Promise.race` 仍在等那个永不 settle 的 promise；
- **agent loop 无法前进到下一轮去读取 `abortSignal.aborted`**。

结果：Ctrl+C 按了没反应，UI 继续转圈，最终只能强杀终端。这与现象描述完全吻合。

---

## 五、为什么 UI 表现为“一直转圈”

UI（TUI 与 CLI 两条路径都如此）在提交后立即 `setBusy(true)` / 启动 spinner：

- TUI：`src/tui/run.tsx` `store.setBusy(true)` 后由 `App.tsx` 渲染工作状态行（M23 后为 `StatusLine`/`SpinnerGlyph`；早期为 `ParticleSpinner`）；
- CLI：`src/cli.ts:594` `spinner.setMode("thinking"); spinner.start()`。

`busy`/spinner 只在 agent loop 的 `done`/`error`/`aborted` 事件里被置回（`run.tsx:154-158`
的 `finally`）。而 agent loop 卡在 STEP 5 等工具结果，**永远不产生这些事件**，
所以 `finally` 永远不执行，spinner 永远转。

---

## 六、修复建议

按优先级排列：

### 修复 A（必做）：让 exec 超时真正杀死整棵进程树

Windows 上 `exec` 的 `timeout` 杀不掉孙进程，必须自己接管。推荐改用 `spawn` 并显式管理：

```ts
import { spawn } from "node:child_process";

async call(input, context): Promise<ToolResult> {
  const timeout = input.timeout ?? 120_000;
  const child = spawn(input.command, [], {
    cwd: context.workspaceRoot,
    shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
    windowsHide: true,
  });

  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });

  // 关键：超时后杀整棵树
  const timer = setTimeout(() => {
    if (process.platform === "win32") {
      // /T 连同子树一起杀；taskkill 比 child.kill() 可靠得多
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid!, "SIGKILL"); // 进程组（需 detached:true）
    }
  }, timeout);

  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ content: (stdout + (stderr ? "\n" + stderr : "")) || "(no output)",
                metadata: { exitCode: code ?? 0 } });
    });
  });
}
```

要点：
- **`taskkill /T /F`**（Windows）才能杀掉 cmd.exe 之下的孙进程；
- Linux/mac 用**进程组**杀（`spawn(..., { detached: true })` + `process.kill(-pid)`）；
- 这样超时后管道会被真正关闭，promise 一定能 settle。

### 修复 B（必做）：并行路径响应 abortSignal

在 `src/agent-loop.ts` 并行执行段加入 abort 检查与可中断等待：

```ts
while (pending.size > 0) {
  if (abortSignal?.aborted) {
    // 取消剩余：直接 yield aborted 占位结果，避免死等
    for (const idx of pending.keys()) {
      yield { index: idx, result: { toolName: "...", error: "Aborted",
              formatted: "Aborted" } };
    }
    return;
  }
  const settled = await Promise.race([
    Promise.race(pending.values()),
    new Promise<never>((_, rej) => abortSignal?.addEventListener("abort", () => rej())),
  ]);
  pending.delete(settled.index);
  yield settled;
}
```

### 修复 C（建议）：BashTool 不应标为 isConcurrencySafe

`src/tools.ts:635` 改为 `isConcurrencySafe: false`。Bash 命令彼此有副作用依赖，
本就不该并行；改后 bash 全部走串行路径（该路径已正确检查 abort），即便仍卡死也只卡
单个工具，且 Ctrl+C 能生效。

### 修复 D（建议）：exec 同样要响应 AbortSignal

把 `abortSignal` 传入 BashTool，与上面的超时 timer 合并：abort 触发时同样 `taskkill /T /F`，
保证用户中断能立即让 promise settle。

### 修复 E（建议）：危险命令静态拦截补充

在 `permissions.ts checkDangerousPattern` 里补几条容易致死的模式，
在执行前就拒绝/确认：`while(true)`、`for(;;)`、`tail -f`、`watch`、`npm run`/`dev`/`serve`
等常驻命令。这能把“死循环”从执行期提前到权限期。

---

## 七、验证方法

1. 设一个小 timeout（如 2s），让模型执行 `node -e "while(true){}"`；
2. 修复前：约 2s 后 UI 仍转圈，`wmic` 可见孤儿 node，Ctrl+C 无效；
3. 修复 A+B+C 后：约 2s 后返回超时错误，无孤儿进程，Ctrl+C 立即返回提示符。

---

## 八、附：相关文件索引

| 文件 | 行 | 作用 |
|------|----|----|
| `src/tools.ts` | 608-691 | BashTool 定义，`execAsync` 卡死点 |
| `src/tools.ts` | 635 | `isConcurrencySafe: true`（应改 false） |
| `src/tools.ts` | 791-814 | GrepTool 同样用 `execAsync`（rg 缺失走 fallback，风险较低） |
| `src/agent-loop.ts` | 267-325 | `executeToolCalls`，并行/串行分流 |
| `src/agent-loop.ts` | 292-307 | 并行路径 `Promise.race`，无 abort 检查 |
| `src/agent-loop.ts` | 311-321 | 串行路径 abort 检查（正确） |
| `src/cli.ts` | 519-580 | 每轮 AbortController 装配 |
| `src/tui/run.tsx` | 52-159 | TUI 每轮编排，`setBusy(true/false)` |
| `src/tui/App.tsx` | 96-107 | spinner 渲染条件 |
| `src/permissions.ts` | 38-89 | 危险命令检测（建议补充） |
| `src/git-context.ts` | 36-51 | `execFile` 用法（正确带 windowsHide + timeout，可参考） |
