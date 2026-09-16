import { afterEach, describe, expect, test } from "bun:test";
import { resetDesktopShellForTests } from "../desktop";
import { desktopLinkClick, installDesktopLinkHandling } from "../desktop-links";

/**
 * The desktop link relay (spec 2026-09-16, the dead docs links).
 *
 * `desktopLinkClick` is the decision and takes the opener as a parameter,
 * so the whole rule tests without a shell, a stubbed `window.open`, or the
 * capture-phase plumbing. The armed/disarmed behaviour of
 * `installDesktopLinkHandling` gets one integration case at the bottom.
 */

function clickOn(anchorHtml: string, init: MouseEventInit = {}): { event: MouseEvent; opened: string[] } {
  const host = document.createElement("div");
  host.innerHTML = anchorHtml;
  document.body.append(host);
  const anchor = host.querySelector("a");
  const target = anchor?.firstElementChild ?? anchor;
  const opened: string[] = [];
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  target?.dispatchEvent(event);
  const acted = desktopLinkClick(event, (url) => opened.push(url));
  expect(acted).toBe(opened.length > 0);
  host.remove();
  return { event, opened };
}

describe("desktopLinkClick", () => {
  test("a plain click on a blank-target https link is relayed and prevented", () => {
    const { event, opened } = clickOn('<a href="https://tailscale.com/kb/1153" target="_blank">Docs ↗</a>');
    expect(opened).toEqual(["https://tailscale.com/kb/1153"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("resolves from the clicked CHILD of the anchor, the case real clicks are", () => {
    const { opened } = clickOn('<a href="http://example.test/x" target="_blank"><span>Docs</span></a>');
    expect(opened).toEqual(["http://example.test/x"]);
  });

  test("http qualifies, and so does the check only for the schemes the native gate accepts", () => {
    expect(clickOn('<a href="mailto:a@b.c" target="_blank">mail</a>').opened).toEqual([]);
    expect(clickOn('<a href="javascript:alert(1)" target="_blank">xss</a>').opened).toEqual([]);
    expect(clickOn('<a href="//bare.example.test/p" target="_blank">proto-relative</a>').opened).toEqual([]);
    expect(clickOn('<a target="_blank">no href</a>').opened).toEqual([]);
  });

  test("an anchor without target=_blank is same-window navigation and not ours", () => {
    expect(clickOn('<a href="https://example.test/">internal</a>').opened).toEqual([]);
  });

  test("modifier and non-primary clicks keep WebKit's own (inert) path", () => {
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { button: 2 },
    ]) {
      expect(clickOn('<a href="https://example.test/" target="_blank">l</a>', init).opened).toEqual([]);
    }
  });

  test("a click something already handled stays handled", () => {
    const host = document.createElement("div");
    host.innerHTML = '<a href="https://example.test/" target="_blank">x</a>';
    document.body.append(host);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    let seen = false;
    host.querySelector("a")?.addEventListener("click", (e) => {
      seen = true;
      e.preventDefault();
    });
    host.querySelector("a")?.dispatchEvent(event);
    expect(seen).toBe(true);
    const opened: string[] = [];
    expect(desktopLinkClick(event, (u) => opened.push(u))).toBe(false);
    expect(opened).toEqual([]);
    host.remove();
  });
});

describe("installDesktopLinkHandling", () => {
  const DESKTOP_UA = "Mozilla/5.0 (Macintosh) SubshellDesktop/1.0.0 (macos; p=1)";
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const off of disposers.splice(0)) off();
    resetDesktopShellForTests();
  });

  test("armed under the desktop marker, one capture listener does the page-wide relay", () => {
    const ua = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", { value: DESKTOP_UA, configurable: true });
    resetDesktopShellForTests();
    disposers.push(installDesktopLinkHandling());
    const opened: string[] = [];
    const prevOpen = window.open;
    (window as { open?: unknown }).open = (u: string) => {
      opened.push(u);
      return null;
    };
    const host = document.createElement("div");
    host.innerHTML = '<a href="https://tailscale.com/kb/1016" target="_blank">Docs</a>';
    document.body.append(host);
    host.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    (window as { open?: unknown }).open = prevOpen;
    host.remove();
    if (ua?.get) Object.defineProperty(navigator, "userAgent", ua);
    expect(opened).toEqual(["https://tailscale.com/kb/1016"]);
  });

  test("an ordinary browser arms nothing", () => {
    // The previous test's afterEach disarmed its listener, so a window.open
    // fired here could only come from THIS install — and it must not.
    const ua = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15",
      configurable: true,
    });
    resetDesktopShellForTests();
    disposers.push(installDesktopLinkHandling());
    const opened: string[] = [];
    const prevOpen = window.open;
    (window as { open?: unknown }).open = (u: string) => {
      opened.push(u);
      return null;
    };
    const host = document.createElement("div");
    host.innerHTML = '<a href="https://tailscale.com/kb/1016" target="_blank">Docs</a>';
    document.body.append(host);
    host.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    (window as { open?: unknown }).open = prevOpen;
    host.remove();
    if (ua?.get) Object.defineProperty(navigator, "userAgent", ua);
    expect(opened).toEqual([]);
  });
});
