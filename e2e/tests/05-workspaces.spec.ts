import { expect, test } from "@playwright/test";
import {
  ADMIN_STATE,
  dismissDirectoryPanel,
  newSubshellName,
  pickAgent,
  showNewSubshellForm,
  subshellIds,
} from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Pane waits are generous: "Start subshell" spawns real tmux + the pi stub. */
const PANE_TIMEOUT = 30_000;

test("create a workspace, add a subshell pane, and the layout survives reload", async ({ page }) => {
  await page.goto("/workspaces");
  await page.getByRole("combobox", { name: "Switch workspace" }).click();
  await page.getByRole("option", { name: "New workspace", exact: true }).click();
  // Creation no longer happens on click (spec 2026-09-03 sidebar-quickadd §4b):
  // the button opens NewWorkspaceDialog. Zero selected is the valid "empty
  // workspace, fill it inside" answer — the old immediate-create behavior.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New workspace" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Wide viewport (Desktop Chrome) → dock. The add button's accessible name
  // is its aria-label "Add a subshell to this workspace" (aria-label wins over
  // the "Add subshell" text content), so a partial label would not match.
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  // With nothing on the instance yet, the dialog can open straight on the
  // New half (newOnly): no segmented control, title "New subshell". The
  // helper lands on the launch form whichever half it opened on.
  await showNewSubshellForm(page);
  // Stable id from NewSubshellForm; the only other control group in the dialog
  // (direction) is buttons, not comboboxes, but the id survives either way.
  // Agent options render as the plugin display name, greyed never hidden;
  // pick pi exactly (the stub pi is the only agent binary the e2e stack
  // owns). The Preset row is left untouched — a preset is optional since
  // spec 2026-09-13, and the consumed picker's empty input says so.
  await pickAgent(page.locator("#picker-agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel pushes "Start subshell" down the dialog's scroller; it dismisses only on an
  // outside click or Escape (blur/fill don't close it). Escape can't be used
  // here — in a modal dialog it closes the whole dialog, measured again on
  // 2026-09-11 (see the table on `dismissDirectoryPanel`) — so click the
  // heading: inside the dialog (stays open) but outside the picker root
  // (panel closes). Env-dependent: only bites when /tmp has directory entries
  // to populate the panel (CI's own playwright-artifacts-*).
  // The dialog's title is "New subshell" in the newOnly state, so match either.
  await dismissDirectoryPanel(page, /Add a subshell|New subshell/);
  // Sampled BEFORE the launch: the pane's title is the name the server gives
  // the new subshell, and the only way to know which row is new is to know
  // which rows are not.
  const before = await subshellIds(page);
  await page.getByRole("button", { name: "Start subshell" }).click();

  // The pane appears carrying the subshell's name as its panel title. The
  // launch form asks for no name, so that is the server's date/time default —
  // read it back rather than choosing it. Generous timeouts either side: the
  // POST creates a tmux session before the row exists or the panel is added.
  const paneName = await newSubshellName(page, before);
  await expect(page.getByText(paneName).first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Layout persists: reload re-reads the dock state from the API.
  await page.reload();
  await expect(page.getByText(paneName).first()).toBeVisible({ timeout: PANE_TIMEOUT });
});

/**
 * Regression (operator report 2026-10-30, iPad PWA with the Magic Keyboard):
 * returning to the workspace selected the BOTTOM tab, not the one on screen.
 * A dock whose stored layout lacks a pane — a second device's flush saved a
 * pre-dating snapshot, or panes added from the phone strip which never writes
 * the layout — re-appends the missing tiles, and dockview activates every
 * panel it adds by default, so the LAST backfilled pane (chronically the
 * newest) stole focus on every return. Backfill must reach the tab bar without
 * moving it: the restored `activeView` owns the focus.
 */
test("panes the saved layout forgot come back as tabs, without stealing focus", async ({ page }) => {
  test.setTimeout(150_000);
  const tag = `e2e-backfill-${test.info().retry}`;

  const mk = async (i: number): Promise<string> => {
    const res = await page.request.post("/api/subshells", {
      data: { harnessId: "pi", workingDir: "/tmp", name: `${tag}-p${i}` },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  const ids = [await mk(0), await mk(1), await mk(2)];
  await expect
    .poll(
      async () => {
        const rows = (await (await page.request.get("/api/subshells")).json()) as { id: string; alive: boolean }[];
        return ids.every((id) => rows.find((r) => r.id === id)?.alive === true);
      },
      { timeout: PANE_TIMEOUT },
    )
    .toBe(true);

  // A workspace holding the first two panes, with an explicit layout that
  // tiles them and points activeView at the SECOND one. The third pane is
  // added after the save, so the layout can only know it through backfill.
  // Pinning the restored pane to the non-first slot is what separates "the
  // saved activeView owns the focus" from "the first-pane fallback owns it".
  const wsRes = await page.request.post("/api/workspaces", { data: { name: tag, subshellId: ids[0] } });
  expect(wsRes.ok(), await wsRes.text()).toBe(true);
  const ws = (await wsRes.json()) as { id: string };
  const secondAdd = await page.request.post(`/api/workspaces/${ws.id}/panes`, { data: { subshellId: ids[1] } });
  expect(secondAdd.ok(), await secondAdd.text()).toBe(true);
  const detail0 = (await (await page.request.get(`/api/workspaces/${ws.id}`)).json()) as {
    panes: { id: string }[];
  };
  expect(detail0.panes.map((p) => p.id)).toHaveLength(2);
  const [paneA, paneB] = detail0.panes;
  const panelEntry = (pane: { id: string }, name: string) => ({
    id: pane.id,
    contentComponent: "subshell",
    params: { paneId: pane.id },
    title: name,
    renderer: "always",
  });
  const put = await page.request.put(`/api/workspaces/${ws.id}/layout`, {
    data: {
      layout: {
        grid: {
          root: {
            type: "branch",
            data: [
              {
                type: "leaf",
                data: { id: "1", views: [paneA.id, paneB.id], activeView: paneB.id },
                size: 1000,
              },
            ],
          },
          width: 1000,
          height: 660,
          orientation: "HORIZONTAL",
        },
        panels: { [paneA.id]: panelEntry(paneA, `${tag}-p0`), [paneB.id]: panelEntry(paneB, `${tag}-p1`) },
        activeGroup: "1",
      },
    },
  });
  expect(put.ok(), await put.text()).toBe(true);

  // The third pane the layout will never have seen — added AFTER the save.
  {
    const r = await page.request.post(`/api/workspaces/${ws.id}/panes`, { data: { subshellId: ids[2] } });
    expect(r.ok(), await r.text()).toBe(true);
  }

  try {
    await page.goto(`/workspaces/${ws.id}`);
    // All three tabs reach the strip…
    for (let i = 0; i < 3; i++) {
      await expect(page.locator(`.dv-tab:has-text("${tag}-p${i}")`)).toBeVisible({ timeout: PANE_TIMEOUT });
    }
    // …as background TABS of the one restored group, not stacked side-by-side
    // groups (an inactive add with nothing active anchors a fresh group each
    // time — the merge requires the dock to have something focused).
    await expect(page.locator(".dv-groupview")).toHaveCount(1);
    // …but the restored pane keeps the focus: the backfilled add (p2) must
    // not steal it (the operator's symptom), and neither may the first-pane
    // fallback (p0) — the saved activeView (p1) owns it.
    await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(`${tag}-p1`), {
      timeout: PANE_TIMEOUT,
    });
  } finally {
    await page.request.delete(`/api/workspaces/${ws.id}`).catch(() => undefined);
    for (const id of ids) {
      await page.request.post(`/api/subshells/${id}/terminate`).catch(() => undefined);
      await page.request.delete(`/api/subshells/${id}`).catch(() => undefined);
    }
  }
});

/**
 * Companion to the backfill test, pinning the other half of the dockview
 * rule (review 2026-10-30): the no-saved-layout dock. A workspace whose
 * panes were attached from the phone strip has no layout at all (the strip
 * never writes one), so the desktop's first open lays every pane through the
 * backfill loop with nothing focused. If those adds were all inactive,
 * dockview would mint a fresh stacked group per pane instead of one tab
 * group — the fix activates the first add so the rest merge into it. Asserts
 * one group, two tabs, first pane focused.
 */
test("a strip-built workspace opens as one tab group on the desktop, not stacked tiles", async ({ page }) => {
  test.setTimeout(150_000);
  const tag = `e2e-nostack-${test.info().retry}`;

  const mk = async (i: number): Promise<string> => {
    const res = await page.request.post("/api/subshells", {
      data: { harnessId: "pi", workingDir: "/tmp", name: `${tag}-p${i}` },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  const ids = [await mk(0), await mk(1)];
  await expect
    .poll(
      async () => {
        const rows = (await (await page.request.get("/api/subshells")).json()) as { id: string; alive: boolean }[];
        return ids.every((id) => rows.find((r) => r.id === id)?.alive === true);
      },
      { timeout: PANE_TIMEOUT },
    )
    .toBe(true);

  const wsRes = await page.request.post("/api/workspaces", { data: { name: tag, subshellId: ids[0] } });
  expect(wsRes.ok(), await wsRes.text()).toBe(true);
  const ws = (await wsRes.json()) as { id: string };
  const add = await page.request.post(`/api/workspaces/${ws.id}/panes`, { data: { subshellId: ids[1] } });
  expect(add.ok(), await add.text()).toBe(true);

  try {
    // No layout was ever saved: both panes arrive through the backfill.
    await page.goto(`/workspaces/${ws.id}`);
    for (let i = 0; i < 2; i++) {
      await expect(page.locator(`.dv-tab:has-text("${tag}-p${i}")`)).toBeVisible({ timeout: PANE_TIMEOUT });
    }
    await expect(page.locator(".dv-groupview")).toHaveCount(1);
    await expect(page.locator(".dv-tab.dv-active-tab")).toHaveText(new RegExp(`${tag}-p0`), {
      timeout: PANE_TIMEOUT,
    });
  } finally {
    await page.request.delete(`/api/workspaces/${ws.id}`).catch(() => undefined);
    for (const id of ids) {
      await page.request.post(`/api/subshells/${id}/terminate`).catch(() => undefined);
      await page.request.delete(`/api/subshells/${id}`).catch(() => undefined);
    }
  }
});

/**
 * The second bug this wave pins (operator report, 2026-09-27): deleting the
 * workspace you are STANDING on, from the sidebar, used to leave the page
 * rendering the dead workspace's cached detail forever — the same one-tree
 * blindness as a rail Close on a subshell. It must now drop to the subshell
 * view the pane's row still deserves. The dock is wide-view; this uses the
 * rail workspace row's Delete (a different tree from the page under test).
 */
test("deleting the open workspace from the sidebar drops you to the subshell", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/workspaces");
  await page.getByRole("combobox", { name: "Switch workspace" }).click();
  await page.getByRole("option", { name: "New workspace", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Add one subshell pane (a real `pi` stub) so there is a view to drop to.
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await showNewSubshellForm(page);
  await pickAgent(page.locator("#picker-agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  await dismissDirectoryPanel(page, /Add a subshell|New subshell/);
  const before = await subshellIds(page);
  await page.getByRole("button", { name: "Start subshell" }).click();
  await newSubshellName(page, before);
  await expect(page.locator(".dv-default-tab").first()).toBeVisible({ timeout: PANE_TIMEOUT });

  // Delete THIS workspace from the sidebar: the rail row is exactly the link
  // whose href carries the id the URL already shows, and its right-click
  // menu is the rail's own gesture, holding the shared "Delete workspace".
  await page
    .getByRole("combobox", { name: "Switch workspace" })
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .click();
  await page.getByRole("menuitem", { name: "Delete workspace" }).click();
  await expect(page.getByText("Delete this workspace?")).toBeVisible();
  await page.locator("[data-slot='dialog-content'] button", { hasText: /^Delete$/ }).click();

  // The page leaves the (now-dead) workspace for the subshell it held.
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: PANE_TIMEOUT });
});
