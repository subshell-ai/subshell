import { type CDPSession, expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/** The fields the order oracle reads (camelCase API shape). */
interface Row {
  id: string;
  status: string;
  alive: boolean;
  activity: string;
  nodeOffline: boolean;
  waitingSince: string | null;
}

/**
 * Band rank mirroring `lib/subshell-indicator.ts` (waiting 0 → active 1 →
 * idle 2 → node-offline 3 → exited 4 → ended 5) — written independently so
 * the test is an oracle, not an echo of the implementation. Stable sort over
 * the API's createdAt-DESC order is the sidebar (and swipe) order.
 */
function rank(s: Row): number {
  if (s.nodeOffline === true) return 3;
  if (s.status === "running" && !s.alive) return 4;
  if (s.status === "running" && s.alive && s.waitingSince != null) return 0;
  if (s.activity === "active") return 1;
  if (s.activity === "idle") return 2;
  return 5;
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
 * left over the terminal walks DOWN the sidebar order, dragging right walks
 * UP. Also guards the 09-mobile-navcrash territory for free: navigating
 * between two LIVE terminals must throw no pageerror.
 */
test("swipe left/right on /subshells/$id walks the sidebar order", async ({ page }) => {
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
  // A created first, B second: in createdAt-DESC both land in the same (idle)
  // band, so B sits DIRECTLY above A in the sidebar order.
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
  // (Snapshot race accepted: a leftover row floating INTO a higher band
  // between this fetch and the swipe would retarget the `below` assertion —
  // near-impossible on the pristine suite DB, and it fails loudly.)
  const rows = (await (await page.request.get("/api/subshells")).json()) as Row[];
  const ordered = [...rows].sort((x, y) => rank(x) - rank(y));
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
