import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, newPaneId, pickAgent } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/**
 * The scroll keys under touch input, in the forced-tab presentation. Earlier
 * key-bar proofs used Playwright's `.click()`, which dispatches MOUSE events
 * even in the touch-enabled mobile project; this spec taps with
 * `page.touchscreen` — the CDP touch chain a thumb actually runs — and
 * asserts the PANE'S OWN buffer moved: the scroll jumps drive local
 * scrollback, which the server-side log the byte-key specs read cannot see.
 *
 * What this spec does NOT gate is the engine difference the pointerup fix
 * answered. The mobile project is Chromium, and a measured Blink tap still
 * synthesizes the click after the bar's cancelled `onPointerDown`, so a
 * control that waited for the click would stay green here. Only WebKit drops
 * that click; the suppression stays pinned by the unit suite's gesture
 * tests, and the playwright config still names real-device Safari the
 * manual gate.
 *
 * The witness is xterm's scroll thumb. In the 6.1 DOM the legacy
 * `.xterm-viewport` never scrolls at all (measured: `scrollHeight ===
 * clientHeight` at rest), while `.xterm-slider` inside the vertical
 * `.xterm-scrollbar` is positioned by `style.top` against the buffer —
 * exactly `0px` at the scrollback top, a fixed value at the bottom. Late
 * output can repaint a first row and fake a row comparison; it cannot move
 * the thumb up.
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

  // A red assertion must not leave the pane running in the shared database
  // for whichever spec reads it next, so the whole scenario is best-effort
  // cleaned in the finally. The lookup itself is inside the try: the pane
  // exists the moment the launch lands, so a dead `newPaneId` must still
  // sweep the ids the spawn added rather than orphan the process.
  let id = "";
  try {
    id = await newPaneId(page, before);
    await exerciseScrollKeys(page, id);
  } finally {
    let strays = id ? [id] : [];
    if (strays.length === 0) {
      const res = await page.request.get("/api/subshells").catch(() => null);
      if (res?.ok()) {
        strays = ((await res.json()) as { id: string }[]).filter((s) => !before.has(s.id)).map((s) => s.id);
      }
    }
    for (const pane of strays) {
      await page.request.post(`/api/subshells/${pane}/terminate`).catch(() => null);
      await page.request.delete(`/api/subshells/${pane}`).catch(() => null);
    }
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

  // Server-side truth that the text reached the pane — the same log tail
  // the byte-key specs read. Not proof of an idle prompt: the tty echo of
  // the typed command alone already contains the sentinels.
  const logText = async () => {
    const res = await page.request.get(`/api/subshells/${id}/log`);
    return res.ok() ? ((await res.json()) as { lines: string[] }).lines.join("\n") : "";
  };
  await expect.poll(async () => (await logText()).includes("100"), { timeout: SPAWN_TIMEOUT }).toBe(true);
  await expect.poll(async () => (await logText()).includes("SCROLL_TEST_DONE"), { timeout: SPAWN_TIMEOUT }).toBe(true);

  const bar = page.getByRole("toolbar", { name: "Terminal special keys" });
  await expect(bar).toBeVisible();
  await expect(bar).toBeInViewport();
  // The WebSocket upgrade can arrive before the pane publishes its terminal
  // handles. Wait for the connected state so a scroll tap can't race the
  // terminal's onReady effect.
  await expect(bar.getByRole("button", { name: "Send Enter" })).toBeEnabled({ timeout: SPAWN_TIMEOUT });

  // xterm moves the thumb asynchronously after any scroll: every read goes
  // through `expect.poll`, never a bare synchronous read (that false-negatived
  // in development of this spec).
  const sliderTop = async () => {
    const terminal = bar.locator("xpath=../div[1]");
    const screen = terminal.locator(".xterm-screen");
    const box = await screen.boundingBox();
    if (box) await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    return terminal
      .locator(".xterm-scrollbar.xterm-vertical .xterm-slider")
      .first()
      .evaluate((el) => {
        const thumb = el as HTMLElement;
        return {
          top: thumb.style.top === "" ? -1 : Math.round(parseFloat(thumb.style.top)),
          visible: thumb.parentElement?.classList.contains("xterm-visible") ?? false,
        };
      });
  };

  // Two consecutive reads agree, so the stream has stopped. The thumb's
  // inline position is the bottom anchor; its visibility class is transient
  // on touch browsers and isn't part of the scroll behavior. xterm measures
  // the top anchor at exactly `0px`, so no direction convention is guessed.
  let resting = -1;
  await expect
    .poll(
      async () => {
        const s = await sliderTop();
        const settled = s.visible && s.top >= 0 && s.top === resting;
        resting = s.top;
        return settled;
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
    // Locator.tap keeps using a touch input in this project and re-checks the
    // target after scrolling, so a late bar shift can't turn the tap into a
    // touch on the surrounding terminal.
    await button.tap();
  };

  // Known positions, not mere "it moved": the thumb sits at 0px at the top,
  // returns to the exact resting value at the bottom, and a page jump lands
  // strictly between (the 100-line scrollback overflows a page on any
  // viewport this spec runs on). Only scrolling moves the thumb.
  const bottom = resting;
  const at = async () => (await sliderTop()).top;

  // The settle loop's `top >= 0` rule keeps reading here too: the sentinel
  // (-1, thumb with no inline top, e.g. a terminal mid-remount) must not
  // satisfy "< bottom" and pass this jump without the buffer having moved.
  await tap("Scroll page up");
  await expect
    .poll(
      async () => {
        const t = await at();
        return t >= 0 && t < bottom;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  await tap("Scroll to top");
  await expect.poll(async () => (await at()) === 0, { timeout: 10_000 }).toBe(true);

  await tap("Scroll page down");
  await expect
    .poll(
      async () => {
        const t = await at();
        return t > 0 && t < bottom;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  await tap("Scroll to bottom");
  await expect.poll(async () => (await at()) === bottom, { timeout: 10_000 }).toBe(true);
}
