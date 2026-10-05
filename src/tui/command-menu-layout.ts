import { padAligned, sanitizeTerminalText, truncateVisual, visualWidth } from "./terminal-width.js";

interface CommandMenuEntry {
  name: string;
  description: string;
}

export function formatCommandMenuRow(
  command: CommandMenuEntry,
  selected: boolean,
  commands: readonly CommandMenuEntry[],
  width: number,
): string {
  // name = skill directory name, description = SKILL.md frontmatter — both
  // project-untrusted, and this row is painted raw via Region on every
  // keystroke while the dropdown is open. Sanitize before layout (control
  // sequences would also corrupt the width math).
  const safeName = sanitizeTerminalText(command.name);
  const safeDescription = sanitizeTerminalText(command.description);
  const longest = commands.reduce(
    (length, entry) => Math.max(length, visualWidth(sanitizeTerminalText(entry.name))),
    0,
  );
  const descriptionColumn = Math.min(Math.max(30, longest + 5), Math.floor(width / 2));
  const nameWidth = Math.max(1, descriptionColumn - 3);
  const name = truncateVisual(`/${safeName}`, nameWidth);
  const description = truncateVisual(safeDescription, Math.max(0, width - descriptionColumn));
  return `${selected ? "❯ " : "  "}${padAligned(name, visualWidth(name), nameWidth)} ${description}`;
}
