import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, expectSubshellRunning, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** tmux spawn + first status poll take seconds; later asserts can be shorter. */
const SPAWN_TIMEOUT = 30_000;

/**
 * The filing model (spec 2026-10-17) makes a launch join the workspaces that
 * already exist, so leftovers from earlier specs are no longer scenery: the
 * rail-close test below must stand on the workspace ITS launch opened, not on
 * one an earlier file happened to leave with tabs in it — closing its own pane
 * there would retire nothing and the page would (correctly) stay put. Start
 * each test empty; the suite is one admin who owns everything the earlier
 * files left running.
 */
test.beforeEach(async ({ page }) => {
  const subshells = (await (await page.request.get("/api/subshells")).json()) as { id: string }[];
  for (const s of subshells) await page.request.delete(`/api/subshells/${s.id}`);
  const workspaces = (await (await page.request.get("/api/workspaces")).json()) as { id: string }[];
  for (const w of workspaces) await page.request.delete(`/api/workspaces/${w.id}`);
});

/**
 * The flagship path: create a real tmux session (stub `pi` binary, no
 * preset — the launch is harness-first since spec 2026-09-13), watch the
 * terminal attach, then terminate and delete.
 * xterm paints to a WebGL canvas, so "the terminal is live" is asserted
 * through server-side truth: the ws-token mint + /ws upgrade + the absence of
 * the reconnecting pill — never canvas pixels. Independent of spec 05's
 * leftover `e2e-pane` subshell; cleans up after itself.
 */
test("subshell: create -> attach -> terminate -> delete", async ({ page }) => {
  // Config leaves the 30 s default per-test timeout; real tmux spawn plus two
  // round-trips through confirm dialogs needs more headroom.
  test.setTimeout(120_000);

  // Unique per attempt (spec 07's pattern): a CI retry must not collide with
  // attempt 0's leftover subshell — duplicate cards would break the strict
  // list locators and mask the real failure. The launch form no longer asks
  // for a name, so the subshell is renamed once it exists.
  const name = `e2e-lifecycle-${test.info().retry}`;

  // Create from `/new`, which opens the launch DIALOG over the list. The
  // searchable picker's closed state is an <input>, so it is found by its
  // placeholder attribute. Options render as the plugin display name.
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel pushes the buttons below it down the dialog's scroller; neither blur
  // nor fill closes it, and Escape takes the whole dialog with it (see the
  // table on `dismissDirectoryPanel`). Dismissing keeps the submit button
  // where the next step expects it. Env-dependent: only bites when /tmp has
  // directory entries to populate the panel (CI's own playwright-artifacts-*).
  await dismissDirectoryPanel(page);

  // The detail page mints a one-shot WS token (POST /api/auth/ws-token), then
  // opens /ws?subshell=… — both listeners must be armed BEFORE the click.
  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });

  await page.getByRole("button", { name: "Start subshell" }).click();
  // The POST spawns tmux before the navigate happens, hence the long leash.
  // A launch raised off any workspace page lands as a TAB in a workspace
  // opened around it (spec 2026-10-17), so the page is the dock.
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });

  // Terminal attached: token minted, socket opened, and the reconnecting pill
  // gone — it renders only while the socket is down, so count 0 IS the proof.
  await tokenRes;
  const ws = await socket;
  expect(ws.url()).toContain("/ws?subshell=");
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  // The header's status dot carries the raw status ALIVE pair — proof the
  // stub harness is alive in its pane. A dead-on-arrival pane is precisely
  // what `data-alive` distinguishes: the server stamps `alive: false` and
  // leaves `status: "running"`, so the status alone would pass on a pane
  // that died instantly.
  await expectSubshellRunning(page, SPAWN_TIMEOUT);

  await renameSubshell(page, name);

  // Close it from the subshells list via the actions menu + confirm.
  // "Close" is the human name for DELETE (spec 2026-09-03): it terminates
  // the live pane AND removes the row in one act — the old separate
  // Terminate step left the human UI together with this two-step flow.
  await page.goto("/subshells");
  const actions = page.getByRole("main").getByRole("button", { name: `Actions for ${name}` });
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Close this subshell?" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(`permanently deletes "${name}"`)).toBeVisible();
  await page.locator("[data-slot='dialog-content'] button", { hasText: /^Close subshell$/ }).click();

  // Prove it is gone.
  await expect(page.getByText(name)).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
});

/**
 * The bug this test pins (operator report, 2026-09-27): closing a subshell
 * from the RAIL while its detail page is open used to leave the page standing
 * on cached data — a doomed terminal that never learned its row was gone.
 * The Close must end the view exactly as the page's own Close does; the rail
 * is a different tree, so the fix is the page leaving on its own 404, and
 * the workspace tab equivalent is the dock reconcile closing on the
 * workspace refetch the shared mutation now fires (unit-pinned in
 * `use-subshell-mutations.test.tsx` and the feed's gone-frame test).
 */
test("subshell: Close from the rail leaves the open detail page", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `e2e-rail-close-${test.info().retry}`;

  // Launch (the flagship path, kept short): the stub `pi` harness, /tmp, and
  // the navigate to the detail page once the POST spawns tmux.
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  await dismissDirectoryPanel(page);
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  // Remember WHERE the page sits: "left" has to mean THIS workspace's exact
  // URL. The old `not /subshells/` check was vacuous in this flow (it never
  // sits at a detail page), so a Close that failed to leave the retired
  // workspace sailed straight through it (review 2026-10-17).
  const openWorkspaceUrl = page.url();
  await expectSubshellRunning(page, SPAWN_TIMEOUT);
  await renameSubshell(page, name);

  // Right-click the subshell's ROW in the rail — the sidebar's context menu
  // is the same shared actions menu the page header mounts, but a different
  // component tree, and that tree used to be the one that did nothing.
  // `.last()`, not `.first()`: since spec 2026-10-17 the launch filed this
  // pane into a workspace, so the Workspaces branch ABOVE the machine groups
  // renders a second row for it. Both rows are the same rail component and
  // both carry the shared menu; `.last()` names the machine group's, which
  // sits lowest (no Needs-Attention spotlight or cross-agent section holds
  // this pane), so the target is deterministic whichever branch is open.
  const railRow = page.locator("aside").getByText(name).last();
  await railRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Close this subshell?" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(`permanently deletes "${name}"`)).toBeVisible();
  await page.locator("[data-slot='dialog-content'] button", { hasText: /^Close subshell$/ }).click();

  // The page closes out — the operator's exact complaint, now the assertion:
  // it must leave the workspace URL the launch put it on, not merely avoid a
  // URL shape it never had.
  await expect(page).not.toHaveURL(openWorkspaceUrl, { timeout: SPAWN_TIMEOUT });
  // And the rail itself forgot the row everywhere (the list invalidation
  // still works): the machine group, and the tree branch the launch filed.
  await expect(page.locator("aside").getByText(name)).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
});
