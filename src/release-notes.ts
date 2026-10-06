import { marked, type Token } from "marked";

export interface ReleaseNote {
  version: string | null;
  markdown: string;
  usageImpact: string;
}

/** Parse real Markdown headings; headings inside code fences are not releases. */
export function parseReleaseNotes(changelog: string): ReleaseNote[] {
  const entries: ReleaseNote[] = [];
  let tokens: Token[] = [];
  const commit = () => {
    if (tokens.length === 0) return;
    const heading = tokens[0];
    if (heading?.type !== "heading") return;
    let end = tokens.length;
    while (end > 1 && (tokens[end - 1]?.type === "space" || tokens[end - 1]?.type === "hr")) end--;
    const impactIndex = tokens.findIndex(
      (token) =>
        token.type === "heading" &&
        token.depth === 3 &&
        /^(使用影响|usage impact)$/i.test(token.text.trim()),
    );
    let impactEnd = impactIndex + 1;
    while (impactEnd < tokens.length) {
      const token = tokens[impactEnd];
      if (token?.type === "heading" && token.depth <= 3) break;
      impactEnd++;
    }
    entries.push({
      version:
        /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/.exec(
          heading.text,
        )?.[1] ?? null,
      markdown: tokens
        .slice(0, end)
        .map((token) => token.raw)
        .join("")
        .trim(),
      usageImpact:
        impactIndex < 0
          ? ""
          : tokens
              .slice(impactIndex + 1, impactEnd)
              .filter((token) => token.type !== "space" && token.type !== "hr")
              .map((token) => token.raw)
              .join("")
              .trim(),
    });
  };
  for (const token of marked.lexer(changelog)) {
    if (token.type === "heading" && token.depth === 2) {
      commit();
      tokens = [token];
    } else if (tokens.length > 0) tokens.push(token);
  }
  commit();
  return entries;
}

export function releaseForVersion(changelog: string, version: string): ReleaseNote | null {
  const matching = parseReleaseNotes(changelog).filter((entry) => entry.version === version);
  if (matching.length > 1) throw new Error(`Duplicate release notes for v${version}.`);
  return matching[0] ?? null;
}

/** Shared by the build and the command, with no fallback to a different version. */
export function validateCurrentRelease(changelog: string, version: string): ReleaseNote {
  const entry = releaseForVersion(changelog, version);
  if (!entry)
    throw new Error(
      `Missing release notes for installed version v${version}. Add a "## v${version}" entry to docs/CHANGELOG.md.`,
    );
  if (!entry.usageImpact)
    throw new Error(
      `Release notes for v${version} need a non-empty "### 使用影响" (or "### Usage impact") section.`,
    );
  return entry;
}
