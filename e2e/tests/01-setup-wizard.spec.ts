import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE } from "./helpers";

test("first-run wizard creates the admin; login and logout work", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/); // "/" redirects while needsSetup
  await expect(page.getByText("Welcome to Subshell")).toBeVisible();

  // Step 1/3 — Account
  await page.fill("#name", ADMIN.name);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  // A typo in the confirmation must block submit (there is no password reset
  // until the break-glass hatch; the wizard is the one place that matters).
  await page.fill("#password-confirm", "typo-does-not-match");
  await page.locator("#password-confirm").blur();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Account" })).toBeDisabled();
  await page.fill("#password-confirm", ADMIN.password);
  await page.getByRole("button", { name: "Create Account" }).click();

  // Step 2/3 — the agent step, now explicitly optional: a terminal plugin
  // always exists, so this step can never dead-end. Boot seeds all six
  // built-in plugins here, so pi's row reads Detected (stub binary on PATH)
  // and the others Not found.
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add an Agent" })).toBeVisible();
  const piRow = page.getByRole("listitem", { name: "pi", exact: true });
  await expect(piRow).toBeVisible();
  await expect(piRow.getByText(/Detected/)).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3/3 — the launch step arrives filled in (Task 6's defaults), but
  // this spec's job is the admin handoff, not the launch: spec 15 owns the
  // end-to-end launch on a dedicated clean instance. "Skip" must finish
  // setup exactly like a launch does — this also pins that no stray pane
  // is left on the shared DB by the wizard itself.
  await expect(page.getByText("Step 3 of 3")).toBeVisible();
  // The agent auto-defaulted: on THIS stack pi is detected (step 2 proved
  // it), so the default rule takes the first usable non-Terminal agent —
  // Terminal last is spec 15's clean-machine case.
  await expect(page.locator("#setup-agent")).toHaveValue("pi");
  await expect(page.locator("#setup-working-dir")).not.toHaveValue("");
  // First run hides the Preset row entirely (spec 2026-09-13 §5): a brand-
  // new account has zero presets and the row would offer only "None".
  await expect(page.getByLabel("Preset")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Subshells" })).toBeVisible();

  // The wizard must never show again on a DB with users.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);

  // Zero presets for a fresh admin (spec 2026-09-13): the registration-era
  // auto-seeding of a "Default" per harness is gone, along with the
  // unremovable flag and the DELETE-409 it carried — the launch is
  // harness-first and a preset is optional.
  const presets = await page.evaluate(async () => {
    return (await (await fetch("/api/presets")).json()) as unknown[];
  });
  expect(presets).toEqual([]);

  // Sign out through the sidebar user menu (spec 2026-09-02 settings-split
  // §3 — it replaced the bare Logout button), then real login through the form.
  await page.getByRole("button", { name: /Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/");

  // Hand the session to the specs that run after this one (workers: 1).
  // ADMIN_STATE is an absolute path (helpers.ts), so writer and reader agree
  // no matter which directory the run was launched from.
  await context.storageState({ path: ADMIN_STATE });
});
