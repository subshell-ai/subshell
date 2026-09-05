import { type CDPSession, expect, test } from "@playwright/test";
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
 * The order the swipe walks: newest-created first, id as a total tie-break.
 * Written independently of `lib/subshell-order.ts` so this is an oracle
 * rather than an echo of the implementation.
 *
 * Deliberately NOT the sidebar's band order (`lib/subshell-indicator.ts`,
 * which ranks by `activity` = "produced output within the last 60s"). This
 * oracle DID model the bands, and agreed with the swipe only for as long as
 * every row sat in the same one — so a leftover subshell from an earlier spec
 * printing a line put it in a different band, the oracle named a different
 * neighbour than the swipe did, and the run failed with no bad code anywhere.
 * Navigation order has to be one that does not move on its own, which is why
 * the feature stopped using the bands; the oracle simply had not followed.
 */
function ordering(rows: readonly Row[]): Row[] {
  return [...rows].sort((x, y) => {
    const byTime = Date.parse(y.createdAt) - Date.parse(x.createdAt);
    if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
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
 * Swipe prev/next between subshells (spec 2026-09-04): on a phone, dragging
 * left over the terminal walks DOWN the creation order, dragging right walks
 * UP. Also guards the 09-mobile-navcrash territory for free: navigating
 * between two LIVE terminals must throw no pageerror.
 */
test("swipe left/right on /subshells/$id walks creation order", async ({ page }) => {
  test.setTimeout(150_000);
  const tag = `e2e-swipe-${test.info().retry}`;

  const profiles = (await (await page.request.get("/api/profiles")).json()) as { id: string }[];
  expect(profiles.length).toBeGreaterThan(0);
  const mk = async (name: string): Promise<string> => {
    const res = await page.request.post("/api/subshells", {
      data: { profileId: profiles[0].id, workingDir: "/tmp", name },
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
  const ordered = ordering(rows);
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
    await page.goto(`/subshells/${a}`);
    await socket;
    await expect(page.locator(".xterm")).toBeVisible();

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
      // Only above A sits B, so return to A before exercising the up-swipe.
      await page.goto(`/subshells/${a}`);
      await expect(page.locator(".xterm")).toBeVisible();
    }
    // Right swipe from A → previous = B.
    await swipe(client, cx, cx + 140, cy);
    await expect(page).toHaveURL(onSubshell(b));
    // B's terminal attached too; left swipe from B lands back on A.
    await expect(page.locator(".xterm")).toBeVisible();
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
