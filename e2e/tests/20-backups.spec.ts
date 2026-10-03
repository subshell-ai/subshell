import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * The instance-backup round trip against the real backend: create an encrypted
 * archive, download it, then load that very file into the Restore card. The
 * server's decrypt-and-inspect (Configure backup only unlocks after it) proves
 * the archive we wrote is a valid, readable backup. It stops there: applying a
 * restore replaces the instance's database and the harness server runs from
 * source, so its prepare guard refuses a binary swap by design.
 */
test("an administrator downloads an encrypted instance archive and loads it into the restore flow", async ({
  page,
}) => {
  await page.goto("/settings/backups");
  await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/subshell-backups-settings.png", fullPage: true });

  // Create an encrypted archive.
  await page.getByRole("switch", { name: "Encrypt the archive with a password" }).check();
  await page.getByLabel("Archive password", { exact: true }).fill("e2e-archive-password");
  await page.getByLabel("Confirm archive password", { exact: true }).fill("e2e-archive-password");
  await page.getByRole("button", { name: "Create backup", exact: true }).click();

  // The job reports on the progress pane, then hands off to the download step.
  await expect(page.getByText("Backup finished")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Backup Complete" })).toBeVisible();

  const downloadLink = page.getByRole("link", { name: "Download backup" });
  await expect(downloadLink).toBeVisible();
  const pendingDownload = page.waitForEvent("download");
  await downloadLink.click();
  const download = await pendingDownload;
  const archive = await download.path();
  expect(archive).not.toBeNull();
  if (!archive) throw new Error("Backup download has no local file");

  // Load that archive into the Restore card and advance to review.
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByLabel("Backup file", { exact: true }).setInputFiles(archive);
  await page.getByLabel("Archive password", { exact: true }).filter({ visible: true }).fill("e2e-archive-password");
  // An encrypted archive's first pass fails for lack of a password; validate
  // again now that it is entered, which unlocks Configure backup.
  await page.getByRole("button", { name: "Validate backup" }).click();
  await page.getByRole("button", { name: "Configure backup", exact: true }).click();

  // Configure backup unlocks only after the server decrypts and inspects the
  // archive, and its destination fields are filled from that real inspection.
  // That is the round trip proven; the e2e server runs from source, so its
  // prepare guard refuses a binary swap ("the installed service no longer owns
  // this server") and Review Restore is intentionally out of reach here.
  await expect(page.getByRole("heading", { name: "Configure Restore" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Same-machine recovery" })).toBeChecked();
  await expect(page.getByLabel("Database path (optional)")).not.toHaveValue("");
});
