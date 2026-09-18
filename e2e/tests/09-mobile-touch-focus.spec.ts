import { type CDPSession, expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/**
 * Real touch, through CDP — `page.touchscreen` would do for the tap, but the
 * swipe needs intermediate moves and both must come from the same pipeline,
 * or the two halves of this contract are not being compared like for like.
 */
async function tap(client: CDPSession, x: number, y: number) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function swipe(client: CDPSession, x: number, y0: number, y1: number) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 6; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 6 }],
    });
    await new Promise((r) => setTimeout(r, 15));
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * Tap types, swipe reads — the phone's whole terminal contract, and the one
 * thing no unit test can answer, because both halves depend on what xterm
 * itself does with a real touch.
 *
 * Both halves have shipped broken, in opposite directions, from the same
 * blind spot. 2026-09-04: every touch raised the keyboard, which the gate in
 * `lib/terminal-touch-scroll.ts` fixed by un-focusing. 2026-09-18: no touch
 * raised it at all — xterm 6's `Gesture` cancels `touchstart` on the grid, so
 * the compatibility `mousedown` it focuses from is never dispatched, and
 * `document.activeElement` stayed at `body`. The gate now focuses on tap
 * itself, and this spec is what keeps those two facts from trading places
 * again.
 *
 * Focus is the observable: a headless browser has no soft keyboard, but
 * "which element holds focus when the finger lifts" is exactly what decides
 * whether iOS shows one.
 */
test("a tap focuses the pane, a swipe does not", async ({ page }) => {
  test.setTimeout(120_000);

  const res = await page.request.post("/api/subshells", {
    data: { harnessId: "pi", workingDir: "/tmp", name: `e2e-touch-focus-${test.info().retry}` },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { id: string }).id;

  await page.goto(`/subshells/${id}`);
  await expect(page.locator(".xterm")).toBeVisible({ timeout: SPAWN_TIMEOUT });
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  // The gate binds with the terminal, and the grid has to have been laid out
  // before a coordinate inside it means anything.
  await expect(page.locator(".xterm-screen")).toBeVisible();

  const client = await page.context().newCDPSession(page);
  const active = () => page.evaluate(() => document.activeElement?.className ?? "");
  const box = async (selector: string) => {
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, selector);
    expect(r, `${selector} is not in the DOM`).not.toBeNull();
    return r as { x: number; y: number; w: number; h: number };
  };

  const grid = await box(".xterm-screen");
  const cx = grid.x + grid.w / 2;
  const cy = grid.y + grid.h / 2;

  await tap(client, cx, cy);
  await expect.poll(active).toContain("xterm-helper-textarea");

  await swipe(client, cx, grid.y + grid.h - 60, grid.y + 60);
  await expect.poll(active).not.toContain("xterm-helper-textarea");

  // The third case — a touch on xterm 6's scrollbar (a `.xterm-slider` inside
  // a `.xterm-scrollbar` SIBLING of `.xterm-viewport`, which is why the gate
  // matches both selectors) — is asserted in
  // `apps/server/web/src/lib/__tests__/terminal-touch-scroll.test.ts` and not
  // here. The strip is faded out with `pointer-events: none` until something
  // scrolls, so on a quiet pane a tap at those coordinates correctly reaches
  // the grid, and a spec asserting otherwise would be testing xterm's fade
  // timing rather than the gate.

  // Clean up after itself (shared-DB ordering contract).
  expect((await page.request.post(`/api/subshells/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/subshells/${id}`)).ok()).toBe(true);
});
