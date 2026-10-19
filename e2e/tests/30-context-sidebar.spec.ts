import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("the two rails isolate workspace panes and restore each section's destination", async ({ page }) => {
  const panes: string[] = [];
  const workspaces: string[] = [];
  const suffix = Date.now();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<{ id: string }>;
  };
  try {
    for (const name of [`Sidebar first ${suffix}`, `Sidebar second ${suffix}`]) {
      const pane = await post("/api/subshells", { harnessId: "terminal", name, workingDir: "/tmp" });
      panes.push(pane.id);
      const workspace = await post("/api/workspaces", { name, subshellId: pane.id });
      workspaces.push(workspace.id);
    }
    await page.goto(`/workspaces/${workspaces[0]}`);
    const rail = page.getByRole("navigation", { name: "Main sections" });
    const sidebar = page.locator("aside");
    await page
      .getByRole("combobox", { name: "Switch workspace" })
      .locator("..")
      .getByRole("button", { name: /^Actions for / })
      .click();
    await page.getByRole("menuitem", { name: "Add subshell", exact: true }).click();
    const addDialog = page.getByRole("dialog", { name: "Add a subshell", exact: true });
    await expect(addDialog.getByRole("button", { name: "Existing subshell", exact: true })).toBeVisible();
    await expect(addDialog.getByRole("button", { name: "New subshell", exact: true })).toBeVisible();
    await expect(addDialog.getByRole("button", { name: "Split right", exact: true })).toHaveCount(0);
    await addDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sidebar.locator(`a[href="/subshells/${panes[0]}"]`)).toBeVisible();
    await expect(sidebar.locator(`a[href="/subshells/${panes[1]}"]`)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Switch workspace" }).click();
    await page.getByRole("option", { name: `Sidebar second ${suffix}` }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaces[1]}$`));
    await expect(sidebar.locator(`a[href="/subshells/${panes[1]}"]`)).toBeVisible();
    await expect(sidebar.locator(`a[href="/subshells/${panes[0]}"]`)).toHaveCount(0);
    await sidebar.locator(`a[href="/subshells/${panes[1]}"]`).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Edit title", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await rail.getByRole("link", { name: "Subshells", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaces[1]}$`));
    await expect(sidebar.getByRole("combobox", { name: "Group sidebar subshells by" })).toBeVisible();
    await sidebar.locator(`a[href="/subshells/${panes[0]}"]`).click();
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/workspaces/${workspaces[1]}`);
        const detail = await response.json();
        return detail.panes.some((pane: { subshellId: string }) => pane.subshellId === panes[0]);
      })
      .toBe(true);
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaces[1]}$`));
    await sidebar.getByRole("button", { name: "Actions for Subshells", exact: true }).click();
    await page.getByRole("menuitem", { name: "Subshell dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/subshells$/);
    await rail.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaces[1]}$`));

    await rail.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("link", { name: "Presets", exact: true })
      .click();
    await rail.getByRole("link", { name: "Subshell for Mobile", exact: true }).click();
    await page.getByRole("link", { name: "Android", exact: true }).click();
    await expect(page).toHaveURL(/\/mobile\?platform=android$/);
    await expect(page.getByText("Open the address above in Chrome.", { exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/presets$/);
    await rail.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaces[1]}$`));
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("combobox", { name: "Switch workspace" })).toHaveCount(0);
    await rail.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Switch workspace" })).toBeVisible();
  } finally {
    for (const id of panes) await page.request.delete(`/api/subshells/${id}`);
  }
});
