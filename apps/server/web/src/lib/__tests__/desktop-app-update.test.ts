import { describe, expect, it } from "bun:test";
import {
  appUpdateRowVisible,
  type DesktopAppUpdate,
  DISMISSED_APP_UPDATE_KEY,
  readDismissedAppUpdate,
  rememberAppUpdateDismissal,
} from "@/lib/desktop-app-update";

/**
 * When the footer row shows itself, and what a dismissal is bound to (spec
 * 2026-09-17 §5.3). Pure, because "gone for the app run, back when a NEWER
 * version appears" is the whole mechanism and it has to be readable without a
 * shell, a storage, or a clock.
 */

function update(availableVersion: string | null): DesktopAppUpdate {
  return { currentVersion: "0.7.2", availableVersion };
}

describe("appUpdateRowVisible", () => {
  it("shows the row when the shell names a newer version", () => {
    expect(appUpdateRowVisible(update("0.8.0"), null)).toBe(true);
  });

  it("shows nothing when no update is known — which is not 'up to date'", () => {
    expect(appUpdateRowVisible(update(null), null)).toBe(false);
  });

  it("shows nothing before the shell answers, or when it answered nothing", () => {
    expect(appUpdateRowVisible(undefined, null)).toBe(false);
    expect(appUpdateRowVisible(null, null)).toBe(false);
  });

  it("hides exactly the version that was dismissed", () => {
    expect(appUpdateRowVisible(update("0.8.0"), "0.8.0")).toBe(false);
  });

  // The dismissal carries no expiry: the version IS the key, so the next
  // release re-shows the row without anything here having to notice a date.
  it("re-shows for a newer version than the one dismissed", () => {
    expect(appUpdateRowVisible(update("0.9.0"), "0.8.0")).toBe(true);
  });

  it("shows a version the person never dismissed", () => {
    // A dismissal says nothing about any other version, including a lower one
    // — the comparison is equality, so no expiry logic can drift out of it.
    expect(appUpdateRowVisible(update("0.8.0"), "0.9.0")).toBe(true);
  });
});

describe("the dismissal in sessionStorage", () => {
  it("reads null when nothing was dismissed", () => {
    sessionStorage.clear();
    expect(readDismissedAppUpdate()).toBeNull();
  });

  it("writes and reads back the dismissed version under its own key", () => {
    sessionStorage.clear();
    rememberAppUpdateDismissal("0.8.0");
    expect(sessionStorage.getItem(DISMISSED_APP_UPDATE_KEY)).toBe("0.8.0");
    expect(readDismissedAppUpdate()).toBe("0.8.0");
    sessionStorage.clear();
  });

  // The platform rule: storage can be absent or throw (private mode), and a
  // footer row must not be the thing that surfaces it. Forgetting the dismissal
  // shows the row again — the safe direction of the two failures.
  it("swallows a storage that throws on both sides", () => {
    const original = globalThis.sessionStorage;
    const thrower = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    Object.defineProperty(globalThis, "sessionStorage", { value: thrower, configurable: true });
    try {
      expect(readDismissedAppUpdate()).toBeNull();
      expect(() => rememberAppUpdateDismissal("0.8.0")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", { value: original, configurable: true });
    }
  });
});
