// ============================================================
// Vim Mode — engine facade (owns state, drives the transition table)
// ============================================================
// Framework-agnostic. The Ink InputBox will feed keys in and read text/offset
// out; this class keeps no rendering or history concern. Undo and dot-repeat
// are recorded (lastChange) but replay/undo-stack live in the InputBox, which
// owns the full document history.

import { Cursor } from "./cursor.js";
import { type TransitionContext, transition } from "./transitions.js";
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type VimState,
} from "./types.js";

export type VimMode = "insert" | "normal";

export class VimEngine {
  private text: string;
  private offset: number;
  private vimState: VimState;
  private persistent: PersistentState;

  constructor(initialText = "") {
    this.text = initialText;
    this.offset = initialText.length;
    this.vimState = createInitialVimState();
    this.persistent = createInitialPersistentState();
  }

  getText(): string {
    return this.text;
  }
  getOffset(): number {
    return this.offset;
  }
  getMode(): VimMode {
    return this.vimState.mode === "INSERT" ? "insert" : "normal";
  }
  /** Replace the whole document + cursor (e.g. after an external edit). */
  setText(text: string, offset?: number): void {
    this.text = text;
    this.offset = offset ?? text.length;
  }

  private cursor(): Cursor {
    return new Cursor(this.text, this.offset);
  }

  /** Feed one key token. Returns nothing; read text/offset/mode after. */
  handleKey(key: string): void {
    if (key === "Escape" || key === "Ctrl+[") {
      this.vimState = { mode: "NORMAL", command: { type: "idle" } };
      return;
    }

    if (this.vimState.mode === "INSERT") {
      this.handleInsertKey(key);
      return;
    }

    // NORMAL mode: drive the transition table.
    const command = this.vimState.command;
    const ctx: TransitionContext = {
      cursor: this.cursor(),
      text: this.text,
      setText: (t) => {
        this.text = t;
      },
      setOffset: (o) => {
        this.offset = o;
      },
      enterInsert: (o) => {
        this.offset = o;
        this.vimState = { mode: "INSERT", insertedText: "" };
      },
      getRegister: () => this.persistent.register,
      setRegister: (content, linewise) => {
        this.persistent.register = content;
        this.persistent.registerIsLinewise = linewise;
      },
      getLastFind: () => this.persistent.lastFind,
      setLastFind: (type, char) => {
        this.persistent.lastFind = { type, char };
      },
      recordChange: (change) => {
        this.persistent.lastChange = change;
      },
    };

    const result = transition(command, key, ctx);
    if (result.next) {
      this.vimState = { mode: "NORMAL", command: result.next };
    } else {
      result.execute?.();
      // execute may have switched to INSERT via enterInsert; only reset if
      // we're still in NORMAL (a completed motion/operator returns to idle).
      if (this.vimState.mode === "NORMAL") {
        this.vimState = { mode: "NORMAL", command: { type: "idle" } };
      }
    }
  }

  private handleInsertKey(key: string): void {
    if (key === "Backspace") {
      if (this.offset > 0) {
        const prev = this.cursor().left().offset;
        this.text = this.text.slice(0, prev) + this.text.slice(this.offset);
        this.offset = prev;
      }
      return;
    }
    if (key === "Enter") {
      this.text = this.text.slice(0, this.offset) + "\n" + this.text.slice(this.offset);
      this.offset += 1;
      return;
    }
    // Printable character (or a single-codepoint key) — insert verbatim.
    if (key.length === 1) {
      this.text = this.text.slice(0, this.offset) + key + this.text.slice(this.offset);
      this.offset += 1;
    }
  }
}
