import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

// The viewer can configure this node, but only its owner can share or stop it.
const node = {
  id: "disabled-controls",
  name: "Shared workstation",
  kind: "agent",
  os: "linux",
  arch: "x64",
  hostname: "shared-workstation",
  status: "online",
  lastSeenAt: null,
  agentVersion: "1.5.3",
  protocolVersion: 12,
  access: "edit",
  canManage: false,
  canRetire: false,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
  runtime: {
    startedAt: "2026-10-12T00:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/home/owner/.config/systemd/user/subshell.service",
      state: "running",
      pid: 1000,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/home/owner/.config/subshell/config.json",
    agentLogPath: "/home/owner/.config/subshell/agent.log",
    logging: { debug: false, source: "default" },
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/usr/local/bin/subshell",
  },
};

async function openNode(page: Page) {
  const mutations: string[] = [];
  await page.route(`**/api/nodes/${node.id}**`, async (route) => {
    if (route.request().method() !== "GET") {
      mutations.push(route.request().url());
      await route.fulfill({ status: 403, json: { message: "Only the node owner can do this." } });
      return;
    }
    await route.fulfill({ json: node });
  });
  await page.goto(`/nodes/${node.id}`);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  return mutations;
}

test("disabled node controls explain ownership on hover and keyboard focus", async ({ page }) => {
  const mutations = await openNode(page);
  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeDisabled();
  await share.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Only the node owner can change sharing for this node.");
  await page.mouse.move(0, 0);
  await share.focus();
  await expect(share).toBeFocused();
  await expect(share).toHaveAccessibleDescription("Only the node owner can change sharing for this node.");
  await share.press("Enter");
  await share.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(page.getByText("Only the node owner can change these rules.")).toHaveClass(/text-warning/);
  await page.goto(`/nodes/${node.id}/service`);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Only the node owner can stop this service.");
  await stop.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const uninstall = page.getByRole("button", { name: "Uninstall service", exact: true });
  await uninstall.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Only the node owner can uninstall this service.");
  await uninstall.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations).toEqual([]);
  await expect(page.getByText("Only the node owner can stop or uninstall this service.")).toHaveClass(/text-warning/);
});

test.describe("touch explanations", () => {
  test.use({ hasTouch: true });
  test("a tap explains the restriction without sending a service command", async ({ page }) => {
    const mutations = await openNode(page);
    await page.goto(`/nodes/${node.id}/service`);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    // Playwright correctly considers aria-disabled unavailable to tap; the
    // touchscreen gesture still needs to reach it to show the explanation.
    await stop.scrollIntoViewIfNeeded();
    const box = await stop.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Stop button has no bounds");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("tooltip")).toHaveText("Only the node owner can stop this service.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(mutations).toEqual([]);
  });
});

test("a disabled submit explains missing input above its dialog", async ({ page }) => {
  await page.goto("/presets");
  await page.getByRole("button", { name: "New preset", exact: true }).click();
  await page.getByRole("menuitem", { name: "New agent preset", exact: true }).click();
  const submit = page.getByRole("dialog").getByRole("button", { name: "Create preset", exact: true });
  await expect(submit).toBeDisabled();
  await submit.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Choose an agent or shell first.");
  expect(
    await tooltip.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }),
  ).toBe(true);
  await submit.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
});
