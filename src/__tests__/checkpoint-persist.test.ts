// ============================================================
// Tests: checkpoint disk persistence (Top10 follow-up C8)
// ============================================================
// Checkpoints used to be pure memory: kill the CLI and every shadow/boundary
// was gone — /rewind after a restart could only rewind the conversation, not
// the files. Now the bucket mirrors to .claude/checkpoints/<bucket>/ (content-
// addressed blobs + state.json index) and hydrates lazily on first access.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearCheckpointMemoryForTests,
  beginUserTurn,
  listTurns,
  resetCheckpoints,
  restoreToTurn,
  setCheckpointWorkspaceRootResolver,
  shadowBeforeWrite,
} from "../checkpoint.js";
import { createResumeSession } from "../cli-session.js";
import { rewindCommand } from "../commands/rewind.js";
import { PersistenceManager } from "../persistence.js";
import type { Message } from "../types.js";

let root: string;

function bucketDir(session: string): string {
  return path.join(root, ".claude", "checkpoints", session);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-ckpt-"));
  vi.stubEnv("WORKSPACE_ROOT", root);
});
afterEach(() => {
  setCheckpointWorkspaceRootResolver(undefined);
  __clearCheckpointMemoryForTests();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkpoint persistence (C8)", () => {
  it("uses the host application's live workspace root", () => {
    const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-ckpt-live-"));
    try {
      setCheckpointWorkspaceRootResolver(() => liveRoot);
      beginUserTurn("sess-live");
      const file = path.join(liveRoot, "live.txt");
      shadowBeforeWrite("sess-live", file);
      expect(
        fs.existsSync(path.join(liveRoot, ".claude", "checkpoints", "sess-live", "state.json")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, ".claude", "checkpoints", "sess-live", "state.json")),
      ).toBe(false);
    } finally {
      fs.rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it("rewinds files across a simulated process restart", () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "original");

    const t1 = beginUserTurn("sess-p");
    shadowBeforeWrite("sess-p", file);
    fs.writeFileSync(file, "turn1 edit");

    const t2 = beginUserTurn("sess-p");
    shadowBeforeWrite("sess-p", file);
    fs.writeFileSync(file, "turn2 edit");

    // Artifacts landed on disk: index + content blobs.
    expect(fs.existsSync(path.join(bucketDir("sess-p"), "state.json"))).toBe(true);
    expect(fs.readdirSync(path.join(bucketDir("sess-p"), "blobs")).length).toBeGreaterThanOrEqual(
      2,
    );

    // Restart #1: memory wiped, rewind to the turn-2 boundary → turn1 content.
    __clearCheckpointMemoryForTests();
    expect(listTurns("sess-p").map((t) => t.turn)).toEqual([t1, t2]);
    const r2 = restoreToTurn("sess-p", t2);
    expect(r2.restored).toContain(file);
    expect(fs.readFileSync(file, "utf-8")).toBe("turn1 edit");

    // Restart #2: deeper rewind → pre-session original.
    __clearCheckpointMemoryForTests();
    restoreToTurn("sess-p", t1);
    expect(fs.readFileSync(file, "utf-8")).toBe("original");
  });
  it("keeps old blobs reachable when the tool workspace changes and old turns leave memory", () => {
    const secondRoot = path.join(root, "second");
    fs.mkdirSync(secondRoot);
    let liveRoot = root;
    setCheckpointWorkspaceRootResolver(() => liveRoot);
    const file = path.join(root, "move.txt");
    fs.writeFileSync(file, "original");
    beginUserTurn("sess-move");
    shadowBeforeWrite("sess-move", file);
    fs.writeFileSync(file, "first edit");
    const target = beginUserTurn("sess-move");
    for (let i = 0; i < 102; i++) {
      fs.writeFileSync(file, "later edit");
      beginUserTurn("sess-move");
    }
    liveRoot = secondRoot;
    beginUserTurn("sess-move");
    const result = restoreToTurn("sess-move", target);
    expect(result.failures).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("first edit");
  });
  it("restores files through /resume followed by /rewind after restarting", async () => {
    const file = path.join(root, "resumed.txt");
    fs.writeFileSync(file, "original");
    const msg: Message = { role: "user", content: [{ type: "text", text: "edit this file" }] };
    const sid = "sess-resume-rewind";
    beginUserTurn(sid, msg);
    shadowBeforeWrite(sid, file);
    fs.writeFileSync(file, "edited");
    const persistence = new PersistenceManager(root);
    await persistence.save(sid, [msg]);
    __clearCheckpointMemoryForTests();
    const messages: Message[] = [];
    const session = { id: "other" };
    expect(await createResumeSession({ persistence, messages, session })(sid)).toBe(true);
    await rewindCommand.run("", {
      workspaceRoot: root,
      sessionId: session.id,
      messages,
      persistence,
      modelConfig: { provider: "custom", model: "test", apiKey: "unused" },
      callModel: async function* () {},
    });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(messages).toEqual([]);
  });

  it("deletes session-created files on rewind across a restart", () => {
    const file = path.join(root, "new.txt");
    const t1 = beginUserTurn("sess-n");
    shadowBeforeWrite("sess-n", file); // didn't exist → null shadow
    fs.writeFileSync(file, "created");

    __clearCheckpointMemoryForTests();
    const r = restoreToTurn("sess-n", t1);
    expect(fs.existsSync(file)).toBe(false);
    expect(r.deleted).toContain(file);
  });

  it("content-addresses identical contents into a single blob", () => {
    const f1 = path.join(root, "x.txt");
    const f2 = path.join(root, "y.txt");
    fs.writeFileSync(f1, "same-content");
    fs.writeFileSync(f2, "same-content");
    beginUserTurn("sess-d");
    shadowBeforeWrite("sess-d", f1);
    shadowBeforeWrite("sess-d", f2);
    const blobs = fs.readdirSync(path.join(bucketDir("sess-d"), "blobs"));
    expect(blobs).toHaveLength(1);
  });

  it("a rewind prunes rewound-away turns from disk too", () => {
    const file = path.join(root, "p.txt");
    fs.writeFileSync(file, "v0");
    const t1 = beginUserTurn("sess-prune");
    shadowBeforeWrite("sess-prune", file);
    fs.writeFileSync(file, "v1");
    const t2 = beginUserTurn("sess-prune");
    shadowBeforeWrite("sess-prune", file);
    fs.writeFileSync(file, "v2");

    restoreToTurn("sess-prune", t2);
    const state = JSON.parse(
      fs.readFileSync(path.join(bucketDir("sess-prune"), "state.json"), "utf-8"),
    );
    // Turn t2 (>= target) is gone from the index; t1 survives. The counter
    // rolled back to target-1 so the next boundary REUSES t2.
    expect(state.turns[String(t2)]).toBeUndefined();
    expect(state.turns[String(t1)]).toBeDefined();
    expect(state.currentTurn).toBe(t2 - 1);
  });

  it("resetCheckpoints removes the on-disk bucket", () => {
    const file = path.join(root, "r.txt");
    fs.writeFileSync(file, "x");
    beginUserTurn("sess-r");
    shadowBeforeWrite("sess-r", file);
    expect(fs.existsSync(bucketDir("sess-r"))).toBe(true);
    resetCheckpoints("sess-r");
    expect(fs.existsSync(bucketDir("sess-r"))).toBe(false);
  });

  it("a rewind leaves no orphan blobs behind (#R7①)", () => {
    const file = path.join(root, "gc.txt");
    fs.writeFileSync(file, "v0");
    const t1 = beginUserTurn("sess-gc");
    shadowBeforeWrite("sess-gc", file);
    fs.writeFileSync(file, "v1");
    const t2 = beginUserTurn("sess-gc"); // snapshot: v1 → its own blob
    shadowBeforeWrite("sess-gc", file);
    fs.writeFileSync(file, "v2");
    const blobsDir = path.join(bucketDir("sess-gc"), "blobs");
    expect(fs.readdirSync(blobsDir).length).toBeGreaterThanOrEqual(2);

    restoreToTurn("sess-gc", t2); // prunes turn t2 from the index

    // Every surviving blob must be reachable from the pruned state.json —
    // before GC the pruned turn's blob leaked on disk forever.
    const state = JSON.parse(
      fs.readFileSync(path.join(bucketDir("sess-gc"), "state.json"), "utf-8"),
    );
    const reachable = new Set<string>();
    for (const o of Object.values<any>(state.originals ?? {})) if (o.blob) reachable.add(o.blob);
    for (const t of Object.values<any>(state.turns ?? {})) {
      for (const b of Object.values(t.files as Record<string, string | null>)) {
        if (b) reachable.add(b);
      }
    }
    for (const name of fs.readdirSync(blobsDir)) {
      expect(reachable.has(name), `orphan blob ${name}`).toBe(true);
    }
    expect(fs.readFileSync(file, "utf-8")).toBe("v1"); // restore still correct
    expect(t1).toBeLessThan(t2);
  });

  it("GC skips entirely when the on-disk index is unreadable (fourth round)", () => {
    const file = path.join(root, "idx.txt");
    fs.writeFileSync(file, "v0");
    beginUserTurn("sess-idx");
    shadowBeforeWrite("sess-idx", file); // original blob written + state.json
    fs.writeFileSync(file, "v1");
    const blobsDir = path.join(bucketDir("sess-idx"), "blobs");
    const before = fs.readdirSync(blobsDir);
    expect(before.length).toBeGreaterThanOrEqual(1);
    // Simulate the real failure mode: the state.json rewrite fails AND the
    // previous index is unreadable. Replacing the file with a DIRECTORY does
    // both without mocks: readFileSync → EISDIR, and the persist rename
    // onto it fails (swallowed best-effort). The old GC treated the
    // unreadable index as an EMPTY reachable set and deleted every blob,
    // destroying all remaining rewind depth; the conservative rule is "no
    // readable index → no GC".
    fs.rmSync(path.join(bucketDir("sess-idx"), "state.json"));
    fs.mkdirSync(path.join(bucketDir("sess-idx"), "state.json"));
    restoreToTurn("sess-idx", 1);
    expect(fs.readdirSync(blobsDir).sort()).toEqual(before.slice().sort());
  });

  it("a lost blob never turns into a file deletion on rewind (#R7③)", () => {
    const file = path.join(root, "precious.txt");
    fs.writeFileSync(file, "orig");
    const t1 = beginUserTurn("sess-lost");
    shadowBeforeWrite("sess-lost", file);
    fs.writeFileSync(file, "edited");
    expect(fs.readdirSync(path.join(bucketDir("sess-lost"), "blobs")).length).toBe(1);

    // Simulate partial disk loss: index survives, the blob file vanishes.
    __clearCheckpointMemoryForTests();
    for (const b of fs.readdirSync(path.join(bucketDir("sess-lost"), "blobs"))) {
      fs.rmSync(path.join(bucketDir("sess-lost"), "blobs", b));
    }

    const r = restoreToTurn("sess-lost", t1);
    // The old conflation (readBlob failure → null → "didn't exist") DELETED
    // the file here. Now the unresolvable path is skipped entirely.
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("edited");
    expect(r.deleted).not.toContain(file);
    expect(r.restored).not.toContain(file);
    expect(r.failures).toHaveLength(1);
  });

  it("memory-capacity pruning keeps turns listed and rewound-able from disk (#R7②)", () => {
    const file = path.join(root, "many.txt");
    fs.writeFileSync(file, "seed");
    const first = beginUserTurn("sess-many");
    let last = first;
    for (let i = 0; i < 105; i++) {
      shadowBeforeWrite("sess-many", file);
      fs.writeFileSync(file, `v${i}`);
      last = beginUserTurn("sess-many");
    }
    // Past the 100-snapshot memory cap, turn 1's SNAPSHOT left memory — but
    // its timestamp stays (listTurns complete, matching post-restart
    // hydration) and its content is on disk.
    const turns = listTurns("sess-many").map((t) => t.turn);
    expect(turns).toContain(first);
    expect(turns).toContain(last);
    // And the disk copy still restores: rewind to the turn-2 boundary =
    // the world when message 2 was sent = after turn 1's write ("v0"). That
    // snapshot left memory at the cap; only the disk mirror can serve it.
    const r = restoreToTurn("sess-many", first + 1);
    expect(r.restored).toContain(file);
    expect(fs.readFileSync(file, "utf-8")).toBe("v0");
  }, 30_000);
});
