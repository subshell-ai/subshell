import { expect, test } from "@playwright/test";
import { ADMIN_STATE, pickAgent } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Presets CRUD (spec 2026-09-13 §4/§5), both doors the product has:
 *
 * 1. the /presets page — create with the agent chosen in the dialog, verify
 *    the row reached storage, delete it again (every preset is deletable now;
 *    the unremovable seeded "Default" went out with the profile model);
 * 2. the launch form's `+` — a NESTED create dialog with the agent locked,
 *    where creating a preset selects it.
 *
 * The stack starts at ZERO presets (nothing auto-seeds any more — spec 01
 * asserts that via the API), and each test cleans up after itself so the
 * canonical launch in every later spec starts from "None".
 */
test("create a preset from the page, verify it via the API, delete it", async ({ page }) => {
  await page.goto("/presets");
  // A fresh user has zero presets: the page opens on its empty state, not a
  // list of Defaults.
  await expect(page.getByText("No presets yet")).toBeVisible();

  await page.getByRole("button", { name: "New preset" }).click();
  // Unlocked create dialog (the nested launch-form variant locks the agent).
  await expect(page.getByRole("heading", { name: "Create preset" })).toBeVisible();
  // The harness trigger carries the stable id `#preset-harness` — locating by
  // id beats a bare getByRole("combobox"), which is ambiguous the moment
  // another select is on the page. Options render as the plugin display name;
  // pi's is exactly "pi" (exact:true so a future "pi-something" can't shadow
  // it).
  await page.locator("#preset-harness").click();
  await page.getByRole("option", { name: "pi", exact: true }).click();
  await page.fill("#preset-name", "E2E shell");

  // Bulk-paste env wiring — the browser-level proof the removed wizard profile
  // step used to carry. It drives the real controlled-textarea path (parse →
  // "Add N rows" → row inputs → POST body) that unit tests of the pure parser
  // cannot see, and it doubles as the guard against fill() silently no-opping
  // on the textarea: if input events stop firing, "Add rows" stays disabled.
  const envSection = page.locator("#preset-env");
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
  await page.getByRole("button", { name: "Create preset" }).click();
  // The row appears under its agent's group header (the list is grouped by
  // agent now; the row itself carries no harness badge). The header is an
  // <h2> (icon span aria-hidden, then the name) — matching it by ROLE is what
  // keeps "pi" single-match: a getByText of the bare name would also hit a
  // future no-env preset's row, whose copy-launch command line renders
  // exactly "pi".
  await expect(page.getByRole("heading", { name: "pi", exact: true })).toBeVisible();
  await expect(page.getByText("E2E shell")).toBeVisible();

  // The pasted rows must reach storage, not just the form.
  const savedEnv = await page.evaluate(async () => {
    const rows = (await (await fetch("/api/presets")).json()) as { name: string; envJson: string | null }[];
    return rows.find((r) => r.name === "E2E shell")?.envJson ?? null;
  });
  expect(JSON.parse(savedEnv ?? "{}")).toMatchObject({ E2E_ONE: "1", E2E_TWO: "two" });

  // Delete it — every preset is deletable, and DELETE always answers.
  await page.getByRole("button", { name: "Actions for E2E shell" }).click();
  await page.getByRole("menuitem", { name: "Delete preset" }).click();
  await expect(page.getByText("Delete this preset?")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("E2E shell")).toHaveCount(0);
  await expect(page.getByText("No presets yet")).toBeVisible();
});

test("the launch form's + creates a preset inline and selects it", async ({ page }) => {
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  // Unlike the first-run wizard (spec 15: the row is hidden there), the real
  // launch form shows the Preset select even at zero presets — with "None"
  // selected and the hint naming the agent.
  await expect(page.locator("#picker-preset")).toContainText("None");
  await expect(page.getByText("No presets for pi yet.")).toBeVisible();

  await page.getByRole("button", { name: "New preset" }).click();
  // The nested dialog (Base UI stacks dialogs; Escape closes the topmost)
  // with the agent locked — no #preset-harness to choose, just the name.
  await expect(page.getByRole("heading", { name: "New preset for pi" })).toBeVisible();
  await page.fill("#preset-name", "Inline shell");
  await page.getByRole("button", { name: "Create preset" }).click();

  // The created preset becomes the selection — the nested dialog's whole
  // promise. (On agent CHANGE the preset resets to None; on create it sticks.)
  await expect(page.locator("#picker-preset")).toContainText("Inline shell");

  // Clean up over the API, so every later spec's canonical launch still
  // starts at "None" on the shared DB.
  const rows = (await (await page.request.get("/api/presets")).json()) as { id: string; name: string }[];
  const row = rows.find((r) => r.name === "Inline shell");
  if (!row) throw new Error("the inline create must persist a real row");
  expect((await page.request.delete(`/api/presets/${row.id}`)).ok()).toBe(true);
});
