import { afterEach, describe, expect, test } from "bun:test";
import { movesThisAppsWindow } from "@/components/networking/addresses-card";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * The one line on this card that predicts a consequence rather than describing
 * a value: saving an https base URL moves Subshell Server's own window to that
 * address, so the app restarts onto a different origin and the person signs in
 * there.
 *
 * It asserted a LOCKOUT until 2026-09-19, and was additionally gated on this
 * page's own protocol; both went with the defect they described (the window
 * only ever opened on loopback http, so an https instance's `Secure` cookie
 * could never be stored in it). What is left is one question: is this the app,
 * and is the value https.
 *
 * **Both globals this file moves are RESTORED, by descriptor** (review,
 * 2026-09-18). The happy-dom window is process-wide and `src/test-setup.ts`
 * documents this exact class as the suite's historical flake: a file that
 * replaced `window.location` with a plain object left every later file with an
 * undefined `location.origin` (happy-dom exposes those on the PROTOTYPE, so a
 * spread copies nothing), and a left-behind `SubshellDesktop/…` user agent
 * makes the next caller of `resetDesktopShellForTests()` conclude it is inside
 * that app. Green by file ordering is not green.
 */
const UA_SERVER_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 SubshellDesktop/1.2.3 (macos; p=1)";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

/** The URL happy-dom is registered at, and what every surface here restores to. */
const HOME = "http://localhost/";

function setUrl(url: string): void {
  const happy = (window as unknown as { happyDOM?: { setURL?: (u: string) => void } }).happyDOM;
  happy?.setURL?.(url);
}

/** The protocol is moved through happy-dom's own navigation, never by assignment. */
function surface(ua: string, url: string): void {
  resetDesktopShellForTests();
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  setUrl(url);
}

const ORIGINAL_UA = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "userAgent");

afterEach(() => {
  // The UA back to the prototype's own getter, so nothing here can make a
  // later file think it is running inside a desktop shell.
  const own = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  if (own && ORIGINAL_UA) Reflect.deleteProperty(navigator as unknown as object, "userAgent");
  resetDesktopShellForTests();
  setUrl(HOME);
});

describe("movesThisAppsWindow", () => {
  test("warns inside Subshell Server, on http, for an https draft", () => {
    surface(UA_SERVER_APP, HOME);
    expect(movesThisAppsWindow("https://plane.example.com")).toBe(true);
    expect(movesThisAppsWindow("  HTTPS://plane.example.com  ")).toBe(true);
  });

  test("says nothing about a value that keeps this window working", () => {
    surface(UA_SERVER_APP, HOME);
    expect(movesThisAppsWindow("http://127.0.0.1:3080")).toBe(false);
    expect(movesThisAppsWindow("")).toBe(false);
  });

  test("says the same thing on the https page the app has moved to", () => {
    // The page's own protocol is not part of the question any more: what is
    // being predicted is where the app REOPENS, not where this page is.
    surface(UA_SERVER_APP, "https://plane.example.com/settings/networking");
    expect(movesThisAppsWindow("https://other.example.com")).toBe(true);
  });

  test("says nothing in a browser, which has no such window to lose", () => {
    surface(UA_BROWSER, HOME);
    expect(movesThisAppsWindow("https://plane.example.com")).toBe(false);
  });
});
