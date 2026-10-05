// ============================================================
// Subagent run store — Resume subsystem (拍板 #19, official 2.1.202 parity)
// ============================================================
// Official gives every sub-agent an agentId, persists its transcript to disk,
// and can RESUME it (orphan agents from crashed sessions are listed by
// /resume; SendMessage(agentId) continues a completed agent's conversation).
// Our equivalent, layered on the #22 sidechain work:
//
//   .claude/sessions/subagents-<sessionId>/<agentId>.json   (atomic tmp+rename)
//
// One record per typed sub-agent RUN (forks excluded — a fork's history is a
// copy of the parent's and must not be persisted twice). The record holds the
// FULL message list (not the capped audit previews) so a resume seeds the
// loop with the exact prior conversation; the identity-based seed filter in
// task.ts then yields only the NEW turns as the report. (Tool results inside
// that list are still clipped in place by the context-pipeline budget, so a
// very long prior run resumes with trimmed tool output — by design.)
//
// Orphan semantics: a record left in "running" state belongs to a dead
// process (we are the only writer of our own records mid-run). listRuns
// reports them as "interrupted", and the next write heals the status on disk.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "./types.js";
import { renameSyncWithRetry } from "./utils/atomic-rename.js";
import { ccrPath } from "./workspace-config.js";

export type SubagentRunStatus = "running" | "completed" | "error" | "interrupted";

export interface SubagentRunRecord {
  agentId: string;
  sessionId: string;
  /** Registered type name at spawn time (validated again on resume). */
  typeName: string;
  description: string;
  /** The ORIGINAL task prompt (a resume carries its own new prompt). */
  prompt: string;
  status: SubagentRunStatus;
  createdAt: string;
  updatedAt: string;
  /** Final report (when finished) or the abort/error note. */
  report?: string;
  /** Full conversation — the resume seed. */
  messages: Message[];
}

let counter = 0;
/** Monotonic suffix so two concurrent saveRun() calls never share a temp file. */
let writeSeq = 0;

/** In-process running runs: "<sessionId>/<agentId>". A resume of a live run is
 * rejected; cross-process orphans heal via listRuns' interrupted mapping. */
const activeRuns = new Set<string>();

export function markRunActive(sessionId: string, agentId: string): void {
  activeRuns.add(`${sessionId}/${agentId}`);
}

/**
 * Atomic check-and-set over the active marker (single-threaded JS: no await
 * inside, so check+add cannot interleave). Both `task` and `Agent` are
 * concurrency-safe tools, so two calls resuming the SAME id in one assistant
 * turn both passed the earlier isRunActive() check before either marked itself;
 * the loser then wrote the record the winner was still updating. The claimant
 * is the only writer and the only one that releases the marker.
 */
export function claimRun(sessionId: string, agentId: string): boolean {
  const key = `${sessionId}/${agentId}`;
  if (activeRuns.has(key)) return false;
  activeRuns.add(key);
  return true;
}

export function unmarkRunActive(sessionId: string, agentId: string): void {
  activeRuns.delete(`${sessionId}/${agentId}`);
}

export function isRunActive(sessionId: string, agentId: string): boolean {
  return activeRuns.has(`${sessionId}/${agentId}`);
}

/** Human-readable unique id per session: <type>-<base36 time>-<seq>.
 *  The type name is sanitized because it becomes a FILE name: plugin-namespaced
 *  agents are registered as "ns:agent" (loadAgentsDir namespace option) and a
 *  colon is an illegal NTFS character — the write then failed with EINVAL,
 *  saveRun swallowed it, and the agentId handed back for `resume` pointed at a
 *  record that was never written. */
export function newAgentId(typeName: string): string {
  counter = (counter + 1) % 46656; // 36^3
  const safe = typeName.replace(/[^\w.-]/g, "_") || "agent";
  return `${safe}-${Date.now().toString(36)}-${counter.toString(36).padStart(3, "0")}`;
}

function runsDirFor(sessionsDir: string, sessionId: string): string {
  // sessionId is a file-name component (sessions/<id>.json convention) —
  // sanitize anyway so a hostile id can't escape the directory.
  const safe = sessionId.replace(/[^\w.-]/g, "_");
  return path.join(sessionsDir, `subagents-${safe}`);
}

function runsDir(workspaceRoot: string, sessionId: string): string {
  return runsDirFor(ccrPath(workspaceRoot, "sessions"), sessionId);
}

function recordPath(workspaceRoot: string, sessionId: string, agentId: string): string {
  // Same allow-list newAgentId() sanitizes the type name against — keeping ':'
  // out means a lookup can never map to a file saveRun could not have written.
  const safe = agentId.replace(/[^\w.-]/g, "_");
  return path.join(runsDir(workspaceRoot, sessionId), `${safe}.json`);
}

/** Create a new run record in "running" state. Never throws. */
export function createRun(
  // Unused today: kept so createRun's signature matches saveRun/claimRun, which
  // both need the workspace root to locate the record file.
  // biome-ignore lint/correctness/noUnusedFunctionParameters: signature parity with saveRun/claimRun
  workspaceRoot: string,
  sessionId: string,
  typeName: string,
  description: string,
  prompt: string,
): SubagentRunRecord {
  const now = new Date().toISOString();
  return {
    agentId: newAgentId(typeName),
    sessionId,
    typeName,
    description,
    prompt,
    status: "running",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Persist (create-or-replace) a run record atomically. Never throws. */
export function saveRun(workspaceRoot: string, run: SubagentRunRecord): void {
  try {
    const file = recordPath(workspaceRoot, run.sessionId, run.agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Per-write temp name: two processes (or two parallel writers in one
    // process) sharing `<file>.tmp` could rename a half-written buffer into
    // place — the record then failed to parse and became unresumable.
    writeSeq = (writeSeq + 1) % 1_000_000;
    const tmp = `${file}.${process.pid}.${writeSeq}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...run, updatedAt: new Date().toISOString() }), "utf-8");
    renameSyncWithRetry(tmp, file);
  } catch {
    // Resume data is best-effort — never break the sub-agent over persistence.
  }
}

/** Load one record, or undefined when absent/corrupt. */
export function loadRun(
  workspaceRoot: string,
  sessionId: string,
  agentId: string,
): SubagentRunRecord | undefined {
  try {
    const raw = fs.readFileSync(recordPath(workspaceRoot, sessionId, agentId), "utf-8");
    const parsed = JSON.parse(raw) as SubagentRunRecord;
    if (!parsed || typeof parsed.agentId !== "string" || !Array.isArray(parsed.messages)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Every stored run of a session, oldest first. Records stuck in "running"
 * belong to a dead process — reported as "interrupted" (orphan resume).
 */
export function listRuns(workspaceRoot: string, sessionId: string): SubagentRunRecord[] {
  try {
    const dir = runsDir(workspaceRoot, sessionId);
    const out: SubagentRunRecord[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, name), "utf-8"),
        ) as SubagentRunRecord;
        if (!parsed || typeof parsed.agentId !== "string") continue;
        out.push(parsed.status === "running" ? { ...parsed, status: "interrupted" } : parsed);
      } catch {
        // Corrupt file — skip.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

/** Delete all run records of a session (used when the session is deleted). */
export function deleteRuns(workspaceRoot: string, sessionId: string): void {
  try {
    fs.rmSync(runsDir(workspaceRoot, sessionId), { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

/** Same, for a caller that already resolved the sessions directory. */
export function deleteRunsInDir(sessionsDir: string, sessionId: string): void {
  try {
    fs.rmSync(runsDirFor(sessionsDir, sessionId), { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}
