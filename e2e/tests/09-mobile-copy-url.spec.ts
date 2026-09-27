import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;
// A host nothing else prints, with a scheme — the tap opens only http(s), so
// a schemeless token is correctly refused (that was my first false failure).
const URL_MARKER = "https://copyurl.test/zz";
const TYPE_TOKEN_ON = "zztypedon9";
const TYPE_TOKEN_OFF = "zztypedoff9";

/**
 * Issue #242 has no browser coverage of its own — copy mode and tap-to-open
 * lived only in unit tests until this file. It drives a real Chromium on the
 * coarse-pointer (iPhone) project, so the `isTouchUi` gates that arm copy mode
 * actually open.
 *
 * Proven here in a real browser: the menu toggle flips the mode (label + the
 * `.copy-mode` class), typing is suppressed while it is on (keystrokes never
 * reach the pane), the key bar drops its byte keys to scroll-only, a clean tap
 * on an `https` token runs the shipped `terminalUrlAtPoint` → scheme gate →
 * `window.open`, and a trusted drag-select captures the URL.
 *
 * Deliberately NOT here (both recorded, not skipped silently): the iOS
 * long-press copy CALLout needs a real finger — Chromium ignores a synthetic
 * touch-hold, and this suite cannot fake the native callout; and real-finger
 * touch FIDELITY is why the tap is a faithful dispatched `TouchEvent` (the
 * shield reads `changedTouches` + layout, never `isTrusted`), not a
 * `touchscreen.tap`. Wide/CJK tap accuracy is the `terminal-url-tap` unit
 * test's job: the e2e `pi` stub echoes stdin through `cat -v`, which escapes
 * multibyte bytes, so glyphs the harness printed could not be shown faithfully.
 */

/**
 * The pixel-center of a substring of the terminal's rendered text, computed
 * with a Range (xterm's DOM renderer keeps row text in the document). The tap
 * and the selection-drag are placed from this, not from a guessed column —
 * a CJK or wide run shifts every naive cell math, and the whole point of the
 * buffer-driven tap is that the finger, not an index, decides the token.
 */
function locate(text: string): { x: number; y: number; left: number; right: number } | null {
  const rows = document.querySelectorAll(".xterm-rows > div");
  for (const row of Array.from(rows)) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (;;) {
      const node = walker.nextNode() as Text | null;
      if (!node) break;
      const i = node.data.indexOf(text);
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + Math.min(text.length, 3));
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const full = document.createRange();
        full.selectNodeContents(node);
        const fr = full.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: fr.left, right: fr.right };
      }
    }
  }
  return null;
}

test("copy mode turns typing off, drag selects a URL, and a clean tap opens it (issue 242)", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  await dismissDirectoryPanel(page);

  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
  await tokenRes;
  await socket;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const logText = async () => {
    const res = await page.request.get(`/api/subshells/${id}/log`);
    if (!res.ok()) return "";
    const body = (await res.json()) as { lines: string[] };
    return body.lines.join("\n");
  };

  // window.open is the whole effect of a tap on a URL; record every call.
  await page.evaluate(() => {
    const w = window as unknown as { __opens: string[] };
    w.__opens = [];
    const real = window.open?.bind(window);
    window.open = ((u?: string | URL) => {
      (window as unknown as { __opens: string[] }).__opens.push(String(u));
      return real ? (real(u) as Window) : null;
    }) as typeof window.open;
  });

  // Ground the log reader with a POSITIVE echo first (typing works now), so a
  // later "did not echo" cannot be a broken reader pretending to be a disable.
  await expect
    .poll(
      async () => {
        await page.request.post(`/api/subshells/${id}/input`, {
          data: { text: `open ${URL_MARKER} now ${TYPE_TOKEN_ON}`, submit: true },
        });
        return await logText();
      },
      { timeout: SPAWN_TIMEOUT },
    )
    .toContain(TYPE_TOKEN_ON);

  // The URL must be on screen before a tap can aim at it.
  await expect
    .poll(async () => (await page.evaluate(locate, URL_MARKER)) !== null, { timeout: SPAWN_TIMEOUT })
    .toBe(true);

  // --- typing OFF while copy mode is on, ON while off (the disableStdin OR) ---
  const actions = page.getByRole("button", { name: /^Actions for / });
  await actions.click();
  await page.getByRole("menuitem", { name: "Enable text copying" }).click();
  await expect(page.locator(".copy-mode")).toHaveCount(1);
  // The key bar goes scroll-only in copy mode (suppressInput): the byte-sending
  // keys are gone, so a thumb can drag-select without firing keystrokes.
  await expect(
    page.getByRole("toolbar", { name: "Terminal special keys" }).getByRole("button", { name: "Send Ctrl-C" }),
  ).toHaveCount(0);
  // Same gesture, now inert: type ONLY through the browser path (an API
  // `input` post is server-side sendInput and would land regardless of the
  // UI gate, so it cannot be the probe). With copy mode the key must not
  // reach the pane.
  await page
    .locator(".xterm .xterm-helper-textarea")
    .click({ force: true })
    .catch(() => {});
  await page.keyboard.type(TYPE_TOKEN_OFF);
  const echoed = await Promise.race([
    expect
      .poll(async () => (await logText()).includes(TYPE_TOKEN_OFF), { timeout: 4_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  expect(echoed, "keystrokes must not reach the pane while copy mode is on").toBe(false);

  // --- a clean tap on the URL opens it (touch tap → buffer token → open) ---
  // The copy-mode shield listens in CAPTURE on the terminal root and runs the
  // app's real `terminalUrlAtPoint(term, clientX, clientY)`; it reads
  // `changedTouches[0]` and layout, never `isTrusted`. Playwright's
  // `touchscreen.tap` does not satisfy its single-finger clean-tap semantics
  // (a real-device gap, already flagged), so drive one faithful touchstart →
  // touchend at the URL's own pixel. Everything downstream — cell→token→
  // scheme-gate→open — is the shipped code, against the real rendered buffer.
  await page.evaluate((marker) => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    let cx = 0;
    let cy = 0;
    outer: for (const row of Array.from(rows)) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (;;) {
        const node = walker.nextNode() as Text | null;
        if (!node) break;
        const i = node.data.indexOf(marker);
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(node, i + 1);
          r.setEnd(node, i + 3);
          const box = r.getBoundingClientRect();
          cx = box.left + box.width / 2;
          cy = box.top + box.height / 2;
          break outer;
        }
      }
    }
    // Dispatch on a GUARANTEED descendant of the shield's root so the CAPTURE
    // listener fires; elementFromPoint can return a transparent overlay that
    // is not under that root, and then the shield never sees the touch.
    const el = document.querySelector(".xterm-screen") ?? document.querySelector(".xterm") ?? document.body;
    const touch = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
    el.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
    el.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
      }),
    );
  }, URL_MARKER);
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as { __opens: string[] }).__opens)).join("|"), {
      timeout: 8_000,
    })
    .toContain(URL_MARKER);

  // --- drag-select: copy mode lets the finger (here a trusted mouse drag)
  //     select text; the browser's own selection carries the URL substring ---
  const rect = await page.evaluate(locate, URL_MARKER);
  if (!rect) throw new Error("URL vanished from the buffer before the selection drag");
  await page.mouse.move(rect.left + 2, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 2, rect.y);
  await page.mouse.up();
  const selected = (await page.evaluate(() => window.getSelection()?.toString() ?? "")) as string;
  expect(selected).toContain("copyurl.test");

  // Toggle back: typing returns.
  await actions.click();
  await page.getByRole("menuitem", { name: "Enable text input" }).click();
  await expect(page.locator(".copy-mode")).toHaveCount(0);

  expect((await page.request.post(`/api/subshells/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/subshells/${id}`)).ok()).toBe(true);
});
