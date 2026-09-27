import { afterEach, describe, expect, it } from "bun:test";
import { readHiddenSections, revealHidden, toggleHidden, writeHiddenSections } from "@/lib/sidebar-section-hidden-pref";

const KEY = "subshell.sidebarHiddenSections";

afterEach(() => localStorage.removeItem(KEY));

describe("toggleHidden", () => {
  it("adds a hidden entry, and a second press removes it", () => {
    const once = toggleHidden({}, "subshells");
    expect(once).toEqual({ subshells: true });
    expect(toggleHidden(once, "subshells")).toEqual({});
  });

  it("leaves the previous map and the other sections alone", () => {
    const prev = { workspaces: true };
    const next = toggleHidden(prev, "subshells");
    expect(prev).toEqual({ workspaces: true });
    expect(next).toEqual({ workspaces: true, subshells: true });
  });
});

describe("revealHidden", () => {
  it("returns the SAME object when the section was never hidden", () => {
    // The identity return is load-bearing: app-sidebar's revealSection only
    // writes to storage when the map actually changed.
    const prev = { workspaces: true };
    expect(revealHidden(prev, "subshells")).toBe(prev);
  });

  it("drops the entry when the section was hidden", () => {
    const next = revealHidden({ subshells: true, workspaces: true }, "subshells");
    expect(next).toEqual({ workspaces: true });
  });
});

describe("readHiddenSections / writeHiddenSections", () => {
  it("round-trips through storage", () => {
    writeHiddenSections({ subshells: true });
    expect(readHiddenSections()).toEqual({ subshells: true });
  });

  it("reads absent, corrupt, and non-object values as empty", () => {
    expect(readHiddenSections()).toEqual({});
    localStorage.setItem(KEY, "{not json");
    expect(readHiddenSections()).toEqual({});
    localStorage.setItem(KEY, '"a string"');
    expect(readHiddenSections()).toEqual({});
  });

  it("survives storage that throws (private mode): reads empty, writes no-op", () => {
    // Restored in `finally`, NOT after the assertion: a leaking throwing
    // getItem would poison every later test file sharing this bun worker
    // (happy-dom's localStorage is process-wide).
    const getItem = localStorage.getItem.bind(localStorage);
    const setItem = localStorage.setItem.bind(localStorage);
    try {
      localStorage.getItem = () => {
        throw new Error("blocked");
      };
      expect(readHiddenSections()).toEqual({});
      localStorage.setItem = () => {
        throw new Error("blocked");
      };
      expect(() => writeHiddenSections({ subshells: true })).not.toThrow();
    } finally {
      localStorage.getItem = getItem;
      localStorage.setItem = setItem;
    }
  });
});
