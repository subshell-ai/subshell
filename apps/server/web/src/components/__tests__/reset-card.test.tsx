import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServerDesktop, resetDesktopShellForTests } from "@/lib/desktop";
import { resetCardVisible } from "../settings/reset-card";

describe("resetCardVisible", () => {
  it("shows for an admin inside the desktop shell, and nowhere else", () => {
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: true })).toBe(true);
    expect(resetCardVisible({ viewerIsAdmin: false, desktop: true })).toBe(false);
    expect(resetCardVisible({ viewerIsAdmin: undefined, desktop: true })).toBe(false);
    // A plain browser, or Subshell Client: the reset verb lives in the SERVER
    // app's assistant, so an entry with no path to it would be a button that
    // lies.
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: false })).toBe(false);
  });
});

/**
 * The gate as the ROUTE actually computes it.
 *
 * The predicate above is pure and cannot regress on its own; what can regress
 * is what gets fed to it. Subshell Client used to be excluded for free — it
 * shipped no user-agent marker, so any notion of "desktop" was false there.
 * It carries `SubshellClient/…` now, so the exclusion is carried entirely by
 * the route passing `isServerDesktop()` rather than `isDesktop()`, and nothing
 * about that choice is visible in the predicate's own signature.
 *
 * A regression here is not cosmetic: the card's button calls
 * `desktop_open_assistant`, a command Subshell Client does not grant and has no
 * assistant window for, so it would render a destructive-looking control that
 * silently does nothing (the SPA's bridge never throws).
 */
describe("the reset card's gate under each shell", () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  let previous: PropertyDescriptor | undefined;

  function setUA(userAgent: string) {
    previous ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
    Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
    resetDesktopShellForTests();
  }

  afterEach(() => {
    if (previous) Object.defineProperty(nav, "userAgent", previous);
    else delete nav.userAgent;
    previous = undefined;
    resetDesktopShellForTests();
  });

  it("stays hidden for an admin inside Subshell Client", () => {
    setUA("Mozilla/5.0 SubshellClient/0.3.0 (linux; p=1)");
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: isServerDesktop() })).toBe(false);
  });

  it("shows for an admin inside Subshell Server", () => {
    setUA("Mozilla/5.0 SubshellDesktop/0.5.0 (macos; p=1; b=0.5.0)");
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: isServerDesktop() })).toBe(true);
  });

  it("stays hidden for an admin in a browser", () => {
    setUA("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15");
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: isServerDesktop() })).toBe(false);
  });

  // The composition above is only the gate the ROUTE uses if the route feeds
  // it the same predicate. That is one identifier in one file, it is the thing
  // that would be "simplified" back to `isDesktop()`, and no behavioural test
  // in this suite reaches it — so it is pinned at the source.
  it("is what routes/settings.tsx actually passes", () => {
    const route = readFileSync(join(import.meta.dir, "../../routes/settings.tsx"), "utf8");
    expect(route).toContain("resetCardVisible({ viewerIsAdmin, desktop: isServerDesktop() })");
  });
});
