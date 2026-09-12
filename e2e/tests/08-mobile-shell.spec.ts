import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Same admin the desktop specs created (spec 01); projects decide the
 * viewport. `mobile` = iPhone 15 Pro (393x659, touch, drawer shell);
 * `ipad-landscape` = 1194x834, touch (desktop shell + dock). */
const isPhone = () => test.info().project.name === "mobile";

test("no horizontal overflow on the main routes", async ({ page }) => {
  // /subshells/does-not-exist renders the not-running panel — a real mobile
  // layout surface, not just an empty route.
  for (const path of ["/", "/workspaces", "/settings", "/account", "/users", "/subshells/does-not-exist"]) {
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
    // "Instance", not "Server": the control-plane host's own node is named
    // Server, and the two words collided on /nodes for an admin.
    await page.getByRole("link", { name: "Instance" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // Navigating dismisses the drawer (route-change effect).
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The user menu (spec 2026-09-02 settings-split §3) replaces Logout in
    // the drawer: Account settings must reach /account. The drawer was
    // dismissed above, so it rides the same burger-open path as any tap.
    await burger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /Account:/ }).click();
    await page.getByRole("menuitem", { name: "Account settings" }).click();
    await expect(page).toHaveURL(/\/account$/);
    // Composition smoke (spec §7, final-review debt): landing on /account
    // must paint the account cards' titles — the split's whole promise is
    // these leaving /settings, so pin at least the endpoints of the stack.
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    // exact: both titles also occur inside card description copy.
    await expect(page.getByText("Change password", { exact: true })).toBeVisible();
    await expect(page.getByText("Passkeys", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    await expect(page.locator("aside")).toBeVisible();
  }
});

test("drawer quick-add: inline ✕, dialog opens, drawer dismissed", async ({ page }) => {
  // The 2026-09-04 phone reports: the drawer's floating ✕ landed on the
  // quick-add + row (taps hit the X instead), and the quick-add dialog was
  // mounted INSIDE the drawer — a second stacked modal. Now: the close lives
  // in the sheet's header row, and a quick-add opens the root-mounted dialog
  // while the drawer dismisses. (The scroller-restore rule the same report
  // drove is pinned by the desktop variant below + combobox unit tests;
  // combining both into this one flow races the drawer's exit animation.)
  test.skip(!isPhone(), "phone-only drawer flow");
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).tap();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  // The close control is in the sheet's header row, beside the wordmark —
  // no floating button over the nav rows.
  await expect(drawer.getByLabel("Close")).toBeVisible();

  await drawer.getByRole("button", { name: "New subshell", exact: true }).tap();
  // The ONLY dialog left is the root-mounted launch one.
  await expect(page.getByRole("dialog", { name: "New subshell" })).toBeVisible();
});

test("launch dialog survives the profile dropdown's scroll shift", async ({ page }) => {
  // 2026-09-04 report #4: focusing the type-to-filter combobox shifts the
  // dialog's scroller on phones (keyboard/scroll-into-view) and the shift
  // used to survive the dismiss, stranding the header off-screen. Searchable-
  // Select now snapshots the scroller at pointerdown and restores it when the
  // popup closes. Desktop shell (no drawer in the flow) at a height where the
  // dialog overflows, so the scroller exists; the phone's shove is applied
  // by hand (headless chromium has no soft keyboard), and the taps are raw
  // coordinates — locator actions run their own scroll-into-view first,
  // which would shift the scroller BEFORE the app can capture it.
  test.skip(!isPhone(), "needs the touch profile; geometry forced below");
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
  await page.setViewportSize({ width: 1024, height: 420 });
  await page.goto("/");

  // The rail's + specifically (the home page has its own "New subshell").
  // Mouse click to open: this test owns the SCROLL behavior; the tap-open
  // gesture is pinned by the drawer test above. (Touch-tapping the rail + at
  // this width races the dialog's first commit in-suite and intermittently
  // finds it already dismissed — see the drawer test for the reliable path.)
  await page.locator("aside").getByRole("button", { name: "New subshell", exact: true }).tap();
  const dialog = page.locator("[data-slot='dialog-content']").first();
  await expect(dialog).toBeVisible();
  const scroller = page.locator("[data-slot='dialog-content'] > div").first();
  await expect(scroller).toBeVisible();

  // Scroll DOWN by whatever this dialog can actually travel, rather than by a
  // fixed 25px: the form's field count decides the overflow, so a hardcoded
  // offset silently clamps (and the assertion then compares two clamped
  // values) the day a field is added or removed. A zero here would mean the
  // dialog no longer overflows at this height and the test proves nothing.
  const parked = await scroller.evaluate((el) => {
    el.scrollTop = Math.min(25, el.scrollHeight - el.clientHeight);
    return el.scrollTop;
  });
  expect(parked).toBeGreaterThan(0);
  const combo = await page.getByRole("combobox", { name: "Profile" }).boundingBox();
  expect(combo).toBeTruthy();
  await page.touchscreen.tap(combo!.x + combo!.width / 2, combo!.y + combo!.height / 2);
  await page.waitForTimeout(400);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // Dismiss the dropdown: a point inside the dialog's bottom padding —
  // outside the popup, and NOT the backdrop (a backdrop tap closes the
  // whole dialog).
  const dbox = await dialog.boundingBox();
  expect(dbox).toBeTruthy();
  await page.touchscreen.tap(dbox!.x + 40, dbox!.y + dbox!.height - 8);
  await page.waitForTimeout(400);
  await expect(dialog).toBeVisible(); // the dialog itself survived
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(parked);
});

test("add-subshell dialog fits and scrolls on small screens", async ({ page }, testInfo) => {
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

  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a subshell" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  const dialogHeight = box?.height ?? Number.POSITIVE_INFINITY;
  const viewportHeight = vp?.height ?? 0;
  expect(box, "dialog box").toBeTruthy();
  expect(dialogHeight, `dialog ${dialogHeight}px vs viewport ${viewportHeight}px`).toBeLessThanOrEqual(
    viewportHeight + 1,
  );
  // A control near the bottom of the dialog ("New subshell" tab) must be
  // reachable — scroll inside the dialog, the whole point of the
  // max-h/overflow change.
  const start = page.getByRole("button", { name: "New subshell" });
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

    // The subshell page is the tall-traffic surface: its header and terminal
    // panel must stack inside 393px with no page-level scroll. f54c3ed gated
    // the key bar to live-subshell terminals (`coarse && subshell` in
    // routes/subshells_.$id.tsx) — the not-running panel shows no bar at all
    // anymore, so THIS route asserts its absence; the bar's live-geometry
    // coverage lives in spec 09 (real stub-pi subshell, key bytes included).
    await page.goto("/subshells/does-not-exist");
    await expect(page.getByRole("toolbar", { name: "Terminal special keys" })).toHaveCount(0);
    const fits = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(fits, "subshell page scrolls vertically").toBeLessThanOrEqual(1);

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
