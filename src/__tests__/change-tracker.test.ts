// ============================================================
// Tests: change tracker (session file-mutation log)
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordChange,
  listChanges,
  clearChanges,
  resetChangeTracker,
} from "../change-tracker.js";

beforeEach(() => {
  resetChangeTracker();
});

describe("change-tracker", () => {
  it("records a new file as created", () => {
    recordChange("s1", "a.ts", "created", "10 B");
    const list = listChanges("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: "a.ts", kind: "created", edits: 1, detail: "10 B" });
  });

  it("keeps the original kind but bumps edits on repeat", () => {
    recordChange("s1", "a.ts", "created");
    recordChange("s1", "a.ts", "modified", "diff");
    const list = listChanges("s1");
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("created"); // first kind wins
    expect(list[0].edits).toBe(2);
    expect(list[0].detail).toBe("diff"); // latest detail
  });

  it("isolates changes by session", () => {
    recordChange("s1", "a.ts", "modified");
    recordChange("s2", "b.ts", "modified");
    expect(listChanges("s1").map((c) => c.path)).toEqual(["a.ts"]);
    expect(listChanges("s2").map((c) => c.path)).toEqual(["b.ts"]);
  });

  it("sorts most-recently-updated first", async () => {
    recordChange("s1", "old.ts", "modified");
    await new Promise((r) => setTimeout(r, 2));
    recordChange("s1", "new.ts", "modified");
    expect(listChanges("s1")[0].path).toBe("new.ts");
  });

  it("clears a session's changes", () => {
    recordChange("s1", "a.ts", "modified");
    clearChanges("s1");
    expect(listChanges("s1")).toHaveLength(0);
  });

  it("returns empty for an unknown session", () => {
    expect(listChanges("nope")).toEqual([]);
  });
});
