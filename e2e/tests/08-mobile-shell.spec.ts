import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Same admin the desktop specs created (spec 01); projects decide the
 * viewport. `mobile` = iPhone 15 Pro (393x659, touch, drawer shell);
 * `ipad-landscape` = 1194x834, touch (desktop shell + dock). */
const isPhone = () => test.info().project.name === "mobile";

test("no horizontal overflow on the main routes", async ({ page }) => {
  // /sessions/does-not-exist renders the not-running panel — a real mobile
  // layout surface, not just an empty route.
  for (const path of ["/", "/workspaces", "/settings", "/users", "/sessions/does-not-exist"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("shell chrome follows the 1024px rule", async ({ page }) => {
  await page.goto("/");
  if (isPhone()) {
    const burger = page.getByRole("button", { name: "Open navigation" });
    await expect(burger).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    await burger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // Navigating dismisses the drawer (route-change effect).
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    await expect(page.locator("aside")).toBeVisible();
  }
});

test("add-session dialog fits and scrolls on small screens", async ({ page }, testInfo) => {
  // Workspace via API, not the "New workspace" button: the UI auto-names with
  // a minute-granularity timestamp and the backend enforces per-user name
  // uniqueness on the ONE shared DB — spec 05 already created one this run
  // (and mobile + ipad-landscape run back-to-back), so a UI click reliably
  // 409s here. The flow itself is spec 05's job; this test owns the shell
  // rule and dialog fit on the workspace page.
  const created = await page.request.post("/api/workspaces", {
    data: { name: `mobile-shell-${testInfo.project.name}-${Date.now()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/workspaces/${id}`);

  // Shell rule on the workspace page itself: tabs below 1024px, dock above.
  // dockview 8.2.0 stamps the theme class on its own `dv-shell` root AND on
  // the React wrapper inside `dv-view`, so "one dock" is counted on the
  // unique `.dv-shell` root, not the bare theme class (which matches 2).
  if (isPhone()) {
    await expect(page.locator(".dockview-theme-abyss")).toHaveCount(0);
    // No fallback bar on detail pages — the hamburger rides in the
    // workspace header instead, exactly once.
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(1);
  } else {
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    const dock = page.locator(".dv-shell.dockview-theme-abyss");
    await expect(dock).toHaveCount(1);
    const tabStripHeight = await dock.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--dv-tabs-and-actions-container-height").trim(),
    );
    expect(tabStripHeight).toBe("44px"); // coarse-pointer bump (Task 7)
  }

  await page.getByRole("button", { name: "Add a session to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a session" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  const dialogHeight = box?.height ?? Number.POSITIVE_INFINITY;
  const viewportHeight = vp?.height ?? 0;
  expect(box, "dialog box").toBeTruthy();
  expect(dialogHeight, `dialog ${dialogHeight}px vs viewport ${viewportHeight}px`).toBeLessThanOrEqual(
    viewportHeight + 1,
  );
  // The bottom of the form (Start session) must be reachable — scroll inside
  // the dialog, the whole point of the max-h/overflow change.
  const start = page.getByRole("button", { name: "New session" });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  await page.keyboard.press("Escape");
});

test.describe("iPhone landscape (852x393)", () => {
  // Landscape keeps the <1024px mobile shell but halves the height: the
  // header row and key bar together eat ~100 of 393 px, so "everything
  // still fits" is a genuinely different assertion than at 659 px tall.
  test.use({ viewport: { width: 852, height: 393 } });

  test("the mobile shell survives the height squeeze", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "phone-only geometry");

    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `home overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

    // The session page is the tall-traffic surface: its header, terminal and
    // key bar must stack inside 393px with no page-level scroll.
    await page.goto("/sessions/does-not-exist");
    await expect(page.getByRole("toolbar", { name: "Terminal special keys" })).toBeInViewport();
    const fits = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(fits, "session page scrolls vertically").toBeLessThanOrEqual(1);

    // Detail pages keep the merged header: exactly one burger, no fallback bar.
    const created = await page.request.post("/api/workspaces", { data: { name: `landscape-${Date.now()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    await page.goto(`/workspaces/${id}`);
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(1);
  });
});

test("home-screen install assets are served", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const json = await manifest.json();
  expect(json.display).toBe("standalone");
  for (const href of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"]) {
    const res = await page.request.get(href);
    expect(res.ok(), href).toBe(true);
  }
});
