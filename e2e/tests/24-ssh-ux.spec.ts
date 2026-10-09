import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Browser interaction around relay approval; transport cryptography is covered by spec 23. */
test("choose remote keys, approve, and return to the same destination without auto-launching", async ({ page }) => {
  const destination = "theo@build.example.com:2222";
  const fingerprint = `SHA256:${"A".repeat(43)}`;
  const nodes = [
    { id: "desk", name: "Connecting desktop" },
    { id: "keys", name: "Key laptop" },
  ].map((node) => ({
    ...node,
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: node.id,
    status: "online",
    access: "owner",
    canLaunch: true,
    canManage: true,
    sshEnabled: true,
    maintenance: false,
    held: null,
    harnesses: [],
    allowedDirs: [],
    capabilities: [],
  }));
  let approved = false;
  const launches: unknown[] = [];
  await page.route("**/api/nodes", (route) => route.fulfill({ json: { nodes } }));
  await page.route("**/api/ssh/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/saved-hosts")) return route.fulfill({ json: { saved: [], recent: [], defaultNodeId: "desk" } });
    if (path.endsWith("/aliases"))
      return route.fulfill({ json: { aliases: [], includeCycle: false, truncated: false } });
    if (path.endsWith("/launch")) {
      launches.push(request.postDataJSON());
      return route.fulfill({
        status: 409,
        json: { code: "SSH_GRANT_APPROVAL_REQUIRED", message: "Approval needed.", metadata: { requestId: "request" } },
      });
    }
    if (path.endsWith("/grant-requests"))
      return route.fulfill({
        json: {
          requests: approved
            ? []
            : [
                {
                  id: "request",
                  keyHomeNodeId: "keys",
                  bNodeId: "desk",
                  paneId: "not-created",
                  destination,
                  resolvedSelector: "build.example.com",
                  requestedFingerprints: [fingerprint],
                  status: "pending",
                  createdAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 86400000).toISOString(),
                },
              ],
        },
      });
    if (path.endsWith("/identities"))
      return route.fulfill({ json: { identities: [{ fingerprint, comment: "Work key" }] } });
    if (path.endsWith("/approve")) {
      approved = true;
      return route.fulfill({ json: { grant: { id: "grant" } } });
    }
    if (path.endsWith("/grants")) return route.fulfill({ json: { grants: [] } });
    if (path.endsWith("/host-pins")) return route.fulfill({ json: { pins: [] } });
    return route.continue();
  });
  await page.goto("/connect");
  await page.getByPlaceholder("Choose or type a destination").fill(destination);
  await page.getByRole("button", { name: destination, exact: true }).click();
  await page.getByRole("combobox", { name: "Use SSH keys from" }).click();
  await page.getByRole("option", { name: "Key laptop", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect(launches).toEqual([{ node: "desk", keyHome: "keys", destination }]);
  await page.getByRole("link", { name: "Review SSH approval" }).click();
  await expect(page.getByText("New SSH connection (not started)")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/original connection did not start/)).toBeVisible();
  await page.getByRole("link", { name: "Return to Connect" }).click();
  await expect(page.getByPlaceholder("Choose or type a destination")).toHaveValue(destination);
  await expect(page.getByRole("combobox", { name: "Use SSH keys from" })).toHaveValue("Key laptop");
  expect(launches).toHaveLength(1);
  await page.screenshot({ path: "/tmp/ssh-m2-ux-connect.png", fullPage: true });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect(launches).toHaveLength(2);
});
