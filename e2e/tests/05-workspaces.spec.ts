import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Pane waits are generous: "Start session" spawns real tmux + the pi stub. */
const PANE_TIMEOUT = 30_000;

test("create a workspace, add a session pane, and the layout survives reload", async ({ page }) => {
  await page.goto("/workspaces");
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Wide viewport (Desktop Chrome) → dock. The add button's accessible name
  // is its aria-label "Add a session to this workspace" (aria-label wins over
  // the "Add session" text content), so the brief's "Add session" substring
  // would not match.
  await page.getByRole("button", { name: "Add a session to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a session" })).toBeVisible();
  await page.getByRole("button", { name: "New session" }).click();
  // Stable id from NewSessionForm; the only other control group in the dialog
  // (direction) is buttons, not comboboxes, but the id survives either way.
  await page.locator("#picker-profile").click();
  // Profile options render as "{name} ({harnessId})". Registration seeded a
  // "Default" for every enabled harness, and GET /api/profiles keeps the ones
  // whose CLI is installed — a host with several CLIs shows several Defaults,
  // so pick pi's exactly (the stub pi is the only binary the e2e stack owns).
  await page.getByRole("option", { name: "Default (pi)", exact: true }).click();
  await page.fill("#picker-working-dir", "/tmp");
  await page.fill("#picker-session-name", "e2e-pane");
  await page.getByRole("button", { name: "Start session" }).click();

  // The pane appears carrying the session's name as its panel title. Generous
  // timeout: the POST creates a tmux session before the panel is added.
  await expect(page.getByText("e2e-pane").first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Layout persists: reload re-reads the dock state from the API.
  await page.reload();
  await expect(page.getByText("e2e-pane").first()).toBeVisible({ timeout: PANE_TIMEOUT });
});
