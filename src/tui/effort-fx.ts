import chalk, { type ChalkInstance } from "chalk";
import { EFFORT_GRADIENT, type EffortLevel, rainbowColors } from "./effort.js";
import { palette } from "./theme.js";

const ORDER: EffortLevel[] = [...EFFORT_GRADIENT, "ultracode"];
const ULTRA_VIOLET = "#8c50f0";
const SELECTED_VIOLET = "#af87ff";
const SELECTED_COLORS: Partial<Record<EffortLevel, string>> = {
  low: "#ffc107",
  xhigh: SELECTED_VIOLET,
};
const VIOLET_SHADES = [
  "#3e1676",
  "#491e87",
  "#542799",
  "#5f2faa",
  "#6b37bc",
  "#763fcd",
  "#8148df",
  ULTRA_VIOLET,
];

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

function put(cells: Cell[], column: number, text: string, attrs: Partial<Cell> = {}): void {
  for (let index = 0; index < text.length; index++) {
    const target = column + index;
    if (target >= 0 && target < cells.length) cells[target] = { ch: text[index]!, ...attrs };
  }
}

function paint(cell: Cell): string {
  let color: ChalkInstance = chalk;
  if (cell.bg) color = color.bgHex(cell.bg);
  if (cell.fg) color = color.hex(cell.fg);
  if (cell.bold) color = color.bold;
  return color === chalk ? cell.ch : color(cell.ch);
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function buildEffortFrame(opts: {
  active: EffortLevel;
  phase: number;
  cols: number;
  fade?: number;
}): string[] {
  const { active, phase, cols } = opts;
  const fade = clamp(opts.fade ?? 1, 0, 1);
  const isMax = active === "max";
  const isUltra = active === "ultracode";
  const width = Math.max(20, cols - 1);
  const trackWidth = Math.min(62, width - 4);
  const leftPad = Math.floor((width - trackWidth) / 2);
  const scaleColumn = (column: number) => Math.round((column / 61) * (trackWidth - 1));
  const markers = [1, 11, 21, 30, 40].map(scaleColumn);
  const dividerColumn = scaleColumn(43);
  const ultraColumn = scaleColumn(53);
  const activeIndex = EFFORT_GRADIENT.indexOf(active as (typeof EFFORT_GRADIENT)[number]);
  const activeColumn = activeIndex >= 0 ? markers[activeIndex]! : ultraColumn;
  const grid: Cell[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: width }, () => ({ ch: " " })),
  );
  for (let column = 0; column < width; column++) {
    grid[0]![column] = { ch: "─", fg: palette.secondary };
  }
  put(grid[1]!, 2, "Effort", { fg: palette.text, bold: true });
  put(grid[3]!, leftPad, "Faster", { fg: palette.text });
  put(grid[3]!, leftPad + trackWidth - 7, "Smarter", { fg: palette.text });

  for (let column = 0; column < trackWidth; column++) {
    grid[4]![leftPad + column] = {
      ch: column === dividerColumn ? "┆" : "─",
      fg:
        column === dividerColumn
          ? palette.secondary
          : column > dividerColumn
            ? ULTRA_VIOLET
            : palette.secondary,
    };
  }
  put(grid[4]!, leftPad + activeColumn, "▲", { fg: palette.text, bold: true });
  EFFORT_GRADIENT.forEach((level, index) => {
    const start = Math.max(leftPad, leftPad + markers[index]! - Math.floor(level.length / 2));
    const selected = active === level;
    if (selected && isMax) {
      const colors = rainbowColors(6, phase);
      for (let character = 0; character < level.length; character++) {
        put(grid[5]!, start + character, level[character]!, { fg: colors[character]!, bold: true });
      }
    } else if (selected && level === "xhigh") {
      const highlight = (Math.floor(phase) % (level.length + 8)) - 4;
      for (let character = 0; character < level.length; character++) {
        put(grid[5]!, start + character, level[character]!, {
          fg: character === highlight ? "#d0b4e8" : SELECTED_VIOLET,
          bold: true,
        });
      }
    } else {
      put(grid[5]!, start, level, {
        fg: selected
          ? (SELECTED_COLORS[level] ??
            (level === "medium" ? palette.success : palette.commandSelected))
          : palette.secondary,
        bold: selected,
      });
    }
  });
  put(grid[5]!, leftPad + ultraColumn - 4, "ultracode", { fg: ULTRA_VIOLET, bold: isUltra });
  put(grid[6]!, leftPad + ultraColumn - 8, "xhigh + workflows", { fg: palette.secondary });
  put(grid[8]!, 2, "←/→ to adjust · Enter to confirm · Esc to cancel", { fg: palette.secondary });

  if (isMax) {
    const warning: Cell[] = Array.from({ length: width }, () => ({ ch: " " }));
    put(
      warning,
      4,
      "May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.",
      { fg: palette.secondary },
    );
    grid.splice(7, 0, warning);
  }

  if (isUltra) {
    const centerColumn = leftPad + ultraColumn;
    const centerRow = 5;
    const maxDistance = Math.max(
      Math.hypot(centerColumn, (centerRow - 1) * 2.1),
      Math.hypot(width - 1 - centerColumn, (8 - centerRow) * 2.1),
    );
    const radius = 2.5 + (maxDistance - 2.5) * fade;
    for (let rowIndex = 1; rowIndex <= 8; rowIndex++) {
      for (let column = 0; column < width; column++) {
        const pixelColumn = centerColumn + Math.floor((column - centerColumn) / 2) * 2 + 0.5;
        const distance = Math.hypot(pixelColumn - centerColumn, (rowIndex - centerRow) * 2.1);
        if (fade < 1 && distance > radius) continue;
        const wave = (Math.cos(distance * 0.34 - phase * 0.08) + 1) / 2;
        const front = fade < 1 ? Math.max(0, 1 - Math.abs(distance - radius) / 3) : 0;
        const shade = Math.round(clamp(Math.max(wave, front), 0, 1) * (VIOLET_SHADES.length - 1));
        const cell = grid[rowIndex]![column]!;
        grid[rowIndex]![column] = {
          ...cell,
          bg: VIOLET_SHADES[shade]!,
          fg: "#ffffff",
          bold: cell.ch !== " ",
        };
      }
    }
  }
  return grid.map((cells) => cells.map(paint).join(""));
}

export { ORDER };
