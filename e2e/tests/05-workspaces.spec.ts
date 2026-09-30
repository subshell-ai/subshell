import { expect, test } from "@playwright/test";
import { ADMIN_STATE, newSubshellName, pickAgent, subshellIds } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Pane waits are generous: "Start subshell" spawns real tmux + the pi stub. */
const PANE_TIMEOUT = 30_000;

test("create a workspace, add a subshell pane, and the layout survives reload", async ({ page }) => {
  await page.goto("/workspaces");
  // Scoped to <main>: the sidebar's Workspaces-row quick-add + has
  // aria-label "New workspace" too (spec 2026-09-03 sidebar-quickadd), so the
  // page-level role query is a 2-element strict-mode violation. Click the
  // page header's own button.
  await page.getByRole("main").getByRole("button", { name: "New workspace" }).click();
  // Creation no longer happens on click (spec 2026-09-03 sidebar-quickadd §4b):
  // the button opens NewWorkspaceDialog. Zero selected is the valid "empty
  // workspace, fill it inside" answer — the old immediate-create behavior.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New workspace" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Wide viewport (Desktop Chrome) → dock. The add button's accessible name
  // is its aria-label "Add a subshell to this workspace" (aria-label wins over
  // the "Add subshell" text content), so a partial label would not match.
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a subshell" })).toBeVisible();
  await page.getByRole("button", { name: "New subshell" }).click();
  // Stable id from NewSubshellForm; the only other control group in the dialog
  // (direction) is buttons, not comboboxes, but the id survives either way.
  // Agent options render as the plugin display name, greyed never hidden;
  // pick pi exactly (the stub pi is the only agent binary the e2e stack
  // owns). The Preset row is left untouched — a preset is optional since
  // spec 2026-09-13, and the consumed picker's empty input says so.
  await pickAgent(page.locator("#picker-agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel pushes "Start subshell" down the dialog's scroller; it dismisses only on an
  // outside click or Escape (blur/fill don't close it). Escape can't be used
  // here — in a modal dialog it closes the whole dialog, measured again on
  // 2026-09-11 (see the table on `dismissDirectoryPanel`) — so click the
  // heading: inside the dialog (stays open) but outside the picker root
  // (panel closes). Env-dependent: only bites when /tmp has directory entries
  // to populate the panel (CI's own playwright-artifacts-*).
  await page.getByRole("heading", { name: "Add a subshell" }).click();
  // Sampled BEFORE the launch: the pane's title is the name the server gives
  // the new subshell, and the only way to know which row is new is to know
  // which rows are not.
  const before = await subshellIds(page);
  await page.getByRole("button", { name: "Start subshell" }).click();

  // The pane appears carrying the subshell's name as its panel title. The
  // launch form asks for no name, so that is the server's date/time default —
  // read it back rather than choosing it. Generous timeouts either side: the
  // POST creates a tmux session before the row exists or the panel is added.
  const paneName = await newSubshellName(page, before);
  await expect(page.getByText(paneName).first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Layout persists: reload re-reads the dock state from the API.
  await page.reload();
  await expect(page.getByText(paneName).first()).toBeVisible({ timeout: PANE_TIMEOUT });
});

/**
 * The second bug this wave pins (operator report, 2026-09-27): deleting the
 * workspace you are STANDING on, from the sidebar, used to leave the page
 * rendering the dead workspace's cached detail forever — the same one-tree
 * blindness as a rail Close on a subshell. It must now drop to the subshell
 * view the pane's row still deserves. The dock is wide-view; this uses the
 * rail workspace row's Delete (a different tree from the page under test).
 */
test("deleting the open workspace from the sidebar drops you to the subshell", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/workspaces");
  await page.getByRole("main").getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Add one subshell pane (a real `pi` stub) so there is a view to drop to.
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await page.getByRole("button", { name: "New subshell" }).click();
  await pickAgent(page.locator("#picker-agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  await page.getByRole("heading", { name: "Add a subshell" }).click();
  const before = await subshellIds(page);
  await page.getByRole("button", { name: "Start subshell" }).click();
  await newSubshellName(page, before);
  await expect(page.locator(".dv-default-tab").first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Delete THIS workspace from the sidebar: the rail row is exactly the link
  // whose href carries the id the URL already shows, and its right-click
  // menu is the rail's own gesture, holding the shared "Delete workspace".
  const wsId = new URL(page.url()).pathname.split("/").pop();
  await page.locator(`aside a[href="/workspaces/${wsId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete workspace" }).click();
  await expect(page.getByText("Delete this workspace?")).toBeVisible();
  await page.locator("[data-slot='dialog-content'] button", { hasText: /^Delete$/ }).click();

  // The page leaves the (now-dead) workspace for the subshell it held.
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: PANE_TIMEOUT });
});
