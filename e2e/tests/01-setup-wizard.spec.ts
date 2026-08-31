import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE } from "./helpers";

test("first-run wizard creates the admin; login and logout work", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/); // "/" redirects while needsSetup
  await expect(page.getByText("Welcome to Mote")).toBeVisible();

  // Step 1/2 — Account
  await page.fill("#name", ADMIN.name);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  // A typo in the confirmation must block submit (there is no password reset
  // until the break-glass hatch; the wizard is the one place that matters).
  await page.fill("#password-confirm", "typo-does-not-match");
  await page.locator("#password-confirm").blur();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create admin account" })).toBeDisabled();
  await page.fill("#password-confirm", ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();

  // Step 2/2 — Harness management. There is no profile step any more:
  // registration already seeded a blank "Default" profile for every enabled
  // harness, so this step is purely install/enable (the same HarnessRow
  // settings renders). The stub `pi` must be present and enabled; the others
  // read "not installed" on a bare runner.
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  // HarnessRow names itself role=group / aria-label=<harness name> (pinned by
  // components/__tests__/harness-row.test.tsx). Exact name so a future
  // "pi-something" can't shadow it, and no dependence on class names.
  const piRow = page.getByRole("group", { name: "pi", exact: true });
  await expect(piRow).toBeVisible();
  // The stub pi is installed + enabled → its status cell reads exactly "enabled".
  await expect(piRow.getByText("enabled", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  // The wizard must never show again on a DB with users.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);

  // Auto-defaulted profile: registration seeded a "Default" for each enabled
  // harness; GET /api/profiles filters to INSTALLED ones, so on the e2e stack
  // (stub pi installed, the rest absent) the admin already has exactly the pi
  // Default — a session can be started without ever touching the profile UI.
  const profiles = await page.evaluate(async () => {
    return (await (await fetch("/api/profiles")).json()) as {
      id: string;
      name: string;
      harnessId: string;
      envJson: string | null;
      isDefault: number;
    }[];
  });
  const piDefault = profiles.find((p) => p.harnessId === "pi" && p.name === "Default");
  expect(piDefault, "registration should have seeded a pi Default profile").toBeDefined();
  expect(piDefault?.envJson).toBeNull();
  expect(piDefault?.isDefault, "seeded profiles carry the unremovable flag").toBe(1);

  // Unremovable: the DELETE endpoint refuses a Default (409), row intact.
  const delStatus = await page.evaluate(async (id) => {
    const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
    const stillThere = (await (await fetch("/api/profiles")).json()).some((p: { id: string }) => p.id === id);
    return { status: res.status, stillThere };
  }, piDefault?.id ?? "");
  expect(delStatus.status).toBe(409);
  expect(delStatus.stillThere).toBe(true);

  // Logout, then real login through the form.
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  // Hand the session to the specs that run after this one (workers: 1).
  // ADMIN_STATE is an absolute path (helpers.ts), so writer and reader agree
  // no matter which directory the run was launched from.
  await context.storageState({ path: ADMIN_STATE });
});
