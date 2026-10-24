import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { writePreviewProject } from "../fixtures/preview-site/project";
import { BASE_URL } from "../ports";
import { verifyPreviewBrowser } from "../preview-browser-check";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });
test("preview documents isolate dashboard authority while modules, POST and WS keep working", async ({
  page,
  request,
}) => {
  test.skip(process.platform !== "linux", "Automatic preview discovery needs Linux /proc");
  test.setTimeout(90000);
  const project = mkdtempSync(path.join(tmpdir(), "preview-browser-check-"));
  const nodes = await (await request.get("/api/nodes")).json();
  const wasEnabled = nodes.nodes.find((node: { id: string }) => node.id === "local")?.viewsEnabled;
  let subshellId: string | undefined;
  try {
    writePreviewProject(project);
    expect((await request.put("/api/nodes/local/views-enabled", { data: { on: true } })).ok()).toBe(true);
    const launch = await request.post("/api/subshells", {
      data: { harnessId: "terminal", nodeId: "local", workingDir: project, name: "Preview browser check" },
    });
    expect(launch.ok(), await launch.text()).toBe(true);
    subshellId = (await launch.json()).id;
    await expect
      .poll(
        async () => {
          const res = await request.post(`/api/subshells/${subshellId}/exec`, {
            data: { command: "DEMO_PORT=0 bun server.ts > server.log 2>&1 & echo $! > server.pid", timeoutMs: 2000 },
          });
          if (res.status() === 409 && (await res.json()).code === "EXEC_PANE_BUSY") return false;
          expect(res.ok(), await res.text()).toBe(true);
          return true;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    let port: number | undefined;
    await expect
      .poll(() => {
        const file = path.join(project, "server.log");
        const match = existsSync(file) && /ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(file, "utf8"));
        if (match) port = Number(match[1]);
        return Boolean(port);
      })
      .toBe(true);
    const workspace = await request.post("/api/workspaces", { data: { name: "Preview isolation", subshellId } });
    expect(workspace.ok()).toBe(true);
    await page.goto(`/workspaces/${(await workspace.json()).id}`);
    await page.getByRole("button", { name: "Apps & screens", exact: true }).click();
    await page.getByRole("button", { name: `Open app on port ${port}` }).click();
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Small teams. Considered websites." }),
    ).toBeVisible();
    const frame = page.frames().find((frame) => frame.url().includes("/pv/"));
    if (!frame) throw new Error("Preview iframe missing");
    await verifyPreviewBrowser(frame, BASE_URL, true);
    const direct = await page.context().newPage();
    const proxyUrl = frame.url();
    await direct.goto(proxyUrl);
    await verifyPreviewBrowser(direct, BASE_URL, false);
    await direct.close();
    expect((await page.context().cookies()).some((cookie) => cookie.name === "demo")).toBe(false);
    expect((await request.delete(`/api/subshells/${subshellId}`)).ok()).toBe(true);
    subshellId = undefined;
    expect((await request.get(proxyUrl)).status()).toBe(404);
  } finally {
    if (subshellId) await request.delete(`/api/subshells/${subshellId}`);
    const pidFile = path.join(project, "server.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM");
      } catch {}
    }
    await request.put("/api/nodes/local/views-enabled", { data: { on: Boolean(wasEnabled) } });
    rmSync(project, { recursive: true, force: true });
  }
});
