import { afterEach, describe, expect, test } from "bun:test";
import { strandsThisApp } from "@/components/networking/addresses-card";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * The one warning on this card that predicts a consequence rather than
 * describing a value (operator's report, 2026-09-18): saving an https base URL
 * signs Subshell Server's own window out for good, because better-auth marks
 * the session cookie `Secure` for an https `APP_BASE_URL` and a browser will
 * not keep a Secure cookie on an http page.
 *
 * Both halves of the condition are load-bearing, and the second one arrived in
 * review: the window is no longer pinned to loopback (spec 2026-09-18 § 15),
 * so it may legitimately sit on the instance's own https address — and there
 * the warning would be asserting a lockout on the very page the admin had just
 * signed into over https.
 */
const UA_SERVER_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 SubshellDesktop/1.2.3 (macos; p=1)";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

function surface(ua: string, protocol: string): void {
  resetDesktopShellForTests();
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window, "location", { value: { ...window.location, protocol }, configurable: true });
}

afterEach(() => resetDesktopShellForTests());

describe("strandsThisApp", () => {
  test("warns inside Subshell Server, on http, for an https draft", () => {
    surface(UA_SERVER_APP, "http:");
    expect(strandsThisApp("https://plane.example.com")).toBe(true);
    expect(strandsThisApp("  HTTPS://plane.example.com  ")).toBe(true);
  });

  test("says nothing about a value that keeps this window working", () => {
    surface(UA_SERVER_APP, "http:");
    expect(strandsThisApp("http://127.0.0.1:3080")).toBe(false);
    expect(strandsThisApp("")).toBe(false);
  });

  test("says nothing on a page that is already https — the lockout did not happen", () => {
    surface(UA_SERVER_APP, "https:");
    expect(strandsThisApp("https://plane.example.com")).toBe(false);
  });

  test("says nothing in a browser, which has no such window to lose", () => {
    surface(UA_BROWSER, "http:");
    expect(strandsThisApp("https://plane.example.com")).toBe(false);
  });
});
