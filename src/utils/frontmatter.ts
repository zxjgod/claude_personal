// ============================================================
// Shared frontmatter parser — skills / commands / agents
// ============================================================
// Skills, custom slash commands, and custom sub-agents all ship as a
// directory of `<name>.md` files with a leading YAML-ish frontmatter block.
// This is the one canonical parser for that shape, so the three loaders
// (skills/loadSkillsDir, commands/loadCommandsDir, agents/loadAgentsDir)
// agree on exactly how a file is split and how lists / quotes are handled.
// ============================================================

/** A parsed `<name>.md` file: frontmatter keys + the (trimmed) body. */
export interface ParsedFrontmatter {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

/**
 * Minimal YAML-ish frontmatter parser: a leading `---` block of `key: value`
 * lines (values may be `[a, b]` lists, and may be single/double quoted).
 * Intentionally tiny — covers the config surface shared by skills / commands /
 * agents, not full YAML. Returns empty frontmatter when no block is present.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text.trim() };
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: (m[2] ?? "").trim() };
}
