import { afterEach, describe, expect, it } from "bun:test";
import { DEVICE_LABEL_MAX, normalizeDeviceLabel } from "@internal/subshell-protocol";
import {
  DEVICE_NAME_FALLBACK,
  DEVICE_NAME_KEY,
  deviceName,
  deviceNameFromUserAgent,
  setDeviceName,
} from "@/lib/device-name";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
};

describe("deviceNameFromUserAgent", () => {
  it("names the common devices readably", () => {
    expect(deviceNameFromUserAgent(UA.iphoneSafari)).toBe("Safari on iPhone");
    expect(deviceNameFromUserAgent(UA.ipadSafari)).toBe("Safari on iPad");
    expect(deviceNameFromUserAgent(UA.macSafari)).toBe("Safari on macOS");
    expect(deviceNameFromUserAgent(UA.linuxFirefox)).toBe("Firefox on Linux");
  });

  it("does not call Chrome 'Safari' — every Chromium UA also says Safari", () => {
    expect(deviceNameFromUserAgent(UA.macChrome)).toBe("Chrome on macOS");
    expect(deviceNameFromUserAgent(UA.androidChrome)).toBe("Chrome on Android");
  });

  it("does not call Edge 'Chrome' — Edge's UA also says Chrome", () => {
    expect(deviceNameFromUserAgent(UA.winEdge)).toBe("Edge on Windows");
  });

  it("prefers the iOS-specific browser token over the Safari shell", () => {
    // Every iOS browser is WebKit and says Safari; CriOS is what makes it
    // Chrome. Android beats the generic Linux platform for the same reason.
    expect(deviceNameFromUserAgent(UA.iosChrome)).toBe("Chrome on iPhone");
  });

  it("degrades rather than failing on an unknown or empty agent", () => {
    expect(deviceNameFromUserAgent("")).toBe(DEVICE_NAME_FALLBACK);
    expect(deviceNameFromUserAgent("curl/8.7.1")).toBe(DEVICE_NAME_FALLBACK);
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows"); // platform only
  });
});

describe("normalizeDeviceLabel (shared with the server)", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeDeviceLabel("  Theo's   iPad  ")).toBe("Theo's iPad");
  });

  it("strips control characters — the label reaches a log line and another user's screen", () => {
    expect(normalizeDeviceLabel("iPad\n\rmalicious")).toBe("iPad malicious");
    expect(normalizeDeviceLabel("a\u0000b")).toBe("a b");
  });

  it("caps the length", () => {
    expect(normalizeDeviceLabel("x".repeat(200))).toHaveLength(DEVICE_LABEL_MAX);
  });

  it("answers empty for a name with nothing usable in it", () => {
    expect(normalizeDeviceLabel("   ")).toBe("");
    expect(normalizeDeviceLabel("")).toBe("");
  });
});

describe("deviceNameFromUserAgent — the desktop shell", () => {
  const UA = (p: string) =>
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15 SubshellDesktop/1.2.3 (${p}; p=1)`;

  // The webview's own UA still says Safari underneath, so without the marker
  // branch every desktop viewer of a shared subshell shows up as a browser —
  // and this name is visible to everyone the subshell is shared with.
  it("names the shell, not the embedded engine", () => {
    expect(deviceNameFromUserAgent(UA("macos"))).toBe("Subshell Desktop on macOS");
    expect(deviceNameFromUserAgent(UA("linux"))).toBe("Subshell Desktop on Linux");
  });

  it("leaves ordinary browsers exactly as they were", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(deviceNameFromUserAgent(safari)).toBe("Safari on macOS");
  });

  it("ignores a malformed marker rather than naming a half-parsed shell", () => {
    const broken = "Mozilla/5.0 (Macintosh) Safari/605.1.15 SubshellDesktop/1.2.3 (windows; p=1)";
    expect(deviceNameFromUserAgent(broken)).toBe("Safari on macOS");
  });
});

describe("deviceName / setDeviceName", () => {
  afterEach(() => {
    try {
      window.localStorage.removeItem(DEVICE_NAME_KEY);
    } catch {
      // ignore
    }
  });

  it("prefers a stored name over the derived one", () => {
    setDeviceName("Theo's iPad");
    expect(deviceName()).toBe("Theo's iPad");
  });

  it("falls back to the derived name once the override is cleared", () => {
    setDeviceName("Temporary");
    setDeviceName("");
    expect(deviceName()).toBe(deviceNameFromUserAgent(navigator.userAgent ?? ""));
  });

  it("normalizes on the way in, so a stored name is already wire-safe", () => {
    setDeviceName("  spaced   out  ");
    expect(window.localStorage.getItem(DEVICE_NAME_KEY)).toBe("spaced out");
  });

  it("never returns an empty name", () => {
    expect(deviceName().length).toBeGreaterThan(0);
  });

  it("survives storage being denied (private-mode Safari throws on access)", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      expect(() => setDeviceName("nope")).not.toThrow();
      expect(deviceName().length).toBeGreaterThan(0);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
