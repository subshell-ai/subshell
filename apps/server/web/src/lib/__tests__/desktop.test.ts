import { afterEach, describe, expect, test } from "bun:test";
import {
  DESKTOP_PROTOCOL,
  type DesktopShell,
  isDesktop,
  isServerDesktop,
  parseDesktopUA,
  resetDesktopShellForTests,
} from "../desktop";

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
      app: "server",
      version: "1.2.3",
      platform: "macos",
      protocol: 1,
    } satisfies DesktopShell);
    expect(parseDesktopUA(UA.linux)).toEqual({ app: "server", version: "0.1.0", platform: "linux", protocol: 1 });
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

/**
 * The bundled-server group (spec 2026-09-12 § 5.4) is OPTIONAL, and the
 * absence of it is the case that has to keep working: every shell built
 * before that spec sends the three-field marker, and a regex that demanded
 * the fourth would read those as "not desktop" and render web chrome in a
 * desktop window.
 */
describe("parseDesktopUA: the bundled server version", () => {
  test("reads the optional bundled-server group and tolerates its absence", () => {
    expect(parseDesktopUA("X SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)")).toEqual({
      app: "server",
      version: "0.2.0",
      platform: "macos",
      protocol: 1,
      bundledServer: "0.3.0",
    });
    expect(parseDesktopUA("X SubshellDesktop/0.2.0 (linux; p=1)")).toEqual({
      app: "server",
      version: "0.2.0",
      platform: "linux",
      protocol: 1,
    });
  });
});

/**
 * Two shells speak this marker now, and one of them must NOT switch on the
 * server-only chrome.
 *
 * `apps/client/desktop`'s plane window used to carry no marker at all,
 * precisely so the SPA would never take a desktop branch there: it is granted
 * almost nothing, it keeps a normal title bar, and there is no
 * `subshell-server` behind it to update, reset or supervise. It carries one
 * now — `SubshellClient/…` — because two pieces of chrome are true of ANY
 * shell (open this page in a real browser, from the rail and from a
 * subshell's menu), and the page cannot offer them without knowing it is in
 * one.
 *
 * So "desktop" split into two questions, and these tests are what keeps them
 * apart: `isDesktop()` is "am I in a shell at all", `isServerDesktop()` is "am
 * I in the shell that manages the server serving me". Every gate that predates
 * this means the SECOND.
 */
describe("the two shells", () => {
  test("Subshell Client parses, and names itself the client", () => {
    expect(parseDesktopUA("Mozilla/5.0 SubshellClient/0.3.0 (macos; p=1)")).toEqual({
      app: "client",
      version: "0.3.0",
      platform: "macos",
      protocol: 1,
    } satisfies DesktopShell);
  });

  test("Subshell Server still names itself the server", () => {
    expect(parseDesktopUA(UA.macos)?.app).toBe("server");
    expect(parseDesktopUA(UA.linux)?.app).toBe("server");
  });

  // The client ships no server, so it can never carry a bundled-server group —
  // `user_agent_for` there has no parameter for one. Stated here too, because
  // the Update card's whole gate is that field.
  test("the client's marker carries no bundled server", () => {
    expect(parseDesktopUA("SubshellClient/0.3.0 (linux; p=1)")?.bundledServer).toBeUndefined();
  });

  // Both tokens are matched WHOLE. A client marker read as a server one would
  // put the update, reset and supervision cards in a window that can drive
  // none of them.
  test("neither token matches as a substring of another product", () => {
    expect(parseDesktopUA("NotSubshellClient/0.3.0 (macos; p=1)")).toBeNull();
    expect(parseDesktopUA("SubshellClientX/0.3.0 (macos; p=1)")).toBeNull();
    expect(parseDesktopUA("Subshell/0.3.0 (macos; p=1)")).toBeNull();
  });

  // An unknown protocol still degrades to the web sidebar, whichever app sent
  // it — the reason did not change with the second product token.
  test("an unknown protocol is not a shell, in either app", () => {
    expect(parseDesktopUA(`SubshellClient/0.3.0 (macos; p=${DESKTOP_PROTOCOL + 1})`)).toBeNull();
    expect(parseDesktopUA(`SubshellDesktop/0.3.0 (macos; p=${DESKTOP_PROTOCOL + 1})`)).toBeNull();
  });
});

describe("isDesktop vs isServerDesktop", () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  let previous: PropertyDescriptor | undefined;

  function withUA(userAgent: string) {
    previous ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
    Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
    resetDesktopShellForTests();
  }

  // Bun runs every test FILE in one process, so a UA left overwritten here is
  // the one the next file's components read.
  afterEach(() => {
    if (previous) Object.defineProperty(nav, "userAgent", previous);
    else delete nav.userAgent;
    previous = undefined;
    resetDesktopShellForTests();
  });

  test("Subshell Client is a desktop shell but not the SERVER's", () => {
    withUA("Mozilla/5.0 SubshellClient/0.3.0 (macos; p=1)");
    expect(isDesktop()).toBe(true);
    expect(isServerDesktop()).toBe(false);
  });

  test("Subshell Server is both", () => {
    withUA(UA.macos);
    expect(isDesktop()).toBe(true);
    expect(isServerDesktop()).toBe(true);
  });

  test("a browser is neither", () => {
    withUA(UA.safari);
    expect(isDesktop()).toBe(false);
    expect(isServerDesktop()).toBe(false);
  });
});
