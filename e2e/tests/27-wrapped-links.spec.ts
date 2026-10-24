import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent, solePaneId } from "./helpers";

test.use({ storageState: ADMIN_STATE, permissions: ["clipboard-read", "clipboard-write"] });

const SPAWN_TIMEOUT = 30_000;

/**
 * The replay's flattened soft wraps, desktop half. `tmux capture-pane` without
 * `-J` turns every soft wrap into a real newline, so the attach replay hands
 * the viewer a buffer where a long URL's continuation row is its OWN line:
 * the linkifier stops at the head row, a click on the tail does nothing, and
 * a copy of the wrapped run gets a newline spliced into the middle of it.
 * The live byte stream never had that damage (the program's bytes carry no
 * newline), which is why the same assertions run before and after a reload:
 * the live pass pins what already worked, the reload pass is where the fix
 * bites. Mobile copy-mode taps and the native-selection copy joiner are
 * covered by the sibling mobile spec.
 *
 * DOM text is read only to PLACE clicks and drags (the suite rule: never
 * assert the emulator's painting); every assertion here goes through the
 * `window.open` recorder, the clipboard, or the pane log.
 */
const WRAP_URL = `https://wraplink7z.test/a/${"f".repeat(200)}/END42MARKER`;
// The URL's LAST character. Aimed at, not the multi-char marker, because a
// wrap can land inside any string the URL ends with (the mobile spec's grid
// proves it does) while a single character is indivisible at the seam.
// Uppercase letters occur nowhere on screen except inside "END42MARKER"
// (the stub's lines read "tick N"), and the LAST occurrence is the URL's own
// final cell even if the echo ever renders twice. A click that reaches it
// had to join the seam, and a copy that returns it whole carried no newline
// across one.
const TAIL = "R";
const HEAD = "https://wraplink7z.test";

/**
 * The full-match rect of `text` in the terminal's rendered rows: center for a
 * click, edges for a drag. Deliberately finds the LAST occurrence (a retried
 * echo must not steal the aim). Row text is consulted for placement only.
 */
function locate(text: string): { x: number; y: number; left: number; right: number } | null {
  let found: { x: number; y: number; left: number; right: number } | null = null;
  for (const row of Array.from(document.querySelectorAll(".xterm-rows > div"))) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (;;) {
      const node = walker.nextNode() as Text | null;
      if (!node) break;
      // LAST occurrence within the node too: the marker's two R's ride one
      // text node, and the aim must be the URL's final cell, not its middle.
      const i = node.data.lastIndexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + text.length);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      found = { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right };
    }
  }
  return found;
}

/** Record every `window.open` the page attempts, across navigations. */
async function recordOpens(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __opens: string[] };
    w.__opens = [];
    const real = window.open?.bind(window);
    window.open = ((u?: string | URL | null) => {
      w.__opens.push(String(u));
      return real ? (real(u ?? undefined) as Window) : null;
    }) as typeof window.open;
  });
}

test("a soft-wrapped URL links and copies as one line, live and across a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await recordOpens(page);

  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  await dismissDirectoryPanel(page);

  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  await socket;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  const id = await solePaneId(page);
  const logText = async () => {
    const res = await page.request.get(`/api/subshells/${id}/log`);
    if (!res.ok()) return "";
    return ((await res.json()) as { lines: string[] }).lines.join("\n");
  };
  const opens = () => page.evaluate(() => (window as unknown as { __opens: string[] }).__opens);

  /**
   * Echo the URL through the pane just after a fresh tick. The stub harness
   * prints `tick N` every five seconds, and a tick landing mid-echo would
   * splice a REAL line break into the URL, which is not the seam this spec
   * is about. Typing inside the tick window keeps the echo contiguous (the
   * log assertion proves it: a split echo never contains the URL whole).
   */
  async function echoUrl(): Promise<void> {
    const seen = ((await logText()).match(/tick/g) ?? []).length;
    await expect
      .poll(async () => ((await logText()).match(/tick/g) ?? []).length, { timeout: SPAWN_TIMEOUT })
      .toBeGreaterThan(seen);
    await page.request.post(`/api/subshells/${id}/input`, { data: { text: WRAP_URL, submit: true } });
    await expect.poll(logText, { timeout: SPAWN_TIMEOUT }).toContain(WRAP_URL);
  }

  /**
   * Select from `from` to `to` with the mouse, then fire the browser's copy
   * command. `execCommand("copy")` dispatches the same `copy` ClipboardEvent
   * a real Ctrl+C does; a synthesized keystroke cannot be the trigger here
   * because xterm consumes the Ctrl+C keydown itself (measured in this
   * Chromium: no `copy` event ever fires), while the command path reaches
   * xterm's own copy listener exactly as a user's copy does.
   */
  async function copyBand(from: { x: number; y: number }, to: { x: number; y: number }): Promise<string> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => document.execCommand("copy"));
    return await page.evaluate(() => navigator.clipboard.readText());
  }

  await echoUrl();
  await expect.poll(async () => (await page.evaluate(locate, TAIL)) !== null, { timeout: SPAWN_TIMEOUT }).toBe(true);

  // --- LIVE: the byte stream carried the wrap as a seam all along, so these
  //     worked before the fix and must keep working (regression pins) ---
  const headLive = await page.evaluate(locate, HEAD);
  if (!headLive) throw new Error("URL head vanished before the live ctrl+click");
  await page.keyboard.down("Control");
  await page.mouse.click(headLive.x, headLive.y);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await opens()).join("|"), { timeout: 8_000 }).toContain(WRAP_URL);

  const tailLive = await page.evaluate(locate, TAIL);
  if (!tailLive) throw new Error("continuation row missing while the live URL is on screen");
  const copiedLive = await copyBand({ x: headLive.left + 1, y: headLive.y }, { x: tailLive.right - 1, y: tailLive.y });
  expect(copiedLive.trim()).toBe(WRAP_URL);
  expect(copiedLive).not.toContain("\n");

  // --- REPLAY: rebuild the terminal from `capture-pane`. With the seam join
  //     the buffer holds the wraps again; flattened capture used to make the
  //     tail row a separate line, killing the link there and adding a
  //     newline inside every copy ---
  const socket2 = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.reload();
  await socket2;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  await expect.poll(async () => (await page.evaluate(locate, TAIL)) !== null, { timeout: SPAWN_TIMEOUT }).toBe(true);

  // The continuation row must link too, and open the FULL url, not nothing.
  const tail = await page.evaluate(locate, TAIL);
  if (!tail) throw new Error("continuation row missing after the replay");
  await page.keyboard.down("Control");
  await page.mouse.click(tail.x, tail.y);
  await page.keyboard.up("Control");
  const head = await page.evaluate(locate, HEAD);
  if (!head) throw new Error("URL head missing after the replay");
  await page.keyboard.down("Control");
  await page.mouse.click(head.x, head.y);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await opens()).join("|"), { timeout: 8_000 }).toContain(WRAP_URL);
  // And nothing truncated: pre-fix the head row alone would open a URL that
  // stops at the wrap.
  expect(await opens()).toEqual([WRAP_URL, WRAP_URL]);

  const copied = await copyBand({ x: head.left + 1, y: head.y }, { x: tail.right - 1, y: tail.y });
  expect(copied).not.toContain("\n");
  expect(copied.trim()).toBe(WRAP_URL);

  expect((await page.request.post(`/api/subshells/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/subshells/${id}`)).ok()).toBe(true);
});
