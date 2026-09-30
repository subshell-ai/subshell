import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * Shared User-Agent stub for tests that render surface-gated controls.
 *
 * `desktopShell()` parses (and memoizes) the User-Agent, so each surface is
 * a different UA. Stubbing the UA - not the module - is the route
 * `updates-desktop-rows.test.tsx` pioneered; it is shared now because the
 * Server row and the Nodes section gate their Notes links on the same fact.
 */
export const CLIENT_UA = "Mozilla/5.0 SubshellClient/0.3.0 (linux; p=1)";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

export function setUA(userAgent: string): void {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

export function restoreUA(): void {
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
}
