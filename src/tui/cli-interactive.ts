// ============================================================
// CLI Interactive — raw-mode input box, "/" autocomplete, menus
// ============================================================
// The TTY-only counterpart to cli-input.ts. Draws a bordered input box with
// a "> " prompt, a slash-command autocomplete dropdown, and a bordered
// Yes/No permission menu — all redrawn in place via ANSI cursor control.
//
// Non-TTY input still flows through createCliInputReader (cli-input.ts); this
// module is only wired in when process.stdin.isTTY is true.
//
// Layout mirrors the real Claude Code screenshots in
// `claude code终端操作界面/`.
// ============================================================

import chalk from "chalk";
import { terminalColumns, visualWidth } from "./terminal-width.js";

const CLAUDE_ORANGE = chalk.rgb(215, 119, 87);

export interface CommandInfo {
  name: string;
  description: string;
}

export interface RawInputReader {
  readInput(): Promise<string | null>;
  askQuestion(prompt: string): Promise<string | null>;
  isClosed(): boolean;
  close(): void;
}

// --- Key parsing ---

interface Key {
  name: string;
  ctrl: boolean;
  sequence: string;
}

function parseKey(data: Buffer): Key {
  const seq = data.toString("utf8");
  // Control characters.
  if (seq === "\r" || seq === "\n") return { name: "enter", ctrl: false, sequence: seq };
  if (seq === "\x7f" || seq === "\b") return { name: "backspace", ctrl: false, sequence: seq };
  if (seq === "\t") return { name: "tab", ctrl: false, sequence: seq };
  if (seq === "\x03") return { name: "c", ctrl: true, sequence: seq };
  if (seq === "\x04") return { name: "d", ctrl: true, sequence: seq };
  if (seq === "\x1b") return { name: "escape", ctrl: false, sequence: seq };
  // Arrow keys / escape sequences.
  if (seq === "\x1b[A" || seq === "\x1bOA") return { name: "up", ctrl: false, sequence: seq };
  if (seq === "\x1b[B" || seq === "\x1bOB") return { name: "down", ctrl: false, sequence: seq };
  if (seq === "\x1b[C" || seq === "\x1bOC") return { name: "right", ctrl: false, sequence: seq };
  if (seq === "\x1b[D" || seq === "\x1bOD") return { name: "left", ctrl: false, sequence: seq };
  if (seq === "\x1b[3~") return { name: "delete", ctrl: false, sequence: seq };
  return { name: "char", ctrl: false, sequence: seq };
}

// --- A small in-place repainting region ---

class Region {
  private lineCount = 0;

  constructor(private out: NodeJS.WriteStream) {}

  /** Clear what we drew and paint `lines`. Cursor ends at the region's end. */
  paint(lines: string[]): void {
    this.clear();
    this.out.write(lines.join("\n"));
    this.lineCount = lines.length;
  }

  /** Move the cursor up `linesFromBottom` lines and to column `col` (0-based). */
  positionCursor(linesFromBottom: number, col: number): void {
    if (linesFromBottom > 0) this.out.write(`\x1b[${linesFromBottom}A`);
    this.out.write(`\r`);
    if (col > 0) this.out.write(`\x1b[${col}C`);
  }

  /** Erase the painted region entirely (cursor returns to its top-left). */
  clear(): void {
    if (this.lineCount === 0) {
      this.out.write("\r\x1b[J");
      return;
    }
    // Cursor may be anywhere within the region; normalise to column 0 of the
    // top line, then clear to end of screen.
    this.out.write("\r");
    if (this.lineCount > 1) this.out.write(`\x1b[${this.lineCount - 1}A`);
    this.out.write("\x1b[J");
    this.lineCount = 0;
  }

  reset(): void {
    this.lineCount = 0;
  }
}

// --- Input box widget ---

const MAX_SUGGESTIONS = 10;

interface WidgetState {
  buffer: string;
  cursor: number; // index into buffer (single logical line editing)
  suggestions: CommandInfo[];
  selected: number;
}

function filterCommands(buffer: string, commands: CommandInfo[]): CommandInfo[] {
  if (!buffer.startsWith("/")) return [];
  const query = buffer.slice(1).split(/\s+/)[0]!.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, MAX_SUGGESTIONS);
}

export function createRawInputReader(opts: {
  commands: CommandInfo[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): RawInputReader {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  let closed = false;

  const renderWidget = (
    state: WidgetState,
  ): { lines: string[]; cursorRow: number; cursorCol: number } => {
    const width = Math.min(terminalColumns() - 1, 100);
    const border = chalk.dim("─".repeat(width));
    const promptText = `${chalk.dim(">")} ${state.buffer}`;
    const lines: string[] = [border, promptText, border];

    // Dropdown for slash commands.
    if (state.suggestions.length > 0) {
      const nameWidth = Math.max(...state.suggestions.map((s) => s.name.length + 1), 8);
      for (let i = 0; i < state.suggestions.length; i++) {
        const s = state.suggestions[i]!;
        const selected = i === state.selected;
        const name = ("/" + s.name).padEnd(nameWidth + 1);
        const desc = truncate(s.description, width - nameWidth - 3);
        const row = selected
          ? CLAUDE_ORANGE(name) + " " + chalk.white(desc)
          : chalk.cyan(name) + " " + chalk.dim(desc);
        lines.push((selected ? chalk.dim("❯ ") : "  ") + row);
      }
    } else {
      lines.push(chalk.dim("  ? for shortcuts"));
    }

    // Cursor sits on the prompt line (index 1), after "> " + cursor offset.
    const cursorCol = 2 + visualWidth(state.buffer.slice(0, state.cursor));
    const cursorRow = 1;
    return { lines, cursorRow, cursorCol };
  };

  const askQuestion = async (prompt: string): Promise<string | null> => {
    // Simple single-line prompt without the box (used for misc questions).
    return readLineRaw(prompt);
  };

  const readInput = async (): Promise<string | null> => {
    return readWidget();
  };

  // Raw read with the full input-box widget + autocomplete.
  const readWidget = (): Promise<string | null> => {
    return new Promise((resolve) => {
      if (closed) return resolve(null);
      const region = new Region(output);
      const state: WidgetState = { buffer: "", cursor: 0, suggestions: [], selected: 0 };

      const repaint = () => {
        state.suggestions = filterCommands(state.buffer, opts.commands);
        if (state.selected >= state.suggestions.length) state.selected = 0;
        const { lines, cursorRow, cursorCol } = renderWidget(state);
        region.paint(lines);
        region.positionCursor(lines.length - 1 - cursorRow, cursorCol);
      };

      const cleanup = (committed: string | null) => {
        input.off("data", onData);
        if (input.isTTY) input.setRawMode(false);
        input.pause();
        region.clear();
        if (committed !== null) {
          // Echo the committed line into scrollback.
          output.write(`${chalk.dim(">")} ${committed}\n`);
        }
        resolve(committed);
      };

      const onData = (data: Buffer) => {
        const key = parseKey(data);
        switch (key.name) {
          case "enter": {
            // Enter always submits. Use Tab to accept a completion.
            cleanup(state.buffer);
            return;
          }
          case "c":
            if (key.ctrl) {
              cleanup(null);
              return;
            }
            break;
          case "d":
            if (key.ctrl) {
              if (state.buffer.length === 0) {
                closed = true;
                cleanup(null);
              }
              return;
            }
            break;
          case "backspace":
            if (state.cursor > 0) {
              state.buffer =
                state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
              state.cursor--;
            }
            repaint();
            return;
          case "delete":
            if (state.cursor < state.buffer.length) {
              state.buffer =
                state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
            }
            repaint();
            return;
          case "left":
            if (state.cursor > 0) state.cursor--;
            repaint();
            return;
          case "right":
            if (state.cursor < state.buffer.length) state.cursor++;
            repaint();
            return;
          case "up":
            if (state.suggestions.length > 0) {
              state.selected =
                (state.selected - 1 + state.suggestions.length) % state.suggestions.length;
              repaint();
            }
            return;
          case "down":
            if (state.suggestions.length > 0) {
              state.selected = (state.selected + 1) % state.suggestions.length;
              repaint();
            }
            return;
          case "tab":
            if (state.suggestions.length > 0) {
              const chosen = state.suggestions[state.selected]!;
              state.buffer = "/" + chosen.name + " ";
              state.cursor = state.buffer.length;
              repaint();
            }
            return;
          case "escape":
            if (state.suggestions.length > 0) {
              // Close the dropdown by clearing the slash (keep typed text).
              state.suggestions = [];
              state.selected = 0;
              repaint();
            }
            return;
          case "char": {
            // Ignore stray escape-sequence bytes / non-printables.
            if (key.sequence < " " && key.sequence !== "\t") return;
            state.buffer =
              state.buffer.slice(0, state.cursor) + key.sequence + state.buffer.slice(state.cursor);
            state.cursor += key.sequence.length;
            repaint();
            return;
          }
        }
      };

      input.resume();
      if (input.isTTY) input.setRawMode(true);
      input.on("data", onData);
      repaint();
    });
  };

  // A minimal raw single-line reader for askQuestion (no box, no dropdown).
  const readLineRaw = (prompt: string): Promise<string | null> => {
    return new Promise((resolve) => {
      if (closed) return resolve(null);
      output.write(prompt);
      let buffer = "";
      const onData = (data: Buffer) => {
        const key = parseKey(data);
        if (key.name === "enter") {
          output.write("\n");
          input.off("data", onData);
          if (input.isTTY) input.setRawMode(false);
          input.pause();
          resolve(buffer);
          return;
        }
        if (key.ctrl && key.name === "c") {
          input.off("data", onData);
          if (input.isTTY) input.setRawMode(false);
          input.pause();
          resolve(null);
          return;
        }
        if (key.name === "backspace") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }
        if (key.name === "char" && key.sequence >= " ") {
          buffer += key.sequence;
          output.write(key.sequence);
        }
      };
      input.resume();
      if (input.isTTY) input.setRawMode(true);
      input.on("data", onData);
    });
  };

  return {
    readInput,
    askQuestion,
    isClosed: () => closed,
    close: () => {
      closed = true;
      if (input.isTTY) {
        try {
          input.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      input.pause();
    },
  };
}

// --- Permission menu (bordered Yes / No, raw-mode selectable) ---

export type PermissionChoice = "yes" | "always" | "no";

export function promptPermissionMenu(opts: {
  header: string;
  detail?: string;
  riskHint?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<PermissionChoice> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  // P1-4: Enhanced permission menu with Chinese text
  const options: Array<{ label: string; value: PermissionChoice; desc: string }> = [
    { label: "允许", value: "yes", desc: "仅本次允许" },
    { label: "始终允许", value: "always", desc: "本会话内不再询问" },
    { label: "拒绝", value: "no", desc: "取消操作" },
  ];

  return new Promise((resolve) => {
    const region = new Region(output);
    let selected = 0;

    const render = () => {
      const width = Math.min(terminalColumns() - 1, 100);
      const top = chalk.dim("┌" + "─".repeat(width - 2) + "┐");
      const bottom = chalk.dim("└" + "─".repeat(width - 2) + "┘");
      const lines: string[] = [top];
      // P1-4: Use Chinese header
      lines.push(boxLine(chalk.bold.cyan("⚠️ 权限请求"), width));
      lines.push(boxLine("", width));

      if (opts.header) {
        lines.push(boxLine("  " + chalk.bold(opts.header), width));
      }

      if (opts.detail) {
        lines.push(boxLine("", width));
        for (const dl of wrapPlain(opts.detail, width - 4)) {
          lines.push(boxLine("  📄 " + dl, width));
        }
      }

      if (opts.riskHint) {
        lines.push(boxLine("", width));
        // P1-4: Better formatting for risk hints
        lines.push(boxLine("  " + chalk.yellow("⚠️ " + opts.riskHint), width));
      }

      lines.push(bottom);
      lines.push("");
      lines.push(chalk.gray("  选择操作:"));

      options.forEach((opt, i) => {
        const marker = i === selected ? chalk.cyan("❯ ") : "  ";
        const label = `[${i + 1}] ${opt.label}`;
        const desc = chalk.dim(` — ${opt.desc}`);
        lines.push(`${marker}${i === selected ? chalk.cyan(label) : label}${desc}`);
      });

      lines.push("");
      lines.push(chalk.dim("  ↑↓ 选择 · Enter 确认 · Esc 取消"));
      lines.push("");
      region.paint(lines);
    };

    const finish = (choice: PermissionChoice) => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      region.clear();
      resolve(choice);
    };

    const onData = (data: Buffer) => {
      const key = parseKey(data);
      if (key.name === "up") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down") {
        selected = (selected + 1) % options.length;
        render();
      } else if (key.name === "enter") {
        finish(options[selected]!.value);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish("no");
      } else if (key.name === "char" && /^[1-3]$/.test(key.sequence)) {
        finish(options[parseInt(key.sequence, 10) - 1]!.value);
      }
    };

    input.resume();
    if (input.isTTY) input.setRawMode(true);
    input.on("data", onData);
    render();
  });
}

// --- Structured question menu (single / multi select) ---

export interface SelectMenuOption {
  label: string;
  description?: string;
}

/**
 * Render a bordered single- or multi-select menu and block for the choice.
 * Returns the selected labels, or null if cancelled (Esc / Ctrl+C).
 * In multiSelect, Space toggles and Enter confirms; in single-select, Enter
 * (or a number key) picks immediately.
 */
export function promptSelectMenu(opts: {
  header: string;
  question: string;
  options: SelectMenuOption[];
  multiSelect?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<string[] | null> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const multi = opts.multiSelect === true;

  return new Promise((resolve) => {
    const region = new Region(output);
    let cursor = 0;
    const checked = new Set<number>();

    const render = () => {
      const width = Math.min(terminalColumns() - 1, 100);
      const top = chalk.dim("┌" + "─".repeat(width - 2) + "┐");
      const bottom = chalk.dim("└" + "─".repeat(width - 2) + "┘");
      const lines: string[] = [top];
      lines.push(boxLine(chalk.bold.cyan(opts.header), width));
      lines.push(boxLine("", width));
      for (const ql of wrapPlain(opts.question, width - 4)) {
        lines.push(boxLine(ql, width));
      }
      lines.push(bottom);
      lines.push("");
      opts.options.forEach((opt, i) => {
        const pointer = i === cursor ? chalk.cyan("❯ ") : "  ";
        const box = multi ? (checked.has(i) ? "[x] " : "[ ] ") : "";
        const label = `${box}${opt.label}`;
        const rendered = i === cursor ? chalk.cyan(label) : label;
        lines.push(`${pointer}${rendered}`);
        if (opt.description) {
          lines.push(`    ${chalk.dim(truncate(opt.description, width - 6))}`);
        }
      });
      lines.push("");
      const hint = multi
        ? "↑↓ move · Space toggle · Enter confirm · Esc cancel"
        : "↑↓ move · Enter select · Esc cancel";
      lines.push(chalk.dim("  " + hint));
      region.paint(lines);
    };

    const finish = (result: string[] | null) => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      region.clear();
      resolve(result);
    };

    const onData = (data: Buffer) => {
      const key = parseKey(data);
      if (key.name === "up") {
        cursor = (cursor - 1 + opts.options.length) % opts.options.length;
        render();
      } else if (key.name === "down") {
        cursor = (cursor + 1) % opts.options.length;
        render();
      } else if (key.name === "char" && key.sequence === " " && multi) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render();
      } else if (key.name === "char" && /^[1-9]$/.test(key.sequence)) {
        const idx = parseInt(key.sequence, 10) - 1;
        if (idx < opts.options.length) {
          if (multi) {
            if (checked.has(idx)) checked.delete(idx);
            else checked.add(idx);
            cursor = idx;
            render();
          } else {
            finish([opts.options[idx]!.label]);
          }
        }
      } else if (key.name === "enter") {
        if (multi) {
          const picked = [...checked].sort((a, b) => a - b).map((i) => opts.options[i]!.label);
          finish(picked); // may be empty → caller treats as "no selection"
        } else {
          finish([opts.options[cursor]!.label]);
        }
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
      }
    };

    input.resume();
    if (input.isTTY) input.setRawMode(true);
    input.on("data", onData);
    render();
  });
}

// --- Helpers ---

function boxLine(content: string, width: number): string {
  const inner = width - 4;
  const pad = Math.max(0, inner - visualWidth(content));
  return chalk.dim("│ ") + content + " ".repeat(pad) + chalk.dim(" │");
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (visualWidth(current + " " + word) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}
