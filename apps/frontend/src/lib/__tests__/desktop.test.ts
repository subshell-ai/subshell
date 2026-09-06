import { describe, expect, test } from "bun:test";
import { DESKTOP_PROTOCOL, type DesktopShell, parseDesktopUA } from "../desktop";

/**
 * The marker is the only thing standing between "desktop chrome" and "web
 * chrome", and getting it wrong is not a cosmetic failure: the desktop branch
 * renders an overlay titlebar whose drag region the shell has to implement, so
 * a false positive is an unmovable window. Every case here is therefore about
 * failing towards the WEB sidebar.
 */
const UA = {
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 SubshellDesktop/1.2.3 (macos; p=1)",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 SubshellDesktop/0.1.0 (linux; p=1)",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
};

describe("parseDesktopUA", () => {
  test("reads version, platform and protocol out of the suffix", () => {
    expect(parseDesktopUA(UA.macos)).toEqual({
      version: "1.2.3",
      platform: "macos",
      protocol: 1,
    } satisfies DesktopShell);
    expect(parseDesktopUA(UA.linux)).toEqual({ version: "0.1.0", platform: "linux", protocol: 1 });
  });

  test("an ordinary browser is not the desktop shell", () => {
    expect(parseDesktopUA(UA.safari)).toBeNull();
    expect(parseDesktopUA("")).toBeNull();
  });

  // A shell announcing a protocol this build does not know would get desktop
  // chrome whose other half it does not implement — an unmovable window.
  // Degrading to the web sidebar is always safe, so that is the direction.
  test("a FUTURE protocol degrades to the web sidebar", () => {
    const future = UA.macos.replace("p=1", `p=${DESKTOP_PROTOCOL + 1}`);
    expect(parseDesktopUA(future)).toBeNull();
  });

  // An older shell still speaks a protocol this build understands.
  test("an older protocol is still accepted", () => {
    expect(parseDesktopUA(UA.macos.replace("p=1", "p=0"))?.protocol).toBe(0);
  });

  test.each([
    ["no parenthesised part", "SubshellDesktop/1.2.3"],
    ["no protocol", "SubshellDesktop/1.2.3 (macos)"],
    ["unknown platform", "SubshellDesktop/1.2.3 (windows; p=1)"],
    ["non-numeric protocol", "SubshellDesktop/1.2.3 (macos; p=x)"],
    ["no version", "SubshellDesktop/ (macos; p=1)"],
  ])("a malformed marker (%s) is not the desktop shell", (_label, ua) => {
    expect(parseDesktopUA(ua)).toBeNull();
  });

  // The marker must not be forgeable by a substring of some other product's UA.
  test("requires the exact product token, not a substring", () => {
    expect(parseDesktopUA("NotSubshellDesktop/1.2.3 (macos; p=1)")).toBeNull();
  });

  test("tolerates surrounding UA tokens on both sides", () => {
    const ua = `Mozilla/5.0 SubshellDesktop/9.9.9 (linux; p=1) Gecko/20100101`;
    expect(parseDesktopUA(ua)).toMatchObject({ version: "9.9.9", platform: "linux" });
  });

  // The shell builds this string in windows.rs; if the two ever disagree the
  // desktop app silently renders the web sidebar, which is the failure that
  // looks like "nothing happened".
  test("matches the exact shape windows.rs formats", () => {
    const asRustFormats = (v: string, p: string) => `SubshellDesktop/${v} (${p}; p=1)`;
    expect(parseDesktopUA(asRustFormats("1.0.0", "macos"))).toMatchObject({ version: "1.0.0", platform: "macos" });
    expect(parseDesktopUA(asRustFormats("1.0.0", "linux"))).toMatchObject({ version: "1.0.0", platform: "linux" });
  });
});
