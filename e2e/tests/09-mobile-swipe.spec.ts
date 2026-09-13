import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/** The fields the order oracle reads (camelCase API shape). */
interface Row {
  id: string;
  alive: boolean;
  createdAt: string;
}

/**
 * The CONTRACT the swipe walks: newest-created first. Nothing else.
 *
 * Deliberately not a copy of `lib/subshell-order.ts` — an earlier version of
 * this helper reproduced that function character for character, guard clauses
 * and tie-break included, while claiming to be independent. A copied oracle
 * can only ever catch a wiring mistake; it agrees with the implementation
 * about everything else by construction, including about being wrong. So this
 * states the one property the feature promises and leaves the rest alone: the
 * caller asserts there are no `createdAt` ties, so the test never depends on
 * how ties are broken and cannot silently encode that rule either.
 *
 * It is also deliberately not the SIDEBAR's band order
 * (`lib/subshell-indicator.ts`, which ranks by `activity` = "produced output
 * within the last 60s"). This helper did model the bands, and agreed with the
 * swipe only for as long as every row sat in the same one — so a leftover
 * subshell from an earlier spec printing a line put it in a different band,
 * the helper named a different neighbour than the swipe walked to, and the
 * run failed with no bad code anywhere. Navigation order must not move on its
 * own, which is why the feature left the bands; this had not followed.
 */
function newestFirst(rows: readonly Row[]): Row[] {
  return [...rows].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
}

/** Dispatch a horizontal touch drag through CDP — the only way to deliver
 * real touch events (which is what the gesture binds to) in headless. */
async function swipe(client: CDPSession, fromX: number, toX: number, y: number) {
  const steps = 10;
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await new Promise((r) => setTimeout(r, 15));
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * Navigate to a subshell and wait until a SWIPE there can actually do
 * something.
 *
 * `.xterm` appearing is not that signal. The gesture's target is computed
 * from the subshell LIST (`useSwipeOrderedSubshells`), and on a fresh page
 * load that query has to come back before prev/next exist at all — until
 * then a swipe is silently a no-op, because `findNeighbors` has nothing to
 * offer. The terminal mounts first, so waiting on it races the thing the test
 * is about: measured here, the right-swipe did nothing and the page sat on
 * the subshell it started from, roughly two runs in five.
 *
 * The response waiter is armed BEFORE `goto`, or it can miss a fetch that has
 * already landed.
 */
async function gotoSubshell(page: Page, id: string): Promise<void> {
  await page.goto(`/subshells/${id}`);
  await swipeReady(page);
}

/**
 * Waits until the pane will actually respond to a swipe.
 *
 * `data-swipe-nav="ready"` is set by `useSwipeNav` in the same effect that
 * binds the gesture, so it cannot claim ready while the listeners are off.
 * Everything softer than this raced: `.xterm` visible is true long before the
 * subshell list has loaded (no neighbours ⇒ the gesture is not even bound),
 * and waiting for the list RESPONSE is not the app having rendered from it —
 * that version still lost about one run in eleven. A swipe dispatched early
 * is silently a no-op, so the failure looks like "the page did not move",
 * with no error anywhere.
 */
async function swipeReady(page: Page): Promise<void> {
  // EXACTLY ONE ready zone. During a client-side navigation the outgoing
  // route's zone can still be mounted while the incoming one arrives, and a
  // bare "is one visible" would be satisfied by the zone we are leaving —
  // the same race, just narrower. Waiting for the count to settle at one is
  // what makes this a fact about the page rather than about whichever
  // element the locator happened to reach first.
  await expect(page.locator('[data-swipe-nav="ready"]')).toHaveCount(1);
  await expect(page.locator(".xterm")).toBeVisible();
}

/**
 * Swipe prev/next between subshells (spec 2026-09-04): on a phone, dragging
 * left over the terminal walks DOWN the creation order, dragging right walks
 * UP. Also guards the 09-mobile-navcrash territory for free: navigating
 * between two LIVE terminals must throw no pageerror.
 */
test("swipe left/right on /subshells/$id walks creation order", async ({ page }) => {
  test.setTimeout(150_000);
  const tag = `e2e-swipe-${test.info().retry}`;

  // Harness-first launch (spec 2026-09-13): no preset lookup — a preset is
  // optional and a fresh account owns none.
  const mk = async (name: string): Promise<string> => {
    const res = await page.request.post("/api/subshells", {
      data: { harnessId: "pi", workingDir: "/tmp", name },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  // A created first, B second: newest-first puts B DIRECTLY above A, and
  // nothing either of them does later can change that.
  const a = await mk(`${tag}-a`);
  const b = await mk(`${tag}-b`);
  const waitAlive = async (id: string) =>
    expect
      .poll(
        async () => {
          const rows = (await (await page.request.get("/api/subshells")).json()) as Row[];
          return rows.find((r) => r.id === id)?.alive === true;
        },
        { timeout: SPAWN_TIMEOUT },
      )
      .toBe(true);
  await waitAlive(a);
  await waitAlive(b);

  // Independent re-derivation of the order: B must be A's neighbour above.
  // No snapshot race any more — creation order cannot change between this
  // fetch and the swipe, whatever the other rows are doing.
  const rows = (await (await page.request.get("/api/subshells")).json()) as Row[];
  // No two rows share a creation instant, so the order below is total without
  // the test having to model how the app breaks ties.
  const stamps = rows.map((r) => Date.parse(r.createdAt));
  expect(new Set(stamps).size, "createdAt ties would make the expected order ambiguous").toBe(stamps.length);
  const ordered = newestFirst(rows);
  const ia = ordered.findIndex((r) => r.id === a);
  expect(ia).toBeGreaterThan(-1);
  expect(ordered[ia - 1]?.id).toBe(b);

  // $ anchor: ids are hex today, but the URL must match EXACTLY whatever the
  // id alphabet becomes.
  const onSubshell = (id: string) => new RegExp(`/subshells/${id}$`);

  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));

  try {
    // Attach A's terminal fully before the swipe — the crash-adjacent path is
    // live-to-live navigation, not navigation to a cold pane.
    const socket = page.waitForEvent("websocket", {
      predicate: (w) => w.url().includes("/ws?subshell="),
      timeout: SPAWN_TIMEOUT,
    });
    await gotoSubshell(page, a);
    await socket;

    const client = await page.context().newCDPSession(page);
    const vp = page.viewportSize();
    const cy = Math.round((vp?.height ?? 659) / 2);
    const cx = Math.round((vp?.width ?? 393) / 2);

    // Left swipe (finger moves left) → next = DOWN the list: from A that is
    // whatever row the oracle places below A.
    const below = ordered[ia + 1]?.id;
    if (below) {
      await swipe(client, cx, cx - 140, cy);
      await expect(page).toHaveURL(onSubshell(below));
      // No readiness wait here, deliberately: `below` is whatever the order
      // puts under A — a leftover from an earlier spec, which may be EXITED
      // and therefore renders a log panel with no terminal at all. Only the
      // URL is the claim; the return trip does its own waiting.
      // Only above A sits B, so return to A before exercising the up-swipe.
      await gotoSubshell(page, a);
    }
    // Right swipe from A → previous = B.
    await swipe(client, cx, cx + 140, cy);
    await expect(page).toHaveURL(onSubshell(b));
    // B's zone has to arm before the next swipe: this is a CLIENT-SIDE
    // navigation, so the gesture rebinds to a new element and the old one's
    // `.xterm` can still be on screen while it does.
    await swipeReady(page);
    await swipe(client, cx, cx - 140, cy);
    await expect(page).toHaveURL(onSubshell(a));

    expect(errors, errors.map((e) => e.message).join("\n")).toHaveLength(0);
  } finally {
    // Failure-safe: a leaked live row pollutes every later order-sensitive
    // assertion in the shared single-DB suite.
    for (const id of [a, b]) {
      await page.request.post(`/api/subshells/${id}/terminate`);
      await page.request.delete(`/api/subshells/${id}`);
    }
  }
});
