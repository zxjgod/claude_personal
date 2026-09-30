import { padAligned, truncateVisual, visualWidth } from "./terminal-width.js";

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
  const longest = commands.reduce((length, entry) => Math.max(length, visualWidth(entry.name)), 0);
  const descriptionColumn = Math.min(Math.max(30, longest + 5), Math.floor(width / 2));
  const nameWidth = Math.max(1, descriptionColumn - 3);
  const name = truncateVisual(`/${command.name}`, nameWidth);
  const description = truncateVisual(command.description, Math.max(0, width - descriptionColumn));
  return `${selected ? "❯ " : "  "}${padAligned(name, visualWidth(name), nameWidth)} ${description}`;
}
