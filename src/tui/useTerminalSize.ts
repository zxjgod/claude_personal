// ============================================================
// useTerminalSize — live terminal rows/cols (M25.2)
// ============================================================
// The full-screen layout needs the terminal height to size the scroll viewport
// (rows minus the fixed status line / input box). Ink's useStdout gives us the
// stream; we read columns/rows from it and re-read on SIGWINCH ("resize") so the
// layout tracks window changes. Falls back to 80×24 when not a TTY (tests).
// ============================================================

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  rows: number;
  columns: number;
}

function read(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80;
  const rows = stdout?.rows && stdout.rows > 0 ? stdout.rows : 24;
  return { rows, columns };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => read(stdout));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read(stdout));
    // Re-sync once on mount in case the size changed between the initial
    // useState and the effect firing.
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
