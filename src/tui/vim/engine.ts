// ============================================================
// Vim Mode — engine facade (owns state, drives the transition table)
// ============================================================
// Framework-agnostic. The Ink InputBox feeds keys in and reads text/offset
// out; this class keeps no rendering or history concern. Undo (`u`) and
// dot-repeat (`.`) live HERE (ported from claude-code useVimInput, where
// onUndo/onDotRepeat were wired at the hook level):
//   • undo  — a snapshot stack (capped at the official useInputBuffer size
//     of 50). NORMAL-mode mutations push their pre-state; an insert session
//     pushes ONE snapshot on Escape, so `cw foo <Esc>` undoes in a single
//     step (vim's change-is-one-unit grouping).
//   • `.`   — replays persistent.lastChange through the same execute*
//     functions with recording disabled, so repeated `.` keeps working.
//     Matching the official: leaving INSERT with typed text overwrites
//     lastChange with { type: "insert" }, so `.` after `cw foo <Esc>`
//     re-inserts "foo" only (the official client has the same limitation).

import { Cursor } from "./cursor.js";
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
} from "./operators.js";
import { type TransitionContext, transition } from "./transitions.js";
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type VimState,
} from "./types.js";

export type VimMode = "insert" | "normal";

type Snapshot = { text: string; offset: number };

/** Official useInputBuffer maxBufferSize. */
const MAX_UNDO = 50;

/** Net text inserted between a session-start snapshot and now: the middle
 *  of `text` once the base's prefix/suffix anchors are removed. Returns null
 *  when the anchors no longer hold (Backspace ate into the pre-insert text)
 *  or nothing was inserted. */
function diffInserted(base: Snapshot, text: string): string | null {
  if (base.offset > base.text.length) return null;
  const prefix = base.text.slice(0, base.offset);
  const suffix = base.text.slice(base.offset);
  if (!text.startsWith(prefix)) return null;
  if (suffix && !text.endsWith(suffix)) return null;
  const end = text.length - suffix.length;
  if (end < base.offset) return null;
  const inserted = text.slice(base.offset, end);
  return inserted.length > 0 ? inserted : null;
}

export class VimEngine {
  private text: string;
  private offset: number;
  private vimState: VimState;
  private persistent: PersistentState;
  private undoStack: Snapshot[] = [];
  /** Armed while in INSERT: `undo` is the pre-session state a single `u`
   *  restores; `base` is the post-operator anchor used to recover the typed
   *  text for dot-repeat. Null in NORMAL mode. */
  private insertSession: { undo: Snapshot; base: Snapshot } | null;

  constructor(initialText = "") {
    this.text = initialText;
    this.offset = initialText.length;
    this.vimState = createInitialVimState();
    this.persistent = createInitialPersistentState();
    // The engine starts in INSERT — the first typing session is a change too.
    const initial: Snapshot = { text: initialText, offset: this.offset };
    this.insertSession = { undo: initial, base: initial };
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
  /** Method (not inline check) so TS narrowing survives: execute() closures
   *  flip vimState via enterInsert, which inline `===` narrowing can't see. */
  private inInsert(): boolean {
    return this.vimState.mode === "INSERT";
  }
  /** Replace the whole document + cursor (e.g. after an external edit).
   *  Undo/dot-repeat state is untouched — snapshots stay valid past states. */
  setText(text: string, offset?: number): void {
    this.text = text;
    this.offset = offset ?? text.length;
  }

  private cursor(): Cursor {
    return new Cursor(this.text, this.offset);
  }

  private pushUndo(snap: Snapshot): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  /** `u` — restore the most recent snapshot. Returns false when empty. */
  private undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.text = snap.text;
    this.offset = Math.min(snap.offset, snap.text.length);
    return true;
  }

  /** `.` — re-run the last recorded change. Recording is disabled during
   *  replay (the official isReplay flag) so `.` can repeat itself. */
  private replayLastChange(): void {
    const change = this.persistent.lastChange;
    if (!change) return;
    const ctx = this.makeCtx(true);
    switch (change.type) {
      case "insert":
        if (change.text) {
          this.text = this.text.slice(0, this.offset) + change.text + this.text.slice(this.offset);
          this.offset += change.text.length;
        }
        break;
      case "x":
        executeX(change.count, ctx);
        break;
      case "replace":
        executeReplace(change.char, change.count, ctx);
        break;
      case "toggleCase":
        executeToggleCase(change.count, ctx);
        break;
      case "indent":
        executeIndent(change.dir, change.count, ctx);
        break;
      case "join":
        executeJoin(change.count, ctx);
        break;
      case "openLine":
        executeOpenLine(change.direction, ctx);
        break;
      case "operatorFind":
        executeOperatorFind(change.op, change.find, change.char, change.count, ctx);
        break;
      case "operatorTextObj":
        executeOperatorTextObj(change.op, change.scope, change.objType, change.count, ctx);
        break;
      case "operator":
        // dd/cc/yy record motion = the doubled operator key, which is NOT a
        // motion — replaying it through resolveMotion would no-op (the
        // official client has this gap). Dispatch linewise explicitly.
        if (change.motion === change.op[0]) executeLineOp(change.op, change.count, ctx);
        else executeOperatorMotion(change.op, change.motion, change.count, ctx);
        break;
    }
  }

  private makeCtx(isReplay: boolean, onUndo?: () => void): TransitionContext {
    return {
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
      recordChange: isReplay
        ? () => {}
        : (change) => {
            this.persistent.lastChange = change;
          },
      onUndo,
      onDotRepeat: () => this.replayLastChange(),
    };
  }

  /** Feed one key token. Returns nothing; read text/offset/mode after. */
  handleKey(key: string): void {
    if (key === "Escape" || key === "Ctrl+[") {
      // Close the insert session (if any) BEFORE dropping to NORMAL.
      if (this.vimState.mode === "INSERT" && this.insertSession) {
        const session = this.insertSession;
        this.insertSession = null;
        if (this.text !== session.undo.text) this.pushUndo(session.undo);
        // Official parity: typed text becomes the repeatable change.
        const inserted = diffInserted(session.base, this.text);
        if (inserted) this.persistent.lastChange = { type: "insert", text: inserted };
      }
      this.vimState = { mode: "NORMAL", command: { type: "idle" } };
      return;
    }

    if (this.vimState.mode === "INSERT") {
      this.handleInsertKey(key);
      return;
    }

    // NORMAL mode: drive the transition table.
    const command = this.vimState.command;
    const before: Snapshot = { text: this.text, offset: this.offset };
    let undone = false;
    const ctx = this.makeCtx(false, () => {
      undone = this.undo();
    });

    const result = transition(command, key, ctx);
    if (result.next) {
      this.vimState = { mode: "NORMAL", command: result.next };
    } else {
      result.execute?.();
      if (this.inInsert()) {
        // i/cw/o/… — arm the insert session. `undo` is the pre-execute state
        // so operator + typed text collapse into ONE undo unit on Escape;
        // `base` is the post-operator anchor for the dot-repeat diff.
        this.insertSession = { undo: before, base: { text: this.text, offset: this.offset } };
      } else {
        // execute may have switched to INSERT via enterInsert; only reset if
        // we're still in NORMAL (a completed motion/operator returns to idle).
        this.vimState = { mode: "NORMAL", command: { type: "idle" } };
        // Motions/yanks leave the text alone — nothing to undo. `u` itself
        // restores rather than pushes (no redo stack; the second `u` goes
        // further back, matching vim without Ctrl-R).
        if (!undone && this.text !== before.text) this.pushUndo(before);
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
