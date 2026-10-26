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
    if (path.endsWith("/recent-destinations")) return route.fulfill({ json: { recent: [], defaultNodeId: "desk" } });
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
  const presets: Record<string, unknown>[] = [];
  const saves: unknown[] = [];
  // A predicate, not a glob: in URL globs `?` is a single-character wildcard.
  await page.route(
    (url) => url.pathname === "/api/presets" && url.searchParams.get("kind") === "ssh",
    (route) => route.fulfill({ json: presets }),
  );
  await page.route("**/api/presets", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON();
    saves.push(payload);
    const preset = { ...payload, id: `ssh-${saves.length}`, enabled: 1 };
    presets.push(preset);
    return route.fulfill({ json: preset });
  });
  await page.route("**/api/presets/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const index = presets.findIndex((preset) => preset.id === id);
    if (route.request().method() === "DELETE") {
      presets.splice(index, 1);
      return route.fulfill({ json: { ok: true } });
    }
    if (route.request().method() === "PUT") {
      presets[index] = { ...presets[index], ...route.request().postDataJSON() };
      return route.fulfill({ json: presets[index] });
    }
    return route.continue();
  });
  return { launches, enables, nodes, presets, saves };
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

test("connection form selects keys without launching", async ({ page }) => {
  const { launches } = await wire(page);
  await page.goto("/connect");
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

test("legacy SSH settings opens the SSH preset library", async ({ page }) => {
  await wire(page);
  await page.goto("/settings/ssh");
  await expect(page).toHaveURL(/\/presets\?type=ssh$/);
  await expect(page.getByText("No SSH presets yet", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "New preset", exact: true }).click();
  await page.getByRole("menuitem", { name: "New SSH preset", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create SSH preset", exact: true })).toBeVisible();
});

test("saving before a failed SSH launch retains one preset across retry", async ({ page }) => {
  const { saves, launches, presets } = await wire(page);
  await page.goto("/connect");
  await page.getByLabel("SSH destination", { exact: true }).fill(destination);
  await page.getByRole("checkbox", { name: "Save as preset", exact: true }).check();
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeDisabled();
  await page.getByLabel("Preset name", { exact: true }).fill("Build terminal");
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await expect(page.getByText("Test connection stopped before launch.")).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(presets).toHaveLength(1);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await expect.poll(() => launches.length).toBe(2);
  expect(saves).toHaveLength(1);
});

test("SSH preset selection restores remote key choices without connecting", async ({ page }) => {
  const { presets, launches } = await wire(page);
  presets.push({
    id: "remote",
    kind: "ssh",
    name: "Remote build",
    description: null,
    nodeId: "desk",
    destination,
    alias: null,
    authentication: "remote",
    keyHome: "local",
    fingerprints: [fingerprint],
    enabled: 1,
  });
  await page.goto("/new?kind=ssh&preset=remote");
  await expect(page.getByLabel("SSH destination", { exact: true })).toHaveValue(destination);
  await expect(page.getByRole("radio", { name: "Use another node’s keys", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Work key", exact: true })).toBeChecked();
  expect(launches).toHaveLength(0);
});

test("local-key SSH presets restore the authentication choice and require a fresh key", async ({ page }) => {
  const { presets, launches } = await wire(page);
  presets.push({
    id: "local-key",
    kind: "ssh",
    name: "Personal build",
    description: null,
    nodeId: "desk",
    destination,
    alias: null,
    authentication: "local-key",
    keyHome: null,
    fingerprints: [],
    enabled: 1,
  });
  await page.goto("/new?kind=ssh&preset=local-key");
  await expect(page.getByLabel("SSH destination", { exact: true })).toHaveValue(destination);
  await expect(page.getByRole("radio", { name: "Use a key from my machine", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeDisabled();
  expect(launches).toHaveLength(0);
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
  // The fingerprint and the unverified-identity warning are shown at the
  // decision itself (spec 2026-10-17 UX pass); there is no disclosure to open.
  await expect(confirmation.getByText("SHA256:destination-identity", { exact: true })).toBeVisible();
  await expect(confirmation.getByText(/independently verified/)).toBeVisible();
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

test("SSH presets can be created, edited, cloned, opened, and deleted", async ({ page }) => {
  const { presets, launches } = await wire(page);
  await page.goto("/presets?type=ssh");
  await page.getByRole("button", { name: "New preset", exact: true }).click();
  await page.getByRole("menuitem", { name: "New SSH preset", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create SSH preset", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("   ");
  await dialog.getByLabel("SSH destination", { exact: true }).fill("user@host:70000");
  await expect(dialog.getByText("Enter a preset name.", { exact: true })).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("Build login");
  await expect(dialog.getByText("Enter a port between 1 and 65535.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save preset", exact: true })).toBeDisabled();
  expect(presets).toHaveLength(0);
  await dialog.getByLabel("SSH destination", { exact: true }).fill(destination);
  await dialog.getByRole("combobox", { name: "Connect from", exact: true }).click();
  await page.getByRole("option", { name: /Connecting desktop/ }).click();
  await dialog.getByRole("radio", { name: "Use a key from my machine", exact: true }).check();
  await page.screenshot({ path: "test-results/ssh-preset-editor.png", fullPage: true });
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: "test-results/ssh-preset-library.png", fullPage: true });
  expect(presets[0].authentication).toBe("local-key");
  expect(launches).toHaveLength(0);
  await page.getByRole("button", { name: "Build login", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit SSH preset", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Personal build");
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for Personal build", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clone preset", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Clone SSH preset", exact: true });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Personal build (copy)");
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(presets).toHaveLength(2);
  await page.getByRole("button", { name: "Actions for Personal build (copy)", exact: true }).click();
  await page.getByRole("menuitem", { name: "Connect", exact: true }).click();
  await expect(page.getByLabel("SSH destination", { exact: true })).toHaveValue(destination);
  await expect(page.getByRole("radio", { name: "Use a key from my machine", exact: true })).toBeChecked();
  expect(launches).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto("/presets?type=ssh");
  await page.getByRole("button", { name: "Actions for Personal build (copy)", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete preset", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete this preset?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Personal build (copy)", exact: true })).toHaveCount(0);
  expect(presets).toHaveLength(1);
});
