// ============================================================
// REPL Tool — persistent node/python evaluation session
// ============================================================
// Mirrors Claude Code's REPL tool: a long-lived interpreter process per
// (session, language) so state (variables, imports) survives across calls.
// Each call sends a JSON request line and reads a marker-delimited JSON
// response line capturing the expression's value AND any console output.
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const MARKER = "__CCR_REPL__";

type ReplLanguage = "node" | "python";

// --- wrapper programs -------------------------------------------------------

// Node wrapper: reads one JSON request per stdin line, evals synchronously,
// captures console.log output, and answers with a marker-prefixed JSON line.
// Each request carries a `seq` that the response echoes back — the caller
// matches responses by seq, NOT by FIFO order, so a late answer to an already
// timed-out request can never be delivered to the NEXT request.
const NODE_WRAPPER = `
const vm = require("vm");
const rl = require("readline").createInterface({ input: process.stdin, terminal: false });
function enc(v) { try { return JSON.stringify(v); } catch { return String(v); } }
// A persistent vm context so let/var/const, functions, and require() results
// survive across calls (eval() scopes let/const to a single call and loses them).
const context = vm.createContext({
  require, Buffer, process, JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Promise, Error,
  setTimeout, setInterval, clearTimeout, clearInterval, console,
});
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const out = [];
  context.console = {
    ...console,
    log: (...a) => out.push(a.map((x) => (typeof x === "string" ? x : enc(x))).join(" ")),
    error: (...a) => out.push(a.map((x) => String(x)).join(" ")),
    warn: (...a) => out.push(a.map((x) => String(x)).join(" ")),
  };
  try {
    const v = vm.runInContext(req.expr, context, { timeout: 10000 });
    const value = v === undefined ? "undefined" : typeof v === "object" ? enc(v) : String(v);
    console.log("${MARKER}" + JSON.stringify({ ok: true, value, output: out.join("\\n"), seq: req.seq }));
  } catch (e) {
    console.log("${MARKER}" + JSON.stringify({ ok: false, error: String((e && e.message) || e), output: out.join("\\n"), seq: req.seq }));
  }
});
`;

// Python wrapper: same protocol. `eval` only — for statements the model can use
// `exec` explicitly inside an expression via `exec("...")`, but the simple eval
// covers the common "evaluate this expression" case.
const PYTHON_WRAPPER = `
import sys, json
def enc(v):
    try: return json.dumps(v)
    except Exception: return str(v)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    try:
        val = eval(req.get("expr", ""))
        value = "None" if val is None else (val if isinstance(val, str) else enc(val))
        print("${MARKER}" + json.dumps({"ok": True, "value": value, "output": "", "seq": req.get("seq")}), flush=True)
    except Exception as e:
        print("${MARKER}" + json.dumps({"ok": False, "error": str(e), "output": "", "seq": req.get("seq")}), flush=True)
`;

interface ReplSession {
  proc: ChildProcess;
  buffer: string;
  /** In-flight requests keyed by seq — FIFO popping was the misalignment bug. */
  pending: Map<number, (res: ReplResponse) => void>;
  nextSeq: number;
  /** Most recent interpreter-level stderr, attached to timeout errors. */
  lastStderr: string;
}

interface ReplResponse {
  ok: boolean;
  value?: string;
  output?: string;
  error?: string;
  seq?: number;
}

const SESSIONS = new Map<string, ReplSession>();

function sessionKey(sessionId: string, language: ReplLanguage): string {
  return `${sessionId}::${language}`;
}

function spawnProcess(language: ReplLanguage): ChildProcess {
  if (language === "node") {
    return spawn(process.execPath, ["-e", NODE_WRAPPER], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  const bin = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  return spawn(bin, ["-u", "-c", PYTHON_WRAPPER], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function getSession(sessionId: string, language: ReplLanguage): ReplSession {
  const key = sessionKey(sessionId, language);
  const session = SESSIONS.get(key);
  if (session) return session;

  const proc = spawnProcess(language);
  const sessionObj: ReplSession = {
    proc,
    buffer: "",
    pending: new Map(),
    nextSeq: 1,
    lastStderr: "",
  };
  // A dead wrapper's stdin emits an async EPIPE 'error' event on write; without
  // a listener that throw escapes as an uncaught exception.
  proc.stdin?.on("error", () => {});
  let stdoutBuf = "";
  proc.stdout?.setEncoding("utf-8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    while (true) {
      const idx = stdoutBuf.indexOf(MARKER);
      if (idx === -1) break;
      // Skip the marker, then find the JSON object (the response line).
      const rest = stdoutBuf.slice(idx + MARKER.length);
      // The JSON object may not be fully buffered yet; wait for a full line.
      const nl = rest.indexOf("\n");
      if (nl === -1) {
        stdoutBuf = MARKER + rest;
        break;
      }
      const jsonStr = rest.slice(0, nl).trim();
      stdoutBuf = rest.slice(nl + 1);
      let parsed: ReplResponse;
      try {
        parsed = JSON.parse(jsonStr) as ReplResponse;
      } catch {
        parsed = { ok: false, error: `Bad REPL response: ${jsonStr}` };
      }
      // Match by seq, never by order: a response whose request already timed
      // out (or arrived after a restart) has no pending entry and is dropped,
      // so it can never be delivered to a later request (the old FIFO shift
      // misaligned the whole session after a single timeout).
      const seq = parsed.seq;
      if (typeof seq !== "number") continue;
      const pending = sessionObj.pending.get(seq);
      if (pending) {
        sessionObj.pending.delete(seq);
        pending(parsed);
      }
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    // Interpreter-level stderr (startup errors, warnings) is NOT matched to a
    // request — the wrapper reports eval errors over stdout with a seq. Pop a
    // pending request here used to misalign every response that followed.
    sessionObj.lastStderr = d.toString().trim();
  });
  proc.on("exit", () => {
    // Process died — reject anything in flight and drop the session. Guard the
    // delete so a stale exit (e.g. the old process killed by a restart) can't
    // evict a NEWER session that re-registered under the same key.
    for (const p of [...sessionObj.pending.values()]) {
      p({ ok: false, error: `${language} REPL process exited` });
    }
    sessionObj.pending.clear();
    if (SESSIONS.get(key) === sessionObj) SESSIONS.delete(key);
  });

  SESSIONS.set(key, sessionObj);
  return sessionObj;
}

function evaluate(session: ReplSession, expr: string): Promise<ReplResponse> {
  return new Promise((resolve, reject) => {
    const seq = session.nextSeq++;
    const timer = setTimeout(() => {
      // Remove our resolver so the (possible) late response is dropped by the
      // seq check instead of being handed to the NEXT request.
      session.pending.delete(seq);
      const stderrNote = session.lastStderr ? ` (stderr: ${session.lastStderr})` : "";
      reject(new Error(`REPL evaluation timed out${stderrNote}`));
    }, 20_000);
    session.pending.set(seq, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    try {
      session.proc.stdin?.write(JSON.stringify({ seq, expr }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      session.pending.delete(seq);
      reject(e as Error);
    }
  });
}

/** Test/util: tear down all live REPL sessions. */
export function disposeAllReplSessions(): void {
  for (const [key, session] of SESSIONS) {
    session.proc.kill();
    SESSIONS.delete(key);
  }
}

const ReplSchema = z.strictObject({
  language: z.enum(["node", "python"]).optional().describe("Interpreter: node (default) or python"),
  expression: z.string().describe("Expression to evaluate in the persistent session"),
  restart: z
    .boolean()
    .optional()
    .describe("Reset the session state before evaluating (default false)"),
});

export const ReplTool: Tool = buildTool({
  name: "repl",
  description: "Evaluate an expression in a persistent node/python session",
  promptDescription:
    "Evaluate an expression in a long-lived node (default) or python REPL session. " +
    "State — variables, imports — persists across calls, so you can build up " +
    "context incrementally. expression is evaluated synchronously (no top-level " +
    "await); the result value and any console.log/print output are returned. " +
    "restart=true resets the session first.",
  schema: ReplSchema,
  isReadOnly: false, // can run arbitrary code — routes through approval
  isConcurrencySafe: false, // shared session state must serialize
  searchHint: "repl evaluate expression interpreter node python compute",

  async call(input, context): Promise<ToolResult> {
    const language: ReplLanguage = input.language ?? "node";
    const key = sessionKey(context.sessionId, language);
    if (input.restart) {
      const existing = SESSIONS.get(key);
      if (existing) {
        existing.proc.kill();
        SESSIONS.delete(key);
      }
    }

    let session: ReplSession;
    try {
      session = getSession(context.sessionId, language);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: "", error: `Failed to start ${language} REPL: ${message}` };
    }

    try {
      const res = await evaluate(session, input.expression);
      if (!res.ok) {
        return {
          content: res.output || "",
          error: res.error ?? `${language} evaluation failed`,
        };
      }
      const parts: string[] = [];
      if (res.output) parts.push(res.output);
      if (res.value !== undefined && res.value !== "") parts.push(`=> ${res.value}`);
      return { content: parts.join("\n") || "(no output)" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: "", error: `REPL error: ${message}` };
    }
  },
});
