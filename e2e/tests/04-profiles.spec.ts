import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("a Default profile exists; create and delete another profile", async ({ page }) => {
  await page.goto("/profiles");
  // Auto-defaulted: registration seeds a blank "Default" for every harness
  // this host declares (spec 01 asserts pi's via the API). On a host with several
  // CLIs there are several "Default" rows, hence .first() — this just needs the
  // list populated before the create/delete flow below.
  await expect(page.getByText("Default", { exact: true }).first()).toBeVisible();

  // Defaults are unremovable: the row menu offers Edit but no Delete (the API
  // refuses with 409 — asserted in spec 01; the UI simply doesn't offer it).
  await page.getByRole("button", { name: "Actions for Default" }).first().click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete profile" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New profile" }).click();
  // The harness trigger carries the stable id `#profile-harness` (Radix puts
  // it on the role=combobox button) — locating by id beats a bare
  // getByRole("combobox") which is ambiguous the moment another select is on
  // the page. Options render as the harness display name; pi's is exactly
  // "pi" (exact:true so a future "pi-something" can't shadow it).
  await page.locator("#profile-harness").click();
  await page.getByRole("option", { name: "pi", exact: true }).click();
  await page.fill("#profile-name", "E2E shell");

  // Bulk-paste env wiring — the browser-level proof the removed wizard profile
  // step used to carry. It drives the real controlled-textarea path (parse →
  // "Add N rows" → row inputs → POST body) that unit tests of the pure parser
  // cannot see, and it doubles as the guard against fill() silently no-opping
  // on the textarea: if input events stop firing, "Add rows" stays disabled.
  const envSection = page.locator("#profile-env");
  await envSection.getByRole("button", { name: "Paste many" }).click();
  // The env section holds exactly one textarea (the paste box). Its accessible
  // name is derived from the row label ("Paste variables in bulk"), which is
  // wording we don't want to pin a test to — the structural locator is stable.
  const pasteBox = envSection.locator("textarea");
  await pasteBox.fill("{oops");
  await expect(envSection.getByText(/expected|invalid|json|parse/i)).toBeVisible();
  await expect(envSection.getByRole("button", { name: "Add rows" })).toBeDisabled();
  await pasteBox.fill('E2E_ONE=1\nexport E2E_TWO="two"');
  await envSection.getByRole("button", { name: "Add 2 rows" }).click();
  // Row first-columns are AutocompleteInputs → role=combobox with the
  // aria-label "Variable N" (components/autocomplete-input.tsx).
  await expect(envSection.getByRole("combobox", { name: "Variable 1" })).toHaveValue("E2E_ONE");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("E2E shell")).toBeVisible();

  // The pasted rows must reach storage, not just the form.
  const savedEnv = await page.evaluate(async () => {
    const rows = (await (await fetch("/api/profiles")).json()) as { name: string; envJson: string | null }[];
    return rows.find((r) => r.name === "E2E shell")?.envJson ?? null;
  });
  expect(JSON.parse(savedEnv ?? "{}")).toMatchObject({ E2E_ONE: "1", E2E_TWO: "two" });

  // Delete it again — leave the auto-seeded Defaults for later specs.
  await page.getByRole("button", { name: "Actions for E2E shell" }).click();
  await page.getByRole("menuitem", { name: "Delete profile" }).click();
  await expect(page.getByText("Delete this profile?")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("E2E shell")).toHaveCount(0);
});
