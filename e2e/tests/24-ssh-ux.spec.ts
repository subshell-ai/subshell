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
            canConfigure: true,
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
  return { launches, enables };
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
  await page.getByRole("button", { name: "Set up SSH", exact: true }).click();
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
