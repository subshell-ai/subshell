import { expect, type Page, test } from "@playwright/test";
import {
  ADMIN_STATE,
  dismissDirectoryPanel,
  newSubshellName,
  pickAgent,
  showNewSubshellForm,
  subshellIds,
} from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** A populated workspace whose first pane is already the active tab. */
async function seedWorkspace(page: Page, tag: string): Promise<string> {
  const first = await page.request.post("/api/subshells", {
    data: { harnessId: "pi", workingDir: "/tmp", name: `e2e-focus-first-${tag}` },
  });
  const firstBody = (await first.json()) as { id: string };
  const workspace = await page.request.post("/api/workspaces", {
    data: { name: `e2e-focus-ws-${tag}`, subshellId: firstBody.id },
  });
  const workspaceBody = (await workspace.json()) as { id: string };

  await page.goto(`/workspaces/${workspaceBody.id}`);
  await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(`e2e-focus-first-${tag}`));
  return firstBody.id;
}

/** Delete everything this run created; `before` is the pre-test snapshot. */
async function deleteCreated(page: Page, before: string[], beforeSampled: boolean, firstId: string): Promise<void> {
  const after = await subshellIds(page).catch(() => []);
  if (beforeSampled) {
    for (const id of after.filter((id) => !before.includes(id))) {
      await page.request.delete(`/api/subshells/${id}`).catch(() => {});
    }
  }
  if (firstId) await page.request.delete(`/api/subshells/${firstId}`).catch(() => {});
}

/**
 * Regression: an add's detail refetch can land before the new pane's own
 * summary read. Reconciliation then tiles the pane INACTIVE (the dock already
 * has a focused tile), and the add handler must activate it afterwards — the
 * person who pressed Start expects the pane they just created.
 *
 * The route holds the summary GET until the tab count proves reconciliation
 * tiled the pane. Releasing it then lets the add handler finish. Counting the
 * delayed request keeps a regex or route drift from letting this pass against
 * the old behavior.
 */
test("a subshell added to a populated workspace becomes the active tab", async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 8);
  let before: string[] = [];
  let beforeSampled = false;
  let firstId = "";
  let releaseSummary: (() => void) | undefined;

  try {
    before = await subshellIds(page);
    beforeSampled = true;
    firstId = await seedWorkspace(page, tag);

    let delayed = 0;
    let held = false;
    await page.route(/\/api\/subshells\/[0-9a-f-]{36}$/, async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      if (route.request().method() === "GET" && !held && id !== firstId && !before.includes(id)) {
        held = true;
        delayed += 1;
        await new Promise<void>((resolve) => {
          releaseSummary = resolve;
        });
      }
      await route.continue().catch(() => {});
    });

    await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
    await showNewSubshellForm(page);
    await pickAgent(page.locator("#picker-agent"), "pi");
    await page.fill("#picker-working-dir", "/tmp");
    await dismissDirectoryPanel(page, /Add a subshell|New subshell/);
    const beforeAdd = await subshellIds(page);
    await page.getByRole("button", { name: "Start subshell" }).click();

    const name = await newSubshellName(page, beforeAdd);
    await expect.poll(() => delayed, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.locator(".dv-tab")).toHaveCount(2, { timeout: 30_000 });
    // Reconciliation has tiled the new pane but left the seeded tab active;
    // releasing the summary is what lets the add handler activate it.
    await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(`e2e-focus-first-${tag}`));
    releaseSummary?.();
    releaseSummary = undefined;

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(escaped));
  } finally {
    releaseSummary?.();
    await deleteCreated(page, before, beforeSampled, firstId);
  }
});

/**
 * The same add, with the new pane's summary read failing. The pane row exists
 * server-side, so the finally-block refetch still tiles it; the add handler's
 * failure path must arm the arrival focus so reconciliation's inactive tile
 * becomes the tab the person asked for, and the dock must still say the read
 * failed.
 */
test("a subshell whose summary read fails still becomes the active tab", async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 8);
  let before: string[] = [];
  let beforeSampled = false;
  let firstId = "";

  try {
    before = await subshellIds(page);
    beforeSampled = true;
    firstId = await seedWorkspace(page, tag);

    let failed = 0;
    await page.route(/\/api\/subshells\/[0-9a-f-]{36}$/, async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      if (route.request().method() === "GET" && id !== firstId && !before.includes(id)) {
        failed += 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "summary read failed" }),
        });
        return;
      }
      await route.continue().catch(() => {});
    });

    await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
    await showNewSubshellForm(page);
    await pickAgent(page.locator("#picker-agent"), "pi");
    await page.fill("#picker-working-dir", "/tmp");
    await dismissDirectoryPanel(page, /Add a subshell|New subshell/);
    const beforeAdd = await subshellIds(page);
    await page.getByRole("button", { name: "Start subshell" }).click();

    const name = await newSubshellName(page, beforeAdd);
    await expect.poll(() => failed, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.locator(".dv-tab")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByRole("alert").filter({ hasText: "summary read failed" })).toBeVisible();

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(escaped));
  } finally {
    await deleteCreated(page, before, beforeSampled, firstId);
  }
});
