// ============================================================
// useStoreSelector — field-sliced subscription to the TuiStore (M24.2)
// ============================================================
// `useSyncExternalStore(store.subscribe, store.getSnapshot)` re-renders a
// component on *every* store mutation, because the snapshot identity changes on
// each `set()`. That made the whole <App> tree reconcile on every streamed
// token (input box, status bar, all active cards included) — the source of the
// streaming jank M24 fixes.
//
// These hooks let each region subscribe to only the slice it renders, so a
// token delta re-renders the streaming text and nothing else.
//   • useStoreField(store, "streamingText")  → the single field, ===-compared
//   • useStoreSelector(store, s => ({...}))   → a derived object, shallow-compared
//
// The shallow-equal cache on useStoreSelector is essential: a selector that
// builds a fresh object each call would fail React's Object.is check every time
// and re-render unconditionally (or, with getSnapshot, loop forever). We cache
// the last selected value and return it unchanged when shallow-equal.
// ============================================================

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StoreState, TuiStore } from "./store.js";

/** Subscribe to one top-level field of the store state. */
export function useStoreField<K extends keyof StoreState>(store: TuiStore, key: K): StoreState[K] {
  const getField = useCallback(() => store.getSnapshot()[key], [store, key]);
  return useSyncExternalStore(store.subscribe, getField);
}

/** True when two objects have the same keys and `Object.is`-equal values. */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Subscribe to a derived slice of the store. The selector typically returns a
 * fresh object ({ a, b }); we memoize the previous result and return it
 * unchanged while it's shallow-equal, so the component only re-renders when a
 * selected value actually changes. Without this cache the fresh-object identity
 * would defeat React's bail-out (and break getSnapshot stability).
 */
export function useStoreSelector<T extends Record<string, unknown>>(
  store: TuiStore,
  selector: (state: StoreState) => T,
): T {
  // One cache per hook instance. `useRef` survives re-renders without causing
  // them; the getSnapshot closure reads/writes it.
  const cache = useRef<T | null>(null);
  const getSelection = useCallback(() => {
    const next = selector(store.getSnapshot());
    const prev = cache.current;
    if (prev !== null && shallowEqual(prev, next)) return prev;
    cache.current = next;
    return next;
  }, [store, selector]);
  return useSyncExternalStore(store.subscribe, getSelection);
}
