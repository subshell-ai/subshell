import { afterEach, describe, expect, it } from "bun:test";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { getPushState } from "@/lib/notifications";

const realUA = navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  // The shell is resolved ONCE and memoized, so the marker has to be re-read
  // after the user agent moves or every case sees whichever ran first.
  resetDesktopShellForTests();
}

afterEach(() => setUserAgent(realUA));

/**
 * Gives this environment the two capabilities a macOS WKWebView really has,
 * so the support check reaches the line under test instead of bailing on
 * happy-dom's missing service worker.
 */
function fakeWebviewCapabilities(): () => void {
  const hadSW = "serviceWorker" in navigator;
  const hadPM = "PushManager" in globalThis;
  if (!hadSW) Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
  if (!hadPM) Object.defineProperty(globalThis, "PushManager", { value: class {}, configurable: true });
  return () => {
    if (!hadSW) Reflect.deleteProperty(navigator, "serviceWorker");
    if (!hadPM) Reflect.deleteProperty(globalThis, "PushManager");
  };
}

describe("web push inside Subshell Server", () => {
  /**
   * The defect: `isPushSupported` relied on no embedded webview shipping a
   * `PushManager`. macOS WKWebView has one, so the check passed and the flow
   * read `Notification.permission` — a global Tauri REPLACES with its
   * notification plugin, which the dashboard window is not granted. Every load
   * of this card produced an unhandled promise rejection.
   *
   * The app notifies natively through `desktop_notify`, so the honest answer
   * is that push is not the mechanism there — not that the browser cannot.
   */
  it("reports unsupported without ever touching Notification", async () => {
    setUserAgent("Mozilla/5.0 SubshellDesktop/1.2.3 (macos; p=1)");
    // The webview as it actually is, which is the whole point: BOTH of these
    // are present on macOS WKWebView, so the feature checks pass and the code
    // goes on to read the one global Tauri replaced. Without them the test
    // short-circuits on happy-dom's missing service worker and proves nothing.
    const restore = fakeWebviewCapabilities();
    let touched = false;
    const realNotification = globalThis.Notification;
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      get() {
        touched = true;
        throw new Error("notification.is_permission_granted not allowed");
      },
    });
    try {
      await expect(getPushState()).resolves.toBe("unsupported");
      expect(touched).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: realNotification });
      restore();
    }
  });

  it("leaves a browser and Subshell Client on the ordinary path", async () => {
    // Neither marker is the server app's, so the support check runs normally
    // (and answers from this environment's own capabilities).
    setUserAgent("Mozilla/5.0 SubshellClient/1.2.3 (macos; p=1)");
    await expect(getPushState()).resolves.not.toBe(undefined);
  });
});
