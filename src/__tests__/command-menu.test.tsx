// ============================================================
// Tests: 档位式 command menus (bare /agents, /memory-approval → TogglePicker)
// ============================================================
// Each row is one setting; ←/→ flips its档位 in place and fires onChange
// (which persists IMMEDIATELY), ↑/↓ moves between rows, Enter/Esc closes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMemoryApprovalRequired, setMemoryApproval } from "../memory-approval.js";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  getSubagentSettings,
  setSubagentSettings,
} from "../subagent-settings.js";
import { runAgentsMenu, runMemoryApprovalMenu } from "../tui/command-menu-flow.js";
import type { TogglePickerRow } from "../tui/store.js";
import { TuiStore } from "../tui/store.js";
import { TogglePicker } from "../tui/TogglePicker.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cmdmenu-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeOverlay(rows: TogglePickerRow[], shouldCommit: () => boolean = () => true) {
  const changes: Array<[string, string]> = [];
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => (resolve = r));
  return {
    changes,
    done,
    overlay: {
      kind: "togglePicker" as const,
      title: "T",
      hint: "h",
      rows,
      onChange: (rowId: string, value: string) => {
        changes.push([rowId, value]);
        return shouldCommit();
      },
      resolve,
    },
  };
}

describe("TogglePicker component", () => {
  const rows: TogglePickerRow[] = [
    { id: "a", label: "rowA", values: ["off", "on"], current: "off" },
    { id: "b", label: "rowB", values: ["audit", "report"], current: "audit" },
  ];

  it("←/→ flips the highlighted row's档位 and fires onChange per flip", async () => {
    const { overlay, changes, done } = makeOverlay(rows);
    const { lastFrame, stdin, unmount } = render(<TogglePicker overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("rowA");
    stdin.write("\x1b[C"); // → flips rowA off→on (即刻生效)
    await flush();
    expect(changes).toEqual([["a", "on"]]);
    expect(lastFrame()).toContain("‹on›");
    stdin.write("\x1b[C"); // → wraps on→off
    await flush();
    expect(changes).toEqual([
      ["a", "on"],
      ["a", "off"],
    ]);
    stdin.write("\x1b[B"); // ↓ to rowB
    stdin.write("\x1b[D"); // ← flips rowB audit→report
    await flush();
    expect(changes[2]).toEqual(["b", "report"]);
    stdin.write("\r"); // Enter closes
    await expect(done).resolves.toBeUndefined();
    unmount();
  });

  it("keeps the current value visible when the persist callback rejects a flip", async () => {
    const { overlay, changes } = makeOverlay(rows, () => false);
    const { lastFrame, stdin, unmount } = render(<TogglePicker overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("‹off›");
    stdin.write("\x1b[C");
    await flush();
    expect(changes).toEqual([["a", "on"]]);
    expect(lastFrame()).toContain("‹off›");
    expect(lastFrame()).not.toContain("‹on›");
    unmount();
  });

  it("Esc closes without further changes", async () => {
    const { overlay, changes, done } = makeOverlay(rows);
    const { stdin, unmount } = render(<TogglePicker overlay={overlay} />);
    await flush();
    stdin.write("\x1b");
    await expect(done).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    unmount();
  });
});

describe("store.openTogglePicker pipeline", () => {
  it("opens the togglePicker overlay and closes through resolve", async () => {
    const store = new TuiStore("p/m");
    const p = store.openTogglePicker("T", undefined, rows(), () => true);
    expect(store.getSnapshot().overlay?.kind).toBe("togglePicker");
    const overlay = store.getSnapshot().overlay as Extract<
      NonNullable<ReturnType<TuiStore["getSnapshot"]>["overlay"]>,
      { kind: "togglePicker" }
    >;
    overlay.resolve();
    await p;
    expect(store.getSnapshot().overlay).toBeNull();
  });

  function rows(): TogglePickerRow[] {
    return [{ id: "x", label: "X", values: ["a", "b"], current: "a" }];
  }
});

describe("menu flows persist on every flip", () => {
  const savedUserDir = process.env.CCR_USER_CONFIG_DIR;
  beforeEach(() => {
    setSubagentSettings({ ...DEFAULT_SUBAGENT_SETTINGS });
    setMemoryApproval(false); // default OFF (user decision 2026-10-04)
  });
  afterEach(() => {
    if (savedUserDir === undefined) delete process.env.CCR_USER_CONFIG_DIR;
    else process.env.CCR_USER_CONFIG_DIR = savedUserDir;
    setMemoryApproval(false);
  });

  it("runAgentsMenu: flipping thinking/sidechain persists immediately", async () => {
    const root = tmp();
    // tmp workspace ≠ package root → global-install branch → user settings file.
    const userDir = tmp();
    process.env.CCR_USER_CONFIG_DIR = userDir;
    let captured: {
      rows: TogglePickerRow[];
      onChange: (rowId: string, value: string) => boolean;
    } | null = null;
    const fakeStore = {
      openTogglePicker: async (
        _t: string,
        _h: string | undefined,
        rows: TogglePickerRow[],
        onChange: (rowId: string, value: string) => boolean,
      ) => {
        captured = { rows, onChange };
      },
    } as unknown as TuiStore;

    await runAgentsMenu(fakeStore, root);
    expect(captured).not.toBeNull();
    const byId = new Map(captured!.rows.map((r) => [r.id, r]));
    expect(byId.get("thinking")!.current).toBe("off"); // default
    expect(byId.get("sidechain")!.current).toBe("audit"); // default
    // 默认档位一律排左边
    expect(byId.get("thinking")!.values).toEqual(["off", "on"]);
    expect(byId.get("sidechain")!.values).toEqual(["audit", "report"]);

    captured!.onChange("thinking", "on");
    expect(getSubagentSettings().thinking).toBe(true); // 即刻生效
    captured!.onChange("sidechain", "report");
    expect(getSubagentSettings().sidechainMode).toBe("report");
    // And persisted to the resolved (user-level) settings file
    const disk = JSON.parse(fs.readFileSync(path.join(userDir, "settings.json"), "utf-8"));
    expect(disk.subagents.thinking).toBe(true);
    expect(disk.subagents.sidechainMode).toBe("report");
  });

  it("runAgentsMenu: a refused settings write returns false without changing runtime", async () => {
    const root = tmp();
    const userDir = tmp();
    process.env.CCR_USER_CONFIG_DIR = userDir;
    fs.writeFileSync(path.join(userDir, "settings.json"), "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onChanges: Array<(rowId: string, value: string) => boolean> = [];
    const fakeStore = {
      openTogglePicker: async (
        _t: string,
        _h: string | undefined,
        _rows: TogglePickerRow[],
        oc: (rowId: string, value: string) => boolean,
      ) => {
        onChanges.push(oc);
      },
    } as unknown as TuiStore;

    await runAgentsMenu(fakeStore, root);
    expect(onChanges[0]?.("thinking", "on")).toBe(false);
    expect(getSubagentSettings().thinking).toBe(false);
  });

  it("runMemoryApprovalMenu: flipping the gate persists immediately", async () => {
    const root = tmp();
    process.env.CCR_USER_CONFIG_DIR = tmp();
    const onChanges: Array<(rowId: string, value: string) => boolean> = [];
    const fakeStore = {
      openTogglePicker: async (
        _t: string,
        _h: string | undefined,
        rows: TogglePickerRow[],
        oc: (rowId: string, value: string) => boolean,
      ) => {
        expect(rows).toHaveLength(1);
        expect(rows[0]?.current).toBe("off"); // default OFF
        expect(rows[0]?.values).toEqual(["off", "on"]); // 默认档位在左
        onChanges.push(oc);
      },
    } as unknown as TuiStore;

    await runMemoryApprovalMenu(fakeStore, root);
    expect(onChanges[0]?.("gate", "on")).toBe(true);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("runMemoryApprovalMenu: a higher-precedence pin rejects the visible flip", async () => {
    const root = tmp();
    process.env.CCR_USER_CONFIG_DIR = tmp();
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ memory: { requireApproval: true } }),
    );
    // The local layer owns the write; the project layer still forces ON.
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), '{"memory":{}}');
    setMemoryApproval(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChanges: Array<(rowId: string, value: string) => boolean> = [];
    const fakeStore = {
      openTogglePicker: async (
        _t: string,
        _h: string | undefined,
        rows: TogglePickerRow[],
        oc: (rowId: string, value: string) => boolean,
      ) => {
        expect(rows[0]?.current).toBe("on");
        onChanges.push(oc);
      },
    } as unknown as TuiStore;

    await runMemoryApprovalMenu(fakeStore, root);
    expect(onChanges[0]?.("gate", "off")).toBe(false);
    expect(isMemoryApprovalRequired()).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("强制开启"));
  });
});
