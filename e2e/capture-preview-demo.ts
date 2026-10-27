import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, request } from "@playwright/test";
import { writePreviewProject } from "./fixtures/preview-site/project";
import { BASE_URL, PORTS } from "./ports";
import { verifyPreviewBrowser } from "./preview-browser-check";
import { captureScreenshot } from "./screenshot";
import { startStack, stopStack } from "./stack";

if (PORTS.backend === 3080) throw new Error("Never capture against the live server");
const securityOnly = process.argv.includes("--security-only");
// A fixed root, not a mkdtemp one. The project directory is what the pane header
// and the workspace figure show, so a random `preview-demo-XXXX` suffix baked a
// run artifact of this host into published docs and changed the image on every
// re-shoot. Everything inside it is still written fresh and removed at the end.
// This is a single-run tool: two captures at once would share the directory, and
// a pre-existing one owned by someone else is refused by the writes below rather
// than silently reused.
const root = path.join(tmpdir(), "preview-demo");
const project = path.join(root, "northstar");
mkdirSync(root, { recursive: true });
const out = path.resolve(import.meta.dirname, "../apps/website/public/demos");
const shots = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");
const cleanup: (() => void | Promise<void>)[] = [stopStack, () => rmSync(root, { recursive: true, force: true })];
function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr}`);
}
try {
  writePreviewProject(project);
  run("git", ["-C", project, "init", "-q"]);
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.unshift(() => api.dispose());
  async function post(url: string, data: object) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const r = await api.post(url, { data });
      if (r.ok()) return r.json();
      const body = await r.json();
      if (url.endsWith("/exec") && body.code === "EXEC_PANE_BUSY") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw new Error(`${url}: ${r.status()} ${JSON.stringify(body)}`);
    }
    throw new Error(`${url}: shell did not become idle`);
  }
  await post("/api/auth/sign-up/email", {
    name: "Alex Morgan",
    email: "alex@example.test",
    password: "preview-media-fixture-1",
  });
  expect((await api.patch("/api/setup/progress", { data: { step: null } })).ok()).toBe(true);
  expect((await api.patch("/api/settings", { data: { instanceName: "Northstar Studio" } })).ok()).toBe(true);
  expect((await api.put("/api/nodes/local/views-enabled", { data: { on: true } })).ok()).toBe(true);
  const shellPreset = await post("/api/presets", {
    harnessId: "terminal",
    name: "Website development",
    flags: ["--noprofile", "--norc"],
    env: { PS1: "$ " },
  });
  const server = await post("/api/subshells", {
    name: "Dev server",
    harnessId: "terminal",
    presetId: shellPreset.id,
    workingDir: project,
    ...(!securityOnly ? { screen: { width: 1280, height: 800 } } : {}),
  });
  cleanup.unshift(async () => {
    await api.delete(`/api/subshells/${server.id}`);
  });
  await post(`/api/subshells/${server.id}/exec`, {
    command: "bun server.ts > server.log 2>&1 & echo $! > server.pid",
    timeoutMs: 2000,
  });
  cleanup.unshift(() => {
    const f = path.join(project, "server.pid");
    if (existsSync(f)) {
      const pid = Number(readFileSync(f, "utf8").trim());
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  });
  await expect
    .poll(
      async () => {
        const r = await api.get(`/api/subshells/${server.id}/views`);
        return (await r.json()).ports?.some((p: { port: number }) => p.port === 3000);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const workspace = await post("/api/workspaces", { name: "Northstar website", subshellId: server.id });
  const browser = await chromium.launch();
  cleanup.unshift(() => browser.close());
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: await api.storageState(),
    viewport: { width: 1000, height: 640 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await context.addInitScript(() => localStorage.setItem("subshell.termFontSize", "18"));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
  await page.getByRole("button", { name: "Open web preview on port 3000" }).click();
  await expect(page.locator("iframe")).toBeVisible();
  const appFrame = page.frames().find((f) => f.url().includes("/pv/"));
  if (!appFrame) throw new Error("App preview did not mount");
  await expect(appFrame.getByRole("heading", { name: "Small teams. Considered websites." })).toBeVisible();
  await verifyPreviewBrowser(appFrame, BASE_URL, true);
  const proxy = appFrame.url();
  const direct = await context.newPage();
  await direct.goto(proxy);
  await verifyPreviewBrowser(direct, BASE_URL, false);
  await direct.close();
  console.log(
    "Browser isolation verified: opaque documents, blocked parent/storage/API reads, working modules, POST and WS",
  );
  if (securityOnly) {
    console.log("Security browser check complete");
  } else {
    // Remove the checked preview so filming shows its real first-open transition.
    await page.getByRole("button", { name: "More view actions" }).click();
    await page.getByRole("menuitem", { name: "Close view" }).click();
    const cache = path.join(homedir(), ".cache");
    mkdirSync(cache, { recursive: true });
    const codexHome = mkdtempSync(path.join(cache, "subshell-preview-codex-"));
    cleanup.unshift(() => rmSync(codexHome, { recursive: true, force: true }));
    copyFileSync(path.join(homedir(), ".codex/auth.json"), path.join(codexHome, "auth.json"));
    const agentPreset = await post("/api/presets", {
      name: "Website agent",
      harnessId: "codex",
      flags: [
        "--no-alt-screen",
        "--sandbox",
        "workspace-write",
        "-a",
        "never",
        "-c",
        "mcp_servers.subshell.enabled=false",
      ],
      env: { CODEX_HOME: codexHome },
    });
    const agent = await post("/api/subshells", {
      name: "Build website",
      harnessId: "codex",
      presetId: agentPreset.id,
      workingDir: project,
    });
    cleanup.unshift(async () => {
      await api.delete(`/api/subshells/${agent.id}`);
    });
    await post(`/api/workspaces/${workspace.id}/panes`, { subshellId: agent.id });
    await page.reload();
    const tab = (name: string) => page.getByRole("tab").filter({ has: page.getByText(name, { exact: true }) });
    await tab("Build website").click();
    const log = async () => (await (await api.get(`/api/subshells/${agent.id}/log`)).json()).lines.join("\n") as string;
    await page.waitForTimeout(4000);
    if (/trust/i.test(await log())) {
      await post(`/api/subshells/${agent.id}/input`, { text: "\r", submit: false });
      await page.waitForTimeout(2000);
    }
    for (let i = 0; i < 3; i++) {
      await post(`/api/subshells/${agent.id}/input`, { text: "\x1b[12~", submit: false });
      await page.waitForTimeout(300);
      await post(`/api/subshells/${agent.id}/input`, { text: "\x1b", submit: false });
    }
    // A real graphical browser belongs to the dev-server subshell's display.
    const profile = path.join(root, "website-browser");
    await post(`/api/subshells/${server.id}/exec`, {
      command: `google-chrome --ozone-platform=x11 --no-first-run --no-default-browser-check --disable-dev-shm-usage --user-data-dir=${profile} --window-size=1280,800 --window-position=0,0 --app=http://127.0.0.1:3000 > browser.log 2>&1 & echo $! > browser.pid`,
      timeoutMs: 2000,
    });
    cleanup.unshift(() => {
      const f = path.join(project, "browser.pid");
      if (existsSync(f)) {
        try {
          process.kill(Number(readFileSync(f, "utf8").trim()), "SIGTERM");
        } catch {}
      }
    });
    const frames = path.join(root, "frames");
    mkdirSync(frames);
    let frame = 0;
    async function hold(seconds: number) {
      await page.mouse.move(990, 630);
      for (let i = 0; i < seconds * 15; i++) {
        const start = Date.now();
        await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(4, "0")}.png`) });
        await page.waitForTimeout(Math.max(0, 1000 / 15 - (Date.now() - start)));
      }
    }
    await hold(1.5);
    await post(`/api/subshells/${agent.id}/input`, {
      text: "Fix the website project filters: Websites should show only websites, Brand only brand projects, and All should reset the list. Add tests, run bun test, and summarize what changed. The dev server is already running.",
      submit: false,
    });
    await hold(2);
    await post(`/api/subshells/${agent.id}/input`, { text: "\r", submit: false });
    let finished = false;
    for (let stage = 0; stage < 90; stage++) {
      if (stage < 3 || stage % 10 === 0) await hold(1);
      await page.waitForTimeout(2500);
      const text = await log();
      console.log("Agent stage", stage, text.slice(-350));
      if (
        !readFileSync(path.join(project, "filter.js"), "utf8").includes("TODO") &&
        /Worked for|tokens used/.test(text)
      ) {
        finished = true;
        break;
      }
    }
    if (!finished) throw new Error("Agent did not finish the website task");
    run("bun", ["run", "--cwd", project, "test"]);
    await hold(3);
    // Keep stable human labels if the harness generated a task title.
    await api.patch(`/api/subshells/${agent.id}/name`, { data: { name: "Build website" } });
    await tab("Dev server").click();
    await hold(1);
    await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
    await hold(2);
    mkdirSync(shots, { recursive: true });
    const dimensions: Record<string, { width: number; height: number }> = {};
    dimensions["preview-picker"] = await captureScreenshot(
      page,
      path.join(shots, "preview-picker.png"),
      page.getByRole("dialog"),
    );
    await page.getByRole("button", { name: "Open web preview on port 3000" }).click();
    await page.frameLocator("iframe").getByRole("button", { name: "Websites", exact: true }).waitFor();
    await hold(2);
    await page.frameLocator("iframe").getByRole("button", { name: "Websites", exact: true }).click();
    await expect(page.frameLocator("iframe").locator("article")).toHaveCount(2);
    await hold(2);
    await page.frameLocator("iframe").getByRole("button", { name: "Brand", exact: true }).click();
    await expect(page.frameLocator("iframe").locator("article")).toHaveCount(1);
    await hold(2);
    await tab("Build website").click();
    await hold(3);
    const poster = frame - 1;
    dimensions["preview-workspace"] = await captureScreenshot(
      page,
      path.join(shots, "preview-workspace.png"),
      page.locator("main"),
      page.locator("main"),
    );
    await page.getByRole("button", { name: "More view actions" }).click();
    await hold(1);
    await page.getByRole("menuitem", { name: "Maximize pane" }).click();
    await hold(2);
    await page.getByRole("button", { name: "Restore pane", exact: true }).click();
    await hold(1);
    await page.getByRole("button", { name: "More view actions" }).click();
    await page.getByRole("menuitem", { name: "Close view" }).click();
    await tab("Dev server").click();
    await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
    await hold(1);
    await page.getByRole("button", { name: "View screen" }).click();
    await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
    await hold(3);
    dimensions["preview-display"] = await captureScreenshot(
      page,
      path.join(shots, "preview-display.png"),
      page.locator("main"),
      page.locator("main"),
    );
    await hold(2);
    mkdirSync(out, { recursive: true });
    const video = path.join(root, "website-preview.mp4");
    run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-framerate",
      "15",
      "-i",
      path.join(frames, "%04d.png"),
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      video,
    ]);
    copyFileSync(video, path.join(out, "website-preview.mp4"));
    run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      path.join(frames, `${String(poster).padStart(4, "0")}.png`),
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      path.join(out, "website-preview.webp"),
    ]);
    console.log("SCREENSHOT_DIMENSIONS", JSON.stringify(dimensions));
    console.log("Captured", frame, "frames", frame / 15, "seconds");
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  for (const clean of cleanup) {
    try {
      await clean();
    } catch (error) {
      console.error("cleanup:", String(error));
    }
  }
}
