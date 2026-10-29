import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });
test("a service outside the subshell saves, opens without a display, survives reload, and removes without stopping", async ({
  page,
  request,
}) => {
  let server: Server | undefined;
  let subshellId: string | undefined;
  let workspaceId: string | undefined;
  const nodes = await (await request.get("/api/nodes")).json();
  const wasEnabled = nodes.nodes.find((n: { id: string }) => n.id === "local")?.webPreviewsEnabled;
  try {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<h1>Outside the subshell</h1><p>${req.headers.host}</p>`);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    expect((await request.put("/api/nodes/local/views-enabled", { data: { on: true } })).ok()).toBe(true);
    const created = await request.post("/api/subshells", {
      data: { harnessId: "terminal", nodeId: "local", workingDir: "/tmp", name: "Saved service check" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    subshellId = (await created.json()).id;
    const workspace = await request.post("/api/workspaces", { data: { name: "Saved services", subshellId } });
    expect(workspace.ok()).toBe(true);
    workspaceId = (await workspace.json()).id;
    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
    await page.getByRole("button", { name: "Add service", exact: true }).click();
    await page.getByLabel("Port", { exact: true }).fill(String(port));
    await page.getByLabel("Name (optional)").fill("External website");
    await page.getByRole("dialog").screenshot({ path: "/tmp/426-add-service.png" });
    await page.getByRole("button", { name: "Save service", exact: true }).click();
    await page.getByRole("button", { name: /External website.*http:\/\/localhost/ }).click();
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Outside the subshell" })).toBeVisible();
    await expect(page.frameLocator("iframe").getByText(`localhost:${port}`, { exact: true })).toBeVisible();
    const frame = page.frames().find((frame) => frame.url().includes("/pv/"));
    if (!frame) throw new Error("Saved service iframe missing");
    const proxy = frame.url();
    await expect(page.locator("iframe")).toHaveAttribute("sandbox", /allow-scripts/);
    await page.getByRole("button", { name: "More view actions" }).click();
    await page.getByRole("menuitem", { name: "Configure preview" }).click();
    await page.getByRole("checkbox", { name: "Run outside the sandbox" }).check();
    await expect(page.getByText(/This site can access your Subshell browser session/)).toBeVisible();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Outside the subshell" })).toBeVisible();
    await expect(page.locator("iframe")).not.toHaveAttribute("sandbox");
    await expect
      .poll(async () => {
        const current = page.frames().find((candidate) => candidate.url().includes("/pv/"));
        return current?.evaluate(() => parent.document.title);
      })
      .not.toBeUndefined();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Outside the subshell" })).toBeVisible();
    await expect(page.locator("iframe")).not.toHaveAttribute("sandbox");
    await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
    await expect(page.getByRole("button", { name: /External website.*http:\/\/localhost/ })).toBeVisible();
    await page.getByRole("button", { name: "Remove External website", exact: true }).click();
    await expect(page.getByRole("button", { name: /External website.*http:\/\/localhost/ })).toHaveCount(0);
    expect(await request.get(`/api/subshells/${subshellId}/services`).then((res) => res.json())).toEqual([]);
    expect((await request.get(proxy)).status()).toBe(404);
    expect((await request.get(`http://127.0.0.1:${port}`)).ok()).toBe(true);
  } finally {
    if (workspaceId) await request.delete(`/api/workspaces/${workspaceId}`);
    if (subshellId) await request.delete(`/api/subshells/${subshellId}`);
    await request.put("/api/nodes/local/views-enabled", { data: { on: Boolean(wasEnabled) } });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
});
