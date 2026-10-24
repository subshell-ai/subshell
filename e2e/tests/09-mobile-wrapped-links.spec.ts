import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent, solePaneId } from "./helpers";

test.use({ storageState: ADMIN_STATE, permissions: ["clipboard-read", "clipboard-write"] });

const SPAWN_TIMEOUT = 30_000;

/**
 * The mobile half of the soft-wrap seam fix, on the coarse-pointer project.
 * A phone reaches a printed URL almost always through the REPLAY: the page
 * loads after the pane printed, and `capture-pane` (before the `-J` join)
 * flattened every soft wrap into a hard newline. Two things died there, and
 * this spec drives both against the real rendered buffer after a reload:
 *
 * - tap-to-open: a tap on either row of the wrapped URL used to yield only
 *   that row's fragment (or nothing on the tail), so long links "did not
 *   trigger at all". The seam walk in `terminal-url-tap` joins the chain in
 *   both directions, so both taps must open the FULL url.
 * - copy mode's copy: the browser's native selection copied the DOM's row
 *   serialization, newline per LAYOUT break. The copy-time joiner rebuilds
 *   the string from the buffer's `isWrapped` facts, so the clipboard gets
 *   one clean line.
 *
 * The touch taps are faithful dispatched `TouchEvent`s (same shape as
 * 09-mobile-copy-url: the shield reads `changedTouches` + layout, never
 * `isTrusted`). The DOM is consulted only to PLACE gestures and to name the
 * rows a copy slices — the copy assertion is about the CLIPBOARD's join
 * shape (no newline at the seam), and the row slices only say which text the
 * drag covered; nothing here asserts the emulator's painting. Assertions go
 * through the `window.open` recorder and the clipboard.
 */
const WRAP_URL = `https://wraplink7z.test/m/${"q".repeat(200)}/END42MARKER`;
const HEAD = "https://wraplink7z.test";

/**
 * Geometry for the first seam, read structurally rather than by hunting a
 * marker string: the phone grid is ~46 columns, narrow enough that a wrap can
 * land INSIDE any marker the URL ends with, so no string is guaranteed to sit
 * whole on the continuation row. The row after the URL's head row is a
 * continuation row by construction (the URL fills every row between them).
 */
interface SeamGeometry {
  /** Head row: center for the DOWN tap, left edge for the copy start. */
  head: { x: number; y: number; left: number };
  /** Continuation row: center for the UP tap (its cells are URL text). */
  cont: { x: number; y: number };
  /** Copy drag: the URL's first char on the head row to ~10 chars into the
   * continuation row. */
  copy: { fromX: number; fromY: number; toX: number; toY: number };
  /** The head row's URL text: every clean copy of the seam starts with it. */
  headText: string;
  /** The first ten continuation-row chars: the copy contributes nine or ten
   * of these (px-to-cell rounding decides which), joined to `headText` with
   * nothing between. */
  contChars: string;
}

/** Center + edges of the LAST rendering of `head`, plus the row beneath it. */
function seamGeometry(head: string): SeamGeometry | null {
  let found: SeamGeometry | null = null;
  const rows = Array.from(document.querySelectorAll(".xterm-rows > div"));
  for (let i = 0; i + 1 < rows.length; i++) {
    const headRow = rows[i]!;
    const walker = document.createTreeWalker(headRow, NodeFilter.SHOW_TEXT);
    for (;;) {
      const node = walker.nextNode() as Text | null;
      if (!node) break;
      const j = node.data.indexOf(head);
      if (j < 0) continue;
      const range = document.createRange();
      range.setStart(node, j);
      range.setEnd(node, j + head.length);
      const hr = range.getBoundingClientRect();
      if (hr.width === 0 && hr.height === 0) continue;
      const contRow = rows[i + 1]!;
      const contNode = document.createTreeWalker(contRow, NodeFilter.SHOW_TEXT).nextNode() as Text | null;
      // Ten URL chars make the copy's expected slice; a shorter run means
      // this head render ends too early to aim the drag.
      if (!contNode || contNode.data.length < 10) continue;
      const contRange = document.createRange();
      contRange.setStart(contNode, 0);
      contRange.setEnd(contNode, 10);
      const cr = contRange.getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) continue;
      const contRect = contRow.getBoundingClientRect();
      const headText = headRow.textContent ?? "";
      found = {
        head: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2, left: hr.left },
        cont: { x: contRect.left + contRect.width / 2, y: contRect.top + contRect.height / 2 },
        copy: {
          fromX: hr.left + 2,
          fromY: hr.top + hr.height / 2,
          // 95% of the ten-char span: inside the last cell of the run, so
          // the drag cannot round past it.
          toX: cr.left + cr.width * 0.95,
          toY: cr.top + cr.height / 2,
        },
        headText: headText.slice(headText.indexOf(head)),
        contChars: contNode.data.slice(0, 10),
      };
    }
  }
  return found;
}

/**
 * One-finger clean tap as the copy-mode shield expects it: a real
 * `TouchEvent` pair at one point on a guaranteed descendant of the shield's
 * root. `touchscreen.tap` does not satisfy the shield's single-finger clean
 * tap semantics (the gap recorded in 09-mobile-copy-url).
 */
async function touchTap(page: import("@playwright/test").Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([cx, cy]) => {
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
    },
    [x, y],
  );
}

test("a wrapped URL taps open whole and copies clean after a replay (mobile)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __opens: string[] };
    w.__opens = [];
    const real = window.open?.bind(window);
    window.open = ((u?: string | URL | null) => {
      w.__opens.push(String(u));
      return real ? (real(u ?? undefined) as Window) : null;
    }) as typeof window.open;
  });

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

  // Type just after a fresh tick so the stub's 5 s tick cannot splice a REAL
  // line break into the echo (the contiguous log match proves it did not).
  const seen = ((await logText()).match(/tick/g) ?? []).length;
  await expect
    .poll(async () => ((await logText()).match(/tick/g) ?? []).length, { timeout: SPAWN_TIMEOUT })
    .toBeGreaterThan(seen);
  await page.request.post(`/api/subshells/${id}/input`, { data: { text: WRAP_URL, submit: true } });
  await expect.poll(logText, { timeout: SPAWN_TIMEOUT }).toContain(WRAP_URL);

  // --- replay: rebuild the page so every assertion below runs against
  //     captured-and-replayed rows, the surface a phone actually reads ---
  const socket2 = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.reload();
  await socket2;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  await expect
    .poll(async () => (await page.evaluate(seamGeometry, HEAD)) !== null, { timeout: SPAWN_TIMEOUT })
    .toBe(true);

  // Copy mode on: input off, native selection and taps live.
  expect(await page.locator(".copy-mode").count()).toBe(0);
  await page.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Enable text copying" }).click();
  await expect(page.locator(".copy-mode")).toHaveCount(1);

  // A tap on the continuation row must walk UP the seam chain and open the
  // whole URL; a tap on the head row must walk DOWN and do the same.
  const seam = await page.evaluate(seamGeometry, HEAD);
  if (!seam) throw new Error("the wrapped URL's head row vanished after the replay");
  await touchTap(page, seam.cont.x, seam.cont.y);
  await touchTap(page, seam.head.x, seam.head.y);
  await expect.poll(async () => (await opens()).join("|"), { timeout: 8_000 }).toContain(WRAP_URL);
  // Neither tap may open a fragment of it.
  expect(await opens()).toEqual([WRAP_URL, WRAP_URL]);

  // Copy mode's copy must carry one line, not the DOM's row serialization:
  // drag across the first seam, then fire the browser's copy command (the
  // same `copy` ClipboardEvent a real copy gesture dispatches; a synthesized
  // Ctrl+C keypress is consumed by xterm before any copy event fires). The
  // expected text comes from the rendered rows' own slices, so the check is
  // exact about the seam and indifferent to the grid width: the head row's
  // URL text, then nine or ten continuation chars (px-to-cell rounding
  // decides which), with NOTHING between. An unjoined copy would carry a
  // newline at the seam or the rows' whitespace padding instead of text.
  await page.mouse.move(seam.copy.fromX, seam.copy.fromY);
  await page.mouse.down();
  await page.mouse.move(seam.copy.toX, seam.copy.toY, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => document.execCommand("copy"));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).not.toContain("\n");
  expect(copied.startsWith(seam.headText)).toBe(true);
  const extra = copied.slice(seam.headText.length);
  expect(extra.length).toBeGreaterThanOrEqual(9);
  expect(extra.length).toBeLessThanOrEqual(10);
  expect(extra).toBe(seam.contChars.slice(0, extra.length));

  expect((await page.request.post(`/api/subshells/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/subshells/${id}`)).ok()).toBe(true);
});
