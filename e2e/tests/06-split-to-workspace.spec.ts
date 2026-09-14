import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Real tmux spawns sit behind every launch here; the dock add is another round trip. */
const SPAWN_TIMEOUT = 30_000;

/**
 * Splitting a running subshell (spec 2026-09-14).
 *
 * The flow under test is deliberately end-to-end: a split creates a DRAFT
 * workspace on the server, carries the picked second pane through `?add=`/
 * `?dir=` search params, and the dock adds it through the same `handleAdd`
 * every later add uses — then strips the params. None of that is visible to a
 * unit test, and the two failures it is guarding against are both URL-shaped:
 * a reload that re-consumes the intent and adds a duplicate pane, and params
 * that never get stripped.
 *
 * The `pi` stub is the agent throughout (the e2e stack's `PI_PATH` loop-forever
 * script), for the same reason spec 05 uses it: it needs no agent CLI and it
 * cannot exit underneath the assertions.
 */

/** Launches a subshell from `/new` and renames it, leaving its detail page open. */
async function launchSubshell(page: Page, name: string): Promise<void> {
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The directory panel opens on focus and pushes the submit button down the
  // dialog's scroller; Escape would take the whole dialog (see the table on
  // `dismissDirectoryPanel`).
  await dismissDirectoryPanel(page);
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
  await renameSubshell(page, name);
}

/** Every workspace the signed-in user has holding `subshellId`, drafts included. */
async function workspacesHolding(page: Page, subshellId: string): Promise<{ id: string; draft: boolean }[]> {
  const res = await page.request.get(`/api/workspaces?subshellId=${subshellId}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; draft: boolean }[];
}

/** One subshell's row, straight from the API. */
async function subshellRow(page: Page, id: string): Promise<{ harnessId: string; workingDir: string }> {
  const res = await page.request.get(`/api/subshells/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { harnessId: string; workingDir: string };
}

/** The id in the current `/subshells/<id>` or `/workspaces/<id>` URL. */
function idFromUrl(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

test("split a subshell into a draft workspace, then save it", async ({ page }) => {
  // Two real tmux launches plus a dock mount; the 30 s default is not enough.
  test.setTimeout(180_000);
  const attempt = test.info().retry;
  const subshellName = `e2e-split-${attempt}`;
  const workspaceName = `e2e-split-ws-${attempt}`;

  await launchSubshell(page, subshellName);
  const rootSubshellId = idFromUrl(page);

  // Nothing holds this subshell yet, so the header offers no way back to a
  // workspace — only the split.
  expect(await workspacesHolding(page, rootSubshellId)).toEqual([]);
  // Read back what the server stored rather than what was typed: it RESOLVES
  // the path (on macOS /tmp is a symlink to /private/tmp), and the seeded form
  // carries the resolved one because that is what the subshell row says.
  const root = await subshellRow(page, rootSubshellId);

  await page.getByRole("button", { name: "Split this subshell into a workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a subshell" })).toBeVisible();
  await page.getByRole("button", { name: "New subshell" }).click();

  // The split seeds the New half from the subshell being split, so the form
  // arrives as "another one like this" and needs no filling in. Asserting the
  // seeded values IS the test of `initialForm`; a form that had to be filled
  // by hand here would pass every later step just the same.
  await expect(page.locator("#picker-agent")).toHaveValue("pi");
  expect(root.harnessId).toBe("pi");
  await expect(page.locator("#picker-working-dir")).toHaveValue(root.workingDir);
  // "Split right" is the direction control's default; click it anyway so the
  // spec states the direction it is asserting rather than inheriting it.
  await page.getByRole("button", { name: "Split right" }).click();
  await page.getByRole("button", { name: "Start subshell" }).click();

  // The draft workspace is created around the current subshell and the picked
  // one rides the URL. Long leash: the click launches a real tmux pane first.
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  const workspaceId = idFromUrl(page);

  // Both panes land, and the params are stripped once the add has been
  // consumed — a URL that keeps `add=` is one a reload would replay.
  await expect(page.locator(".dv-default-tab")).toHaveCount(2, { timeout: SPAWN_TIMEOUT });
  await expect(page).not.toHaveURL(/[?&]add=/, { timeout: SPAWN_TIMEOUT });
  await expect(page.getByText("Unsaved workspace")).toBeVisible();

  // It is a draft on the server too, and it is invisible to the list that
  // feeds /workspaces and the sidebar.
  const holding = await workspacesHolding(page, rootSubshellId);
  expect(holding.map((w) => ({ id: w.id, draft: w.draft }))).toEqual([{ id: workspaceId, draft: true }]);
  const listed = (await (await page.request.get("/api/workspaces")).json()) as { id: string }[];
  expect(listed.some((w) => w.id === workspaceId)).toBe(false);

  // Regression #13: a reload with the params already gone must not re-add.
  await page.reload();
  await expect(page.locator(".dv-default-tab")).toHaveCount(2, { timeout: SPAWN_TIMEOUT });
  await expect(page.getByText("Unsaved workspace")).toBeVisible();

  // Saving it is naming it — one PUT, and the header stops calling it unsaved.
  await page.getByRole("button", { name: "Save workspace…" }).click();
  await expect(page.getByRole("heading", { name: "Save workspace" })).toBeVisible();
  await page.getByRole("textbox", { name: "Workspace name" }).fill(workspaceName);
  await page.getByRole("button", { name: "Save workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename workspace" })).toHaveText(workspaceName);
  await expect(page.getByText("Unsaved workspace")).toHaveCount(0);

  // And only now does it reach the list every other surface reads.
  await page.goto("/workspaces");
  await expect(page.getByRole("main").getByText(workspaceName)).toBeVisible();
});

test("closing a pane of an unsaved workspace discards it and lands on the subshell that remains", async ({ page }) => {
  test.setTimeout(180_000);
  const attempt = test.info().retry;
  const rootName = `e2e-split-close-root-${attempt}`;
  const otherName = `e2e-split-close-other-${attempt}`;

  // Two subshells, launched separately: this half of the flow splits onto an
  // EXISTING one, which is both the faster path and the other half of the
  // picker.
  await launchSubshell(page, otherName);
  const otherSubshellId = idFromUrl(page);
  await launchSubshell(page, rootName);
  const rootSubshellId = idFromUrl(page);

  await page.getByRole("button", { name: "Split this subshell into a workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a subshell" })).toBeVisible();
  // The subshell being split is excluded from its own picker; the other one
  // is the only sensible pick and picking it adds the pane immediately.
  // Rows are buttons whose accessible name is the whole line (name, directory,
  // agent, elapsed), so they are addressed by a pattern rather than a string.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: new RegExp(rootName) })).toHaveCount(0);
  await dialog.getByRole("button", { name: new RegExp(otherName) }).click();

  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  const workspaceId = idFromUrl(page);
  await expect(page.locator(".dv-default-tab")).toHaveCount(2, { timeout: SPAWN_TIMEOUT });
  await expect(page.getByText("Unsaved workspace")).toBeVisible();

  // A draft below two panes is not a workspace at all: closing either tab
  // deletes it server-side and leaves the person on the subshell that is
  // still there, rather than on a one-tile dock with no name.
  await page.getByRole("button", { name: "Close tab" }).first().click();
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
  expect([rootSubshellId, otherSubshellId]).toContain(idFromUrl(page));

  const gone = await page.request.get(`/api/workspaces/${workspaceId}`);
  expect(gone.status()).toBe(404);
  expect(await workspacesHolding(page, rootSubshellId)).toEqual([]);
  expect(await workspacesHolding(page, otherSubshellId)).toEqual([]);
});
