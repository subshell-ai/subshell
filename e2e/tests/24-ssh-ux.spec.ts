import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });
const destination = "theo@build.example.com:2222";
const fingerprint = `SHA256:${"A".repeat(43)}`;

/** Browser interaction around setup and explicit key selection; spec23 exercises real cryptography. */
async function wire(page: Page, ready = true) {
  const nodes = [
    { id: "desk", name: "Connecting desktop", kind: "agent" },
    { id: "local", name: "Named server", kind: "local" },
  ].map((node) => ({
    ...node,
    os: "linux",
    arch: "x64",
    hostname: node.id,
    status: "online",
    access: "owner",
    canLaunch: true,
    canManage: true,
    sshEnabled: ready,
    maintenance: false,
    held: null,
    harnesses: [],
    allowedDirs: [],
    capabilities: [],
  }));
  const launches: unknown[] = [];
  const enables: string[] = [];
  await page.route("**/api/nodes", (route) => route.fulfill({ json: { nodes } }));
  await page.route("**/api/nodes/*/ssh-enabled", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const node = nodes.find((n) => n.id === id);
    if (node) node.sshEnabled = true;
    enables.push(id);
    return route.fulfill({ json: { sshEnabled: true } });
  });
  await page.route("**/api/ssh/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/readiness"))
      return route.fulfill({
        json: {
          machines: nodes.map((node) => ({
            node,
            canConnect: node.sshEnabled,
            canConfigure: node.canManage,
            blockers: node.sshEnabled ? [] : [{ code: "SSH_GATE_OFF", message: "SSH is off on this machine." }],
          })),
        },
      });
    if (path.endsWith("/saved-hosts")) return route.fulfill({ json: { saved: [], recent: [], defaultNodeId: "desk" } });
    if (path.endsWith("/aliases"))
      return route.fulfill({ json: { aliases: [], includeCycle: false, truncated: false } });
    if (path.endsWith("/launch")) {
      launches.push(request.postDataJSON());
      return route.fulfill({
        status: 409,
        json: { code: "SSH_RELAY_OPEN_FAILED", message: "Test connection stopped before launch." },
      });
    }
    if (path.endsWith("/identities"))
      return route.fulfill({ json: { identities: [{ fingerprint, comment: "Work key" }] } });
    if (path.endsWith("/host-pins")) return route.fulfill({ json: { pins: [] } });
    return route.continue();
  });
  return { launches, enables, nodes };
}

test("connection form reveals remote keys inline and launches only the selected keys", async ({ page }) => {
  const { launches } = await wire(page);
  await page.goto("/connect");
  await page.getByLabel("SSH destination", { exact: true }).fill(destination);
  await page.getByRole("radio", { name: "Use another node’s keys", exact: true }).check();
  await page.getByRole("combobox", { name: "Use keys from", exact: true }).click();
  await page.getByRole("option", { name: "Named server", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Work key", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Work key", exact: true }).check();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  expect(launches).toEqual([{ node: "desk", keyHome: "local", fingerprints: [fingerprint], destination }]);
  await expect(page.getByText("Test connection stopped before launch.")).toBeVisible();
});

test("enables the connecting node when Start is selected", async ({ page }) => {
  const { launches, enables } = await wire(page, false);
  await page.goto("/connect");
  await page.getByLabel("SSH destination", { exact: true }).fill(destination);
  await page.getByRole("combobox", { name: "Connect from" }).click();
  await page.getByRole("option", { name: /Connecting desktop/ }).click();
  await expect(page.getByText("Starting this subshell will enable outgoing SSH on this node.")).toBeVisible();
  expect(enables).toHaveLength(0);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await expect(page.getByText("Test connection stopped before launch.")).toBeVisible();
  expect(enables).toEqual(["desk"]);
  expect(launches).toHaveLength(1);
});

test("settings connection form selects keys without launching", async ({ page }) => {
  const { launches } = await wire(page);
  await page.goto("/settings/ssh");
  await page.getByRole("button", { name: "Connect over SSH", exact: true }).click();
  await page.getByRole("radio", { name: "Use another node’s keys", exact: true }).check();
  await page.getByRole("combobox", { name: "Use keys from", exact: true }).click();
  await page.getByRole("option", { name: "Named server", exact: true }).click();
  await page.getByRole("checkbox", { name: "Work key", exact: true }).check();
  expect(launches).toHaveLength(0);
  await expect(page.getByLabel("SSH destination", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Work key", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("polls while waiting for the owner to enable SSH", async ({ page }) => {
  const { nodes, enables } = await wire(page, false);
  nodes[0].canManage = false;
  nodes[0].access = "edit";
  await page.goto("/connect");
  await page.getByRole("combobox", { name: "Connect from" }).click();
  await page.getByRole("option", { name: /Connecting desktop/ }).click();
  await page.getByLabel("SSH destination", { exact: true }).fill(destination);
  await expect(page.getByText("Waiting for SSH to be enabled…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeDisabled();
  nodes[0].sshEnabled = true;
  await expect(page.getByText("Waiting for SSH to be enabled…")).toHaveCount(0, { timeout: 8000 });
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeEnabled();
  expect(enables).toHaveLength(0);
});

test("SSH settings keeps empty and populated cards usable at narrow and wide widths", async ({ page }) => {
  await wire(page);
  await page.goto("/settings/ssh");
  await expect(page.getByText("No saved destinations yet.")).toBeVisible();
  await expect(page.getByText("No recent destinations yet.")).toBeVisible();
  const longDestination = `developer@${"long-host-".repeat(12)}.example.com:2222`;
  await page.route("**/api/ssh/saved-hosts", (route) =>
    route.fulfill({
      json: {
        saved: [
          {
            id: "saved",
            destination: longDestination,
            alias: "Production",
            nodeId: "desk",
            savedAt: "2026-10-01T00:00:00Z",
            lastConnectAt: "2026-10-01T00:00:00Z",
          },
        ],
        recent: [],
        defaultNodeId: "desk",
      },
    }),
  );
  await page.reload();
  await expect(page.getByText(longDestination, { exact: true })).toBeVisible();
  for (const width of [320, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["Connect over SSH", "Forget Production"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      if (!bounds) throw new Error(`${name} has no visible bounds`);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/ssh-settings-${width}.png`, fullPage: true });
  }
});

test("unfamiliar destinations ask in the connection flow and cancellation saves nothing", async ({ page }) => {
  await wire(page);
  let launches = 0;
  const accepted: unknown[] = [];
  await page.route("**/api/ssh/launch", (route) => {
    launches++;
    return route.fulfill({
      status: 409,
      json: {
        code: accepted.length ? "SSH_HOST_PIN_CHANGED" : "SSH_HOST_PIN_MISSING",
        message: accepted.length ? "The destination identity changed. Connection blocked." : "Confirmation needed.",
      },
    });
  });
  await page.route("**/api/ssh/verify-destination", (route) =>
    route.fulfill({
      json: {
        token: "account-bound-check",
        destination,
        fingerprint: "SHA256:destination-identity",
      },
    }),
  );
  await page.route("**/api/ssh/verify-destination/accept", (route) => {
    accepted.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto("/connect");
  await page.getByLabel("SSH destination", { exact: true }).fill(destination);
  await page.getByRole("radio", { name: "Use another node’s keys", exact: true }).check();
  await page.getByRole("combobox", { name: "Use keys from", exact: true }).click();
  await page.getByRole("option", { name: "Named server", exact: true }).click();
  await page.getByRole("checkbox", { name: "Work key", exact: true }).check();
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Connect to this destination?", exact: true });
  await expect(confirmation.getByText(destination, { exact: true })).toBeVisible();
  await confirmation.getByText("Verification details", { exact: true }).click();
  await expect(confirmation.getByText("SHA256:destination-identity", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/ssh-destination-confirmation.png", fullPage: true });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(accepted).toEqual([]);
  expect(launches).toBe(1);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await confirmation.getByRole("button", { name: "Trust and connect", exact: true }).click();
  await expect(page.getByText("The destination identity changed. Connection blocked.", { exact: true })).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  expect(accepted).toEqual([{ token: "account-bound-check" }]);
  expect(launches).toBe(3); // two attempts, with one retry after confirmation
});
