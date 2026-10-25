import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, newPaneId, pickAgent } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/**
 * The scroll keys under a real finger, in the forced-tab presentation. Every
 * earlier key-bar proof used Playwright's `.click()`, which dispatches MOUSE
 * events even in the touch-enabled mobile project — the bar's deliberate
 * `onPointerDown` preventDefault only interacts with the browser's
 * touch-to-click synthesis, so the mouse path could never have caught the
 * suppression break. This spec taps with `page.touchscreen` (CDP touch
 * events, the chain a thumb actually runs) and asserts the PANE'S OWN buffer
 * moved: the scroll jumps drive local scrollback, which the server-side log
 * the byte-key specs read cannot see. The DOM renderer paints exactly the
 * visible rows, so the first line of `.xterm-rows` is the top row the user
 * sees.
 */
test("key bar scroll buttons scroll the pane under real touch", async ({ page }) => {
  test.setTimeout(180_000);

  const before = new Set(
    ((await (await page.request.get("/api/subshells")).json()) as { id: string }[]).map((s) => s.id),
  );

  // The Terminal harness, not pi: the stub harness only echoes stdin, so
  // `seq` there prints the typed command and never the numbers. A plain
  // shell actually runs it, which is what fills the scrollback.
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "Terminal");
  await page.fill("#picker-working-dir", "/tmp");
  // The DirectoryPickerInput opens on focus and drops its panel over the
  // fields below (spec 09's comment: Escape would take the whole form).
  await dismissDirectoryPanel(page);

  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  await socket;

  const id = await newPaneId(page, before);
  // A red assertion must not leave the pane running in the shared database
  // for whichever spec reads it next, so the whole scenario is best-effort
  // cleaned in the finally.
  try {
    await exerciseScrollKeys(page, id);
  } finally {
    await page.request.post(`/api/subshells/${id}/terminate`).catch(() => null);
    await page.request.delete(`/api/subshells/${id}`).catch(() => null);
  }
});

async function exerciseScrollKeys(page: Page, id: string): Promise<void> {
  // Scrollback arrives through REST, not the bar: the input route brackets
  // the text when a pane asks for bracketed paste while the handles'
  // `sendInput` deliberately does not, and one input-transport break must
  // not be able to mask (or fake) a scroll result.
  const send = async (text: string) => {
    const res = await page.request.post(`/api/subshells/${id}/input`, { data: { text, submit: true } });
    expect(res.ok(), text).toBe(true);
  };
  await send("seq 1 100");
  await send("SCROLL_TEST_DONE");

  // Server-side truth that the output landed and the shell is back at a
  // prompt — the same log tail spec 09's byte assertions read.
  const logText = async () => {
    const res = await page.request.get(`/api/subshells/${id}/log`);
    return res.ok() ? ((await res.json()) as { lines: string[] }).lines.join("\n") : "";
  };
  await expect.poll(async () => (await logText()).includes("100"), { timeout: SPAWN_TIMEOUT }).toBe(true);
  await expect.poll(async () => (await logText()).includes("SCROLL_TEST_DONE"), { timeout: SPAWN_TIMEOUT }).toBe(true);

  const bar = page.getByRole("toolbar", { name: "Terminal special keys" });
  await expect(bar).toBeVisible();
  await expect(bar).toBeInViewport();

  // xterm repaints asynchronously after any scroll: every read goes through
  // `expect.poll`, never a bare synchronous read (that false-negatived in
  // development of this spec).
  const topRow = async () =>
    (await page.locator(".xterm-rows").evaluate((el) => (el as HTMLElement).innerText.split("\n")[0] ?? "")).trim();

  // Resting state: two consecutive NON-EMPTY reads agree, so the stream has
  // stopped. Empty is not "settled at the bottom" — the first run captured
  // "" twice while the renderer had not painted the rows yet, and every
  // later "did it move" comparison then measured against a blank.
  let bottomTop = "";
  await expect
    .poll(
      async () => {
        const row = await topRow();
        const same = row !== "" && row === bottomTop;
        bottomTop = row;
        return same;
      },
      { timeout: SPAWN_TIMEOUT, message: "the terminal settles at the bottom" },
    )
    .toBe(true);

  const tap = async (label: string) => {
    const button = bar.getByRole("button", { name: label });
    // The scroll fieldset overflows the 393px bar (measured first run: the
    // page-up button starts at viewport ratio 0). A thumb pans the bar
    // first; the scroller is exempt from the foreign-scroll pin, so the pan
    // must stick for the buttons to be reachable at all.
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    const box = await button.boundingBox();
    if (!box) throw new Error(`key bar button "${label}" has no bounding box`);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };

  await tap("Scroll page up");
  await expect.poll(async () => (await topRow()) !== bottomTop, { timeout: 10_000 }).toBe(true);
  const pageUpTop = await topRow();

  await tap("Scroll to top");
  await expect.poll(async () => (await topRow()) !== pageUpTop, { timeout: 10_000 }).toBe(true);
  const topTop = await topRow();

  await tap("Scroll page down");
  await expect.poll(async () => (await topRow()) !== topTop, { timeout: 10_000 }).toBe(true);

  await tap("Scroll to bottom");
  await expect.poll(topRow, { timeout: 10_000 }).toBe(bottomTop);
}
