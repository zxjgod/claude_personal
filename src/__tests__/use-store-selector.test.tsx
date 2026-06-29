// ============================================================
// Tests: useStoreSelector / useStoreField (M24.2)
// ============================================================
// Verifies field-sliced subscription: a component re-renders only when the
// slice it selected actually changes, not on every store mutation. This is the
// mechanism that stops a streamed token from re-rendering the whole App tree.
// ============================================================

import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TuiStore } from "../tui/store.js";
import { useStoreField, useStoreSelector } from "../tui/useStoreSelector.js";

// ink-testing-library re-renders asynchronously; give React a tick to process
// a scheduled update (or to confirm it bailed out) before asserting counts.
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe("useStoreField", () => {
  it("re-renders only when the selected field changes", async () => {
    const store = new TuiStore("p/m");
    let renders = 0;
    function Probe() {
      renders++;
      const text = useStoreField(store, "streamingText");
      return <Text>{`[${text}]`}</Text>;
    }
    const { lastFrame } = render(<Probe />);
    await tick();
    const initial = renders;
    expect(lastFrame()).toContain("[]");

    // Mutating an UNwatched field must not re-render this component.
    store.addUsage(10, 20);
    await tick();
    expect(renders).toBe(initial);

    // Mutating the watched field re-renders and shows the new value.
    store.appendStreaming("hi");
    await tick();
    expect(renders).toBe(initial + 1);
    expect(lastFrame()).toContain("[hi]");
  });
});

describe("useStoreSelector", () => {
  it("returns a stable value while the selected slice is shallow-equal", async () => {
    const store = new TuiStore("p/m");
    let renders = 0;
    function Probe() {
      renders++;
      const { inTok, outTok } = useStoreSelector(store, (s) => ({
        inTok: s.tokensIn,
        outTok: s.tokensOut,
      }));
      return <Text>{`${inTok}/${outTok}`}</Text>;
    }
    const { lastFrame } = render(<Probe />);
    await tick();
    const initial = renders;
    expect(lastFrame()).toContain("0/0");

    // A mutation that doesn't touch the selected fields → no re-render
    // (selector returns a fresh object but it's shallow-equal, so cached).
    store.appendStreaming("noise");
    await tick();
    expect(renders).toBe(initial);

    // A mutation that changes a selected field → re-render with new value.
    store.addUsage(5, 7);
    await tick();
    expect(renders).toBe(initial + 1);
    expect(lastFrame()).toContain("5/7");
  });
});
