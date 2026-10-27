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
import { parseDocument } from "yaml";
export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
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
  const m = text.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text.trim() };
  const document = parseDocument(m[1] ?? "", { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid frontmatter: ${document.errors[0]!.message}`);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const frontmatter =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  // Retain the loader's string scalar convention, while supporting nested hook and MCP config.
  for (const [key, entry] of Object.entries(frontmatter)) {
    // Review fix (§五 "__proto__ 隐患"): assigning into a "__proto__" key
    // mutates the object's PROTOTYPE, not an own property — a SKILL.md with
    // `__proto__: 1` would silently poison lookups on the returned map.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof entry === "boolean" || typeof entry === "number") frontmatter[key] = String(entry);
  }
  return { frontmatter, body: (m[2] ?? "").trim() };
}

export function frontmatterString(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((item) => typeof item === "string").join(", ")
      : undefined;
}
export function frontmatterList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : undefined;
}
