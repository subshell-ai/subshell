import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Same admin the desktop specs created (spec 01); projects decide the
 * viewport. `mobile` = iPhone 15 Pro (393x659, touch, drawer shell);
 * `ipad-landscape` = 1194x834, touch (desktop shell + dock). */
const isPhone = () => test.info().project.name === "mobile";

let launchFixtureId: string | undefined;
test.beforeEach(async ({ page }, info) => {
  if (
    !isPhone() ||
    ![
      "drawer quick-add: inline ✕, dialog opens, drawer dismissed",
      "launch dialog survives the agent dropdown's scroll shift",
    ].includes(info.title)
  )
    return;
  // These actions require an active workspace, regardless of what earlier specs leave behind.
  const response = await page.request.post("/api/subshells", {
    data: { harnessId: "terminal", name: "Mobile launch fixture", workingDir: "/tmp" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  launchFixtureId = (await response.json()).id;
  const workspace = await page.request.post("/api/workspaces", {
    data: { name: "Mobile launch fixture", subshellId: launchFixtureId },
  });
  expect(workspace.ok(), await workspace.text()).toBe(true);
});
test.afterEach(async ({ page }) => {
  if (launchFixtureId) await page.request.delete(`/api/subshells/${launchFixtureId}`);
  launchFixtureId = undefined;
});

/** Horizontal overflow of the document, in px (<= 1 is the rounding floor). */
const overflowOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("no horizontal overflow on the main routes", async ({ page }) => {
  // /subshells/does-not-exist renders the not-running panel — a real mobile
  // layout surface, not just an empty route.
  for (const path of ["/", "/workspaces", "/settings", "/account", "/settings/users", "/subshells/does-not-exist"]) {
    await page.goto(path);
    const overflow = await overflowOf(page);
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("the Add user dialog fits at phone width", async ({ page }) => {
  // The create form used to be an inline card on the roster page, covered by
  // the walk above — the 2026-08-30 mobile spec built its responsive
  // behaviour BECAUSE it overflowed. On 2026-09-14 it moved behind a dialog,
  // which a route walk never opens, so that assertion silently began covering
  // an empty page. Measure it open.
  //
  // Dismissed with Escape and never submitted: the suite shares one database
  // (spec 01 creates this admin), and a user created here would outlive the
  // spec and show up in everyone else's roster.
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByRole("heading", { name: "Add user" })).toBeVisible();
  const overflow = await overflowOf(page);
  expect(overflow, `the Add user dialog overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Add user" })).toHaveCount(0);
});

test("shell chrome follows the 1024px rule", async ({ page }) => {
  await page.goto("/");
  if (isPhone()) {
    const burger = page.getByRole("button", { name: "Open navigation" });
    await expect(burger).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    await burger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Selecting a mini-rail section keeps the drawer open for its pages.
    await page
      .getByRole("navigation", { name: "Main sections" })
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Positive control for 10-auth-experience's member check, which asserts
    // this exact locator has COUNT 0. Users moved inside the group, so an
    // absence assertion about it is vacuous unless something proves the
    // locator can match — that is this line, and it is the same reasoning
    // the audit and Add-user controls in that spec already carry.
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
    await page.getByRole("link", { name: "General" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // Navigating dismisses the drawer (route-change effect).
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The user menu (spec 2026-09-02 settings-split §3) replaces Logout in
    // the drawer: Account settings must reach /account. The drawer was
    // dismissed above, so it rides the same burger-open path as any tap.
    await burger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main sections" })
      .getByRole("link", { name: "Account", exact: true })
      .click();
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
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

test("drawer closes by backdrop or a close button below the phone safe area", async ({ page, context }) => {
  test.skip(!isPhone(), "phone-only drawer flow");
  const cdp = await context.newCDPSession(page);
  // Device descriptors don't emulate the PWA's camera/status-bar inset.
  // Override the browser environment value so the real CSS layout is tested.
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  await page.goto("/");
  const open = page.getByRole("button", { name: "Open navigation" });
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await open.tap();
  const close = drawer.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  if (!box) throw new Error("The sidebar close button has no bounding box");
  expect(box.y).toBeGreaterThanOrEqual(59);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await close.tap();
  await expect(drawer).toHaveCount(0);

  await open.tap();
  await expect(drawer).toBeVisible();
  // An ordinary tap inside the drawer must not dismiss it.
  // Locator taps wait for the opening slide animation to finish.
  await drawer.tap({ position: { x: 4, y: 200 } });
  await expect(drawer).toBeVisible();
  const width = await page.evaluate(() => window.innerWidth);
  await page.touchscreen.tap(width - 8, 200);
  await expect(drawer).toHaveCount(0);
  await cdp.detach();
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

  await drawer
    .getByRole("combobox", { name: "Switch workspace" })
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .tap();
  await page.getByRole("menuitem", { name: "Add subshell", exact: true }).tap();
  await expect(page.getByRole("navigation", { name: "Main sections" })).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: /^(New|Add a) subshell$/ })).toBeVisible();
});

test("launch dialog survives the agent dropdown's scroll shift", async ({ page }) => {
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
  // 320, not 420: the dialog has to OVERFLOW for this test to prove anything,
  // and it lost a field when the node picker began hiding itself on a
  // single-target instance (2026-09-12) — at 420 it now fits, `parked` came
  // back 0, and the assertion below caught exactly that. The comment on that
  // assertion predicted this day; this is it. (The Agent/Preset/Working-dir
  // form of 2026-09-13 is one field TALLER again — Agent combobox, Preset
  // select, working dir — so the overflow is comfortably real at 320; the
  // dynamic `parked` computation below stays field-count-proof either way.)
  await page.setViewportSize({ width: 1024, height: 320 });
  await page.goto("/");

  // The rail's + specifically (the home page has its own "New subshell").
  // Mouse click to open: this test owns the SCROLL behavior; the tap-open
  // gesture is pinned by the drawer test above. (Touch-tapping the rail + at
  // this width races the dialog's first commit in-suite and intermittently
  // finds it already dismissed — see the drawer test for the reliable path.)
  await page
    .getByRole("combobox", { name: "Switch workspace" })
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .tap();
  await page.getByRole("menuitem", { name: "Add subshell", exact: true }).tap();
  const dialog = page.locator("[data-slot='dialog-content']").first();
  await expect(dialog).toBeVisible();
  const scroller = page.locator("[data-slot='dialog-content'] > div").first();
  await expect(scroller).toBeVisible();

  // Keep the real trigger visible before parking the dialog. The launch-type
  // tabs moved Agent below this short viewport; a fixed25px scroll tapped
  // outside the viewport and never opened the dropdown at all.
  if (await page.getByRole("dialog", { name: "Add a subshell", exact: true }).isVisible()) {
    await dialog.getByRole("button", { name: "New subshell", exact: true }).click();
  }
  const agent = page.getByRole("combobox", { name: "Agent" });
  await agent.scrollIntoViewIfNeeded();
  await expect(agent).toBeInViewport();
  const parked = await scroller.evaluate((el) => el.scrollTop);
  // A shorter launch form can leave Agent visible at scrollTop 0.
  // What matters is that the simulated keyboard shift actually moves it.
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(parked);
  const combo = await page.getByRole("combobox", { name: "Agent" }).boundingBox();
  expect(combo).toBeTruthy();
  if (!combo) throw new Error("Agent combobox has no bounding box");
  await page.touchscreen.tap(combo.x + combo.width / 2, combo.y + combo.height / 2);
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.waitForTimeout(400);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(parked);
  // Dismiss only the dropdown by tapping the dialog's bottom padding.
  const dbox = await dialog.boundingBox();
  expect(dbox).toBeTruthy();
  if (!dbox) throw new Error("Dialog has no bounding box");
  await page.touchscreen.tap(dbox.x + 40, dbox.y + dbox.height - 8);
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

  // One real subshell to offer: with nothing pickable the dialog opens
  // straight on the New half (newOnly, 2026-10-19), and the tall
  // Existing/New form this test measures would not exist at all.
  const spawned = await page.request.post("/api/subshells", {
    data: { harnessId: "pi", workingDir: "/tmp", name: `e2e-mobile-fit-${testInfo.project.name}-${Date.now()}` },
  });
  expect(spawned.ok(), await spawned.text()).toBe(true);

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

test("workspace navigation survives the landing redirect and pane actions stay in the drawer", async ({ page }) => {
  test.skip(!isPhone(), "Phone drawer behavior");
  const created = await page.request.post("/api/subshells", {
    data: { harnessId: "terminal", name: "Mobile sidebar review", workingDir: "/tmp" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const subshell = await created.json();
  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: "Mobile sidebar review", subshellId: subshell.id },
  });
  expect(workspaceResponse.ok(), await workspaceResponse.text()).toBe(true);
  const workspace = await workspaceResponse.json();
  try {
    // Starting outside Workspaces leaves its rail destination at "/", which redirects.
    await page.goto("/account");
    await page.evaluate((id) => localStorage.setItem("subshell.lastWorkspaceId", id), workspace.id);
    await page.getByRole("button", { name: "Open navigation" }).click();
    const rail = page.getByRole("navigation", { name: "Main sections" });
    await rail.getByRole("link", { name: "Workspaces", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "Switch workspace" });
    await expect(picker).toBeVisible();
    // Pick explicitly if another fixture's workspace was more recently touched.
    await picker.click();
    await page.getByRole("option", { name: "Mobile sidebar review", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.id}$`));
    // The picker may select the current workspace, so close/reopen consistently.
    if (!(await page.getByRole("navigation", { name: "Main sections" }).isVisible()))
      await page.getByRole("button", { name: "Open navigation" }).click();
    const sidebar = page.locator("aside");
    const row = sidebar.locator(`a[href="/subshells/${subshell.id}"]`);
    await expect(row).toBeVisible();
    const rowActions = row.locator("xpath=../..").getByRole("button", { name: /^Actions for / });
    await rowActions.click();
    await expect(page.getByRole("menuitem", { name: "Edit title", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeVisible();
    await row.click();
    await expect(sidebar).not.toBeVisible();
    const close = page.getByRole("button", { name: /Remove .* from workspace/ });
    await expect(close).toHaveAttribute("aria-disabled", "true");
    await close.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.id}$`));
    await expect(page.getByText("Add another tab before removing this one.", { exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/subshells/${subshell.id}`);
  }
});
