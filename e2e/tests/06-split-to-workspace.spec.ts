import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Real tmux spawns sit behind every launch here; the dock add is another round trip. */
const SPAWN_TIMEOUT = 30_000;

/**
 * Splitting a running subshell (spec 2026-09-14, draft-less by spec 2026-10-17).
 *
 * The flow under test is deliberately end-to-end: a split creates a real
 * workspace — named after the subshell, on the server, from the first
 * moment — carries the picked second pane through `?add=`/`?dir=` search
 * params, and the dock adds it through the same `handleAdd` every later add
 * uses, then strips the params. None of that is visible to a unit test, and
 * the two failures it is guarding against are both URL-shaped: a reload that
 * re-consumes the intent and adds a duplicate pane, and params that never get
 * stripped. The workspace half used to be "then save it"; since drafts are
 * gone there is nothing to save, and this suite instead pins that the row is
 * REAL immediately and self-retires only when its last tab leaves.
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

/** Every workspace the signed-in user has holding `subshellId`. */
async function workspacesHolding(page: Page, subshellId: string): Promise<{ id: string }[]> {
  const res = await page.request.get(`/api/workspaces?subshellId=${subshellId}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string }[];
}

/** One subshell's row, straight from the API. */
async function subshellRow(page: Page, id: string): Promise<{ harnessId: string; workingDir: string }> {
  const res = await page.request.get(`/api/subshells/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { harnessId: string; workingDir: string };
}

/**
 * Closes the subshells a test launched. The suite shares one database and one
 * tmux server across every spec (`workers: 1`), so each left-behind pane is a
 * live process every later spec pays for. "Close" is DELETE (spec 2026-09-03);
 * an already-gone id is fine — the point is that nothing this file started is
 * still running when the next file begins. A workspace whose tabs all left has
 * already retired itself (spec 2026-10-17), so only a still-named empty row,
 * if any, needs the explicit DELETE.
 */
async function closeSubshells(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/subshells/${id}`);
}

/** The id in the current `/subshells/<id>` or `/workspaces/<id>` URL. */
function idFromUrl(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

test("split a subshell into a real, named workspace", async ({ page }) => {
  // Two real tmux launches plus a dock mount; the 30 s default is not enough.
  test.setTimeout(180_000);
  const attempt = test.info().retry;
  const subshellName = `e2e-split-${attempt}`;

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
  // The split's dialog is titled by the button that opened it (2026-09-27).
  await expect(page.getByRole("heading", { name: "Split", exact: true })).toBeVisible();
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

  // The workspace is created around the current subshell and the picked one
  // rides the URL. Long leash: the click launches a real tmux pane first.
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
  const workspaceId = idFromUrl(page);

  // Both panes land, and the params are stripped once the add has been
  // consumed — a URL that keeps `add=` is one a reload would replay.
  await expect(page.locator(".dv-default-tab")).toHaveCount(2, { timeout: SPAWN_TIMEOUT });
  await expect(page).not.toHaveURL(/[?&]add=/, { timeout: SPAWN_TIMEOUT });

  // There is no unsaved state to graduate from: the header already wears the
  // name the split chose (the split's subshell, spec 2026-10-17), and the row
  // is in every list the moment the POST answered.
  await expect(page.getByRole("button", { name: "Rename workspace" })).toHaveText(subshellName);
  const holding = await workspacesHolding(page, rootSubshellId);
  expect(holding.map((w) => w.id)).toEqual([workspaceId]);
  // The LIST now carries each workspace's panes (the sidebar tree renders
  // straight from it, no per-workspace GET): reading it back here pins that
  // the split's workspace is in there holding BOTH tabs.
  const detail = (await (await page.request.get(`/api/workspaces/${workspaceId}`)).json()) as {
    panes: { subshellId: string }[];
  };
  const listed = (await (await page.request.get("/api/workspaces")).json()) as {
    id: string;
    panes?: { subshellId: string }[];
  }[];
  const row = listed.find((w) => w.id === workspaceId);
  expect(row).toBeTruthy();
  expect(row?.panes?.map((p) => p.subshellId).sort()).toEqual(detail.panes.map((p) => p.subshellId).sort());
  // The split's own subshell is one of them: the POST filed it, the dock did
  // not re-add it (that would be the duplicate this page's reload test guards).
  expect(detail.panes.some((p) => p.subshellId === rootSubshellId)).toBe(true);

  // Regression #13: a reload with the params already gone must not re-add.
  await page.reload();
  await expect(page.locator(".dv-default-tab")).toHaveCount(2, { timeout: SPAWN_TIMEOUT });
  await expect(page.getByRole("button", { name: "Rename workspace" })).toHaveText(subshellName);

  // Cleaning up by DELETE rather than by closing tabs: the self-retire the
  // next test pins deliberately would fire here too, and deleting the subshells
  // themselves is what actually frees the tmux processes.
  await closeSubshells(
    page,
    detail.panes.map((p) => p.subshellId),
  );
  await page.request.delete(`/api/workspaces/${workspaceId}`);
});

test("removing a pane leaves the workspace; removing its last tab retires it", async ({ page }) => {
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
  // The split's dialog is titled by the button that opened it (2026-09-27).
  await expect(page.getByRole("heading", { name: "Split", exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Rename workspace" })).toHaveText(rootName);

  // Under the old draft model a two-pane split was an unsaved arrangement and
  // closing either tab threw the whole thing away. Since spec 2026-10-17 a
  // workspace is exactly as real as its tabs: closing one of two leaves the
  // other holding a still-named, still-listed workspace.
  await page.getByRole("button", { name: "Close tab" }).first().click();
  await expect(page.locator(".dv-default-tab")).toHaveCount(1, { timeout: SPAWN_TIMEOUT });
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}`));
  const survivors = (await (await page.request.get(`/api/workspaces/${workspaceId}`)).json()) as {
    panes: unknown[];
  };
  expect(survivors.panes).toHaveLength(1);

  // The LAST tab is the different thing: it took the whole workspace with it
  // (the row self-retires at zero panes, spec 2026-10-17), so the page has
  // nowhere to stay — the landing it falls to re-aims at whatever workspace
  // still exists. What the test can pin from here is the server's truth: the
  // row is gone and nothing holds the panes any more.
  await page.getByRole("button", { name: "Close tab" }).first().click();
  await expect(page).not.toHaveURL(new RegExp(`/workspaces/${workspaceId}`), { timeout: SPAWN_TIMEOUT });
  const gone = await page.request.get(`/api/workspaces/${workspaceId}`);
  expect(gone.status()).toBe(404);
  expect(await workspacesHolding(page, rootSubshellId)).toEqual([]);
  expect(await workspacesHolding(page, otherSubshellId)).toEqual([]);

  await closeSubshells(page, [rootSubshellId, otherSubshellId]);
});
