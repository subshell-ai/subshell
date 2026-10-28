import { afterEach, describe, expect, it } from "bun:test";
import {
  paneCopyModeIds,
  resetPaneCopyModePrefForTests,
  setPaneCopyModeIds,
  togglePaneCopyMode,
} from "@/lib/pane-copy-mode-pref";

describe("pane copy-mode preference (per-device, per-subshell)", () => {
  const KEY = "subshell.paneCopyMode";
  // The key OWNED below (the isolation test plants a value in it) is cleaned
  // here too: happy-dom's localStorage is one global across every file in the
  // package run, and a leftover diagnostics value breaks
  // pane-diagnostics-pref.test.ts's defaults assertion — green locally, red
  // on CI, because file order differs by platform. A file clears what it
  // writes, whichever key it wrote.
  const DIAGNOSTICS_KEY = "subshell.paneDiagnostics";
  afterEach(() => {
    localStorage.removeItem(KEY);
    localStorage.removeItem(DIAGNOSTICS_KEY);
    // The page-load memory is module state; leaving it set would let an earlier
    // case's refused write answer for the next one.
    resetPaneCopyModePrefForTests();
  });

  /**
   * Runs `body` with the page's writes refused.
   *
   * `localStorage.setItem = () => { throw }` would NOT simulate that: happy-dom's
   * Storage is a proxy, so the assignment lands as a stored key and the real write
   * still happens (measured, and the same trap `pane-diagnostics-pref.test.ts`
   * documents). Swapping the global is what makes the write actually fail, and the
   * descriptor goes back in `finally`.
   */
  function withWritesRefused(body: (real: Storage) => void): void {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => real.getItem(key),
        removeItem: (key: string) => real.removeItem(key),
        setItem: () => {
          throw new Error("quota");
        },
      } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">,
      configurable: true,
      writable: true,
    });
    try {
      body(real);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      resetPaneCopyModePrefForTests();
    }
  }

  it("defaults to off: a subshell nobody put into copy mode reads off", () => {
    expect(paneCopyModeIds()).toEqual([]);
  });

  it("survives a corrupt or hand-edited value instead of throwing on every render", () => {
    localStorage.setItem(KEY, "not json");
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ s1: true }));
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s1", 7, null, "s2"]));
    expect(paneCopyModeIds()).toEqual(["s1", "s2"]);
  });

  it("persists the set and reads it back", () => {
    expect(setPaneCopyModeIds(["s1"])).toEqual(["s1"]);
    expect(paneCopyModeIds()).toEqual(["s1"]);
    expect(localStorage.getItem(KEY)).toBe('["s1"]');
  });

  it("toggles one id without disturbing the others", () => {
    expect(togglePaneCopyMode([], "s1")).toEqual(["s1"]);
    expect(togglePaneCopyMode(["s1", "s2"], "s1")).toEqual(["s2"]);
    expect(togglePaneCopyMode(["s2"], "s1")).toEqual(["s2", "s1"]);
  });

  it("keeps the copy mode when the device refuses to store it", () => {
    // Private browsing and a full quota both make the write throw. The comment
    // here used to CLAIM the choice still held for this page load while nothing
    // backed it, so the menu checked the press and the touch bar re-read an
    // unchanged store: two surfaces, one question, two answers, and a
    // "Text copying enabled" toast that had not enabled anything for anyone else.
    withWritesRefused(() => {
      setPaneCopyModeIds(["s1"]);
      expect(paneCopyModeIds()).toEqual(["s1"]);
    });
  });

  it("follows another tab's write after this page's own write was refused", () => {
    withWritesRefused((real) => {
      setPaneCopyModeIds(["s1"]);
      expect(paneCopyModeIds()).toEqual(["s1"]);
      real.setItem(KEY, JSON.stringify(["s2"]));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(["s2"]) }));
      expect(paneCopyModeIds()).toEqual(["s2"]);
    });
  });

  it("leaves the page-load memory alone for a storage event on some other key", () => {
    withWritesRefused(() => {
      setPaneCopyModeIds(["s1"]);
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }));
      expect(paneCopyModeIds()).toEqual(["s1"]);
    });
  });

  it("hands back a copy, so a caller reordering its own list cannot rewrite the memory", () => {
    withWritesRefused(() => {
      const returned = setPaneCopyModeIds(["s2", "s1"]);
      returned.sort();
      expect(returned).toEqual(["s1", "s2"]);
      expect(paneCopyModeIds()).toEqual(["s2", "s1"]);
    });
  });

  it("lives under its OWN key: a diagnostics HUD and a copy mode are two choices", () => {
    // Regression guard against a copy-paste of the diagnostics key.
    localStorage.setItem("subshell.paneDiagnostics", JSON.stringify(["s1"]));
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s2"]));
    expect(paneCopyModeIds()).toEqual(["s2"]);
  });
});
