// ============================================================
// Tests: Background Prefetch (M36, kernel §9)
// ============================================================

import { describe, expect, it } from "vitest";
import type { ExtractedMemory } from "../memory-extract.js";
import {
  keywords,
  rankMemories,
  rankSkills,
  renderPrefetchAttachment,
  startPrefetch,
} from "../prefetch.js";
import type { SkillInfo } from "../skills.js";

function mem(text: string): ExtractedMemory {
  return { id: text, ts: "2026-06-30T00:00:00Z", source: "manual", text };
}

const skills: SkillInfo[] = [
  { name: "security-review", description: "Security review of pending changes" },
  { name: "deep-research", description: "Fan out web searches and synthesize a report" },
  { name: "verify", description: "Run the app and observe behavior" },
];

describe("keywords", () => {
  it("lowercases, drops stopwords and short tokens", () => {
    const k = keywords("Please review the Security of my Authentication");
    expect(k.has("security")).toBe(true);
    expect(k.has("authentication")).toBe(true);
    expect(k.has("review")).toBe(true);
    expect(k.has("the")).toBe(false); // stopword
    expect(k.has("my")).toBe(false); // stopword
  });
});

describe("rankMemories", () => {
  const memories = [
    mem("Always use Vitest for tests in this project"),
    mem("The user prefers tabs over spaces"),
    mem("Deploy runs on the security pipeline"),
  ];

  it("ranks by keyword overlap and drops zero-score", () => {
    const ranked = rankMemories("how do I run the security pipeline", memories);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.memory.text).toContain("security pipeline");
    // The tabs memory shares no keywords → excluded.
    expect(ranked.find((r) => r.memory.text.includes("tabs"))).toBeUndefined();
  });

  it("returns [] for an empty query", () => {
    expect(rankMemories("", memories)).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => mem(`security note ${i}`));
    expect(rankMemories("security", many, 2)).toHaveLength(2);
  });
});

describe("rankSkills", () => {
  it("surfaces the most relevant skill by name+description overlap", () => {
    const ranked = rankSkills("please do a security review of this branch", skills);
    expect(ranked[0]!.skill.name).toBe("security-review");
  });

  it("returns [] when nothing overlaps", () => {
    expect(rankSkills("xyzzy plugh", skills)).toEqual([]);
  });
});

describe("renderPrefetchAttachment", () => {
  it("wraps memories and skills in a system-reminder", () => {
    const out = renderPrefetchAttachment({
      memories: [{ memory: mem("Use Vitest"), score: 1 }],
      skills: [{ skill: skills[0]!, score: 2 }],
    });
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("Use Vitest");
    expect(out).toContain("security-review");
  });

  it("returns null when there is nothing to show", () => {
    expect(renderPrefetchAttachment({ memories: [], skills: [] })).toBeNull();
  });
});

describe("startPrefetch", () => {
  it("ranks both sources and degrades to empty on a throwing source", async () => {
    const result = await startPrefetch({
      query: "security review",
      memories: () => {
        throw new Error("disk gone");
      },
      skills: () => skills,
    });
    expect(result.memories).toEqual([]);
    expect(result.skills[0]!.skill.name).toBe("security-review");
  });
});
