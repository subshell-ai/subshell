import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Pane waits are generous: "Start subshell" spawns real tmux + the pi stub. */
const PANE_TIMEOUT = 30_000;

test("create a workspace, add a subshell pane, and the layout survives reload", async ({ page }) => {
  await page.goto("/workspaces");
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Wide viewport (Desktop Chrome) → dock. The add button's accessible name
  // is its aria-label "Add a subshell to this workspace" (aria-label wins over
  // the "Add subshell" text content), so a partial label would not match.
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a subshell" })).toBeVisible();
  await page.getByRole("button", { name: "New subshell" }).click();
  // Stable id from NewSubshellForm; the only other control group in the dialog
  // (direction) is buttons, not comboboxes, but the id survives either way.
  await page.locator("#picker-profile").click();
  // Profile options render as "{name} ({harnessId})". Registration seeded a
  // "Default" for every enabled harness, and GET /api/profiles keeps the ones
  // whose CLI is installed — a host with several CLIs shows several Defaults,
  // so pick pi's exactly (the stub pi is the only binary the e2e stack owns).
  await page.getByRole("option", { name: "Default (pi)", exact: true }).click();
  await page.fill("#picker-working-dir", "/tmp");
  await page.fill("#picker-subshell-name", "e2e-pane");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel drops over the name field and "Start subshell" below it; it dismisses
  // only on an outside click or Escape (blur/fill don't close it). Escape
  // can't be used here — in a modal dialog it would close the whole dialog —
  // so click the heading: inside the dialog (stays open) but outside the
  // picker root (panel closes). Env-dependent: only bites when /tmp has
  // directory entries to populate the panel (CI's own playwright-artifacts-*).
  await page.getByRole("heading", { name: "Add a subshell" }).click();
  await page.getByRole("button", { name: "Start subshell" }).click();

  // The pane appears carrying the subshell's name as its panel title. Generous
  // timeout: the POST creates a tmux session before the panel is added.
  await expect(page.getByText("e2e-pane").first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Layout persists: reload re-reads the dock state from the API.
  await page.reload();
  await expect(page.getByText("e2e-pane").first()).toBeVisible({ timeout: PANE_TIMEOUT });
});
