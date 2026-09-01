import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Phase-1 nodes page, minimal contract (spec 2026-08-31 §9/§10): the seeded
 * `local` node renders online, and the Add-node flow mints a setup key whose
 * plaintext appears exactly once next to the install command that carries it
 * as `?setup_key=`. The key then survives the dialog close as a revocable
 * row in the Setup-keys card. No real enrollment here — the stub-agent
 * online/chips/launch path is the phase-3 spec.
 */
test("nodes: Local renders online; Add-node mints a setup key + install command", async ({ page }) => {
  await page.goto("/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();

  // The boot-seeded control-plane node: name + machine line + online badge.
  // On this pristine-registry run `Local` is the only node, so the page-level
  // texts are unambiguous.
  await expect(page.getByText("Local", { exact: true })).toBeVisible();
  await expect(page.getByText("this machine", { exact: false })).toBeVisible();
  await expect(page.getByText("online", { exact: true })).toBeVisible();

  // Add node → name it → one-time reveal.
  await page.getByRole("button", { name: "Add node" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a node" })).toBeVisible();
  await dialog.locator("#node-name").fill("e2e-box");
  await dialog.getByRole("button", { name: "Create setup key" }).click();

  await expect(dialog.getByRole("heading", { name: "Run this on the new machine" })).toBeVisible();
  const key = (await dialog.getByText(/^nsk_/).textContent()) ?? "";
  expect(key, "plaintext key is shown once").toMatch(/^nsk_/);

  // The rendered install command: curl … /install.sh?setup_key=<the key> | bash
  const command = dialog.locator("code", { hasText: "install.sh?setup_key=" });
  await expect(command).toBeVisible();
  await expect(command).toContainText(`?setup_key=${key}`);

  await dialog.getByRole("button", { name: "Done" }).click();

  // The minted key is listed for revocation after the dialog closes.
  await expect(page.getByText("Setup keys", { exact: true })).toBeVisible();
  await expect(page.getByText("e2e-box", { exact: true })).toBeVisible();
  await expect(page.getByText("unused", { exact: true })).toBeVisible();
});
