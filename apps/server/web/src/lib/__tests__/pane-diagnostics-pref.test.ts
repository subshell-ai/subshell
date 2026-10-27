import { afterEach, describe, expect, it } from "bun:test";
import {
  paneDiagnosticsIds,
  resetPaneDiagnosticsPrefForTests,
  setPaneDiagnosticsIds,
  togglePaneDiagnostics,
} from "@/lib/pane-diagnostics-pref";

describe("pane diagnostics preference (per-device, per-subshell)", () => {
  const KEY = "subshell.paneDiagnostics";
  afterEach(() => {
    localStorage.removeItem(KEY);
    // The page-load memory is module state; leaving it set would let an earlier
    // case's refused write answer for the next one.
    resetPaneDiagnosticsPrefForTests();
  });

  it("defaults to nothing on: a subshell nobody has diagnosed reads off", () => {
    expect(paneDiagnosticsIds()).toEqual([]);
  });

  /**
   * Runs `body` with the page's writes refused.
   *
   * `localStorage.setItem = () => { throw }` would NOT simulate that: happy-dom's
   * Storage is a proxy, so the assignment lands as a stored key and the real
   * write still happens (measured). Swapping the global is what makes the write
   * actually fail, and the descriptor goes back in `finally`.
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
      resetPaneDiagnosticsPrefForTests();
    }
  }

  it("follows another tab's write after this page's own write was refused", () => {
    // The page-load memory exists so the header and the terminal agree when the
    // device will not store anything. Left pinned, it would also outlive a
    // genuine write from elsewhere, and the hook's contract ("a change from
    // another tab of this device is what renders") would be false: this page
    // keeps showing what it tried to write while the other tab shows the truth.
    withWritesRefused((real) => {
      setPaneDiagnosticsIds(["s1"]);
      expect(paneDiagnosticsIds()).toEqual(["s1"]);
      // A real write from another tab, announced the way the browser announces it.
      real.setItem(KEY, JSON.stringify(["s2", "s3"]));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(["s2", "s3"]) }));
      expect(paneDiagnosticsIds()).toEqual(["s2", "s3"]);
    });
  });

  it("leaves the page-load memory alone for a storage event on some other key", () => {
    withWritesRefused((_real) => {
      setPaneDiagnosticsIds(["s1"]);
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }));
      expect(paneDiagnosticsIds()).toEqual(["s1"]);
    });
  });

  it("hands back a copy, so a caller reordering its own list cannot rewrite the memory", () => {
    // The set has no order, and a surface that sorts what it was handed (to
    // render rows, say) must not reach back into what this page remembers the
    // device stores. While writes land the store is the truth anyway; the memory
    // is what every reader sees once one is refused, which is when an aliased
    // array would make two surfaces disagree again.
    withWritesRefused(() => {
      const returned = setPaneDiagnosticsIds(["s2", "s1"]);
      returned.sort();
      expect(returned).toEqual(["s1", "s2"]);
      expect(paneDiagnosticsIds()).toEqual(["s2", "s1"]);
    });
  });

  it("survives a corrupt or hand-edited value instead of throwing on every render", () => {
    localStorage.setItem(KEY, "not json");
    expect(paneDiagnosticsIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ s1: true }));
    expect(paneDiagnosticsIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s1", 7, null, "s2"]));
    expect(paneDiagnosticsIds()).toEqual(["s1", "s2"]);
  });

  it("persists the set and reads it back", () => {
    // What the store holds is the id list, which is what makes a rename
    // irrelevant to this module: nothing here has a name to key on, and the
    // surfaces that bind a HUD to a pane pass `subshell.id` (pinned against a
    // name in workspace-pane-actions.test.tsx, where a name does exist).
    expect(setPaneDiagnosticsIds(["s1"])).toEqual(["s1"]);
    expect(paneDiagnosticsIds()).toEqual(["s1"]);
    expect(localStorage.getItem(KEY)).toBe('["s1"]');
  });

  it("toggles one id without disturbing the others", () => {
    expect(togglePaneDiagnostics([], "s1")).toEqual(["s1"]);
    expect(togglePaneDiagnostics(["s1", "s2"], "s1")).toEqual(["s2"]);
    expect(togglePaneDiagnostics(["s2"], "s1")).toEqual(["s2", "s1"]);
  });
});
