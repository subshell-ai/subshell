import { spawn } from "node:child_process";
/** Isolated real-node smoke test and mobile captures for preview compatibility. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium, expect, request, webkit } from "@playwright/test";
import { BASE_URL } from "./ports";
import { startStack, stopStack } from "./stack";

const cleanup: (() => unknown | Promise<unknown>)[] = [stopStack];
try {
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.unshift(() => api.dispose());
  const post = async (path: string, data: object) => {
    const r = await api.post(path, { data });
    if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
    return r.json();
  };
  await post("/api/auth/sign-up/email", {
    name: "Alex Morgan",
    email: "alex@example.test",
    password: "preview-compat-fixture-1",
  });
  await api.patch("/api/setup/progress", { data: { step: null } });
  await api.put("/api/nodes/local/views-enabled", { data: { on: true } });
  const preset = await post("/api/presets", {
    harnessId: "terminal",
    name: "Website development",
    flags: ["--noprofile", "--norc"],
  });
  const demoDir = "/tmp/subshell-demo/website";
  mkdirSync(demoDir, { recursive: true });
  const pane = await post("/api/subshells", {
    name: "Website",
    harnessId: "terminal",
    presetId: preset.id,
    workingDir: demoDir,
  });
  cleanup.unshift(() => api.delete(`/api/subshells/${pane.id}`));
  await post(`/api/subshells/${pane.id}/services`, {
    name: "Subshell website",
    host: "127.0.0.1",
    port: 3401,
    protocol: "http",
  });
  const workspace = await post("/api/workspaces", { name: "Website preview", subshellId: pane.id });
  const browser = await (process.env.PREVIEW_BROWSER === "webkit" ? webkit : chromium).launch();
  cleanup.unshift(() => browser.close());
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: await api.storageState(),
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  const failedAssets: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && ["script", "stylesheet"].includes(r.request().resourceType()))
      failedAssets.push(new URL(r.url()).pathname.replace(/\/pv\/[^/]+/, "/pv/REF"));
    if (r.status() >= 400) console.log("HTTP", r.status(), new URL(r.url()).pathname.replace(/\/pv\/[^/]+/, "/pv/REF"));
  });
  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
  await page.getByRole("button", { name: /^Subshell website/ }).click();
  await page.getByRole("button", { name: "More view actions" }).click();
  await page.getByRole("menuitem", { name: "Maximize pane" }).click();
  await expect(page.locator("iframe")).toBeVisible();
  const frame = page.frameLocator("iframe");
  await expect(frame.getByRole("heading", { name: "Manage multiple agents away from your desk" })).toBeVisible();
  await expect.poll(() => frame.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain("Times");
  await expect
    .poll(() =>
      frame
        .locator("img")
        .first()
        .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
    )
    .toBe(true);
  await page.waitForTimeout(4000);
  console.log("Browser errors", errors);
  console.log("Website styled; image loaded");
  mkdirSync("apps/docs/public/screenshots", { recursive: true });
  await page.screenshot({ path: "/tmp/subshell-preview-website-mobile.png" });
  await page.getByRole("button", { name: "More view actions" }).click();
  await page.getByRole("menuitem", { name: "Configure preview" }).click();
  await expect(page.getByRole("dialog", { name: "Configure preview" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Rewrite app URLs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and open" })).toBeEnabled();
  await page.screenshot({ path: "/tmp/subshell-preview-settings-mobile.png" });
  const reconnected = page
    .waitForEvent("websocket", { predicate: (socket) => /\/_next\/(?:webpack-hmr|hmr)(?:\?|$)/.test(socket.url()) })
    .then((socket) => socket.waitForEvent("framereceived"));
  await page.getByRole("button", { name: "Save and open" }).click();
  await reconnected;
  await expect(frame.getByRole("heading", { name: "Manage multiple agents away from your desk" })).toBeVisible();
  console.log("Saved and reopened preview");
  // Verify a real Next CSS update rather than merely an established HMR socket.
  const cssPath = "apps/website/app/globals.css";
  const originalCss = readFileSync(cssPath, "utf8");
  // An unrelated malformed URL must not break the stylesheet replacement shim.
  await frame.locator("html").evaluate(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "http://[";
    link.id = "invalid-stylesheet-fixture";
    document.head.append(link);
  });
  try {
    for (const width of [7, 11]) {
      writeFileSync(cssPath, `${originalCss}\nh1 { outline: ${width}px solid rgb(1, 2, 3) !important; }\n`);
      await expect
        .poll(() => frame.locator("h1").evaluate((el) => getComputedStyle(el).outlineWidth), { timeout: 20000 })
        .toBe(`${width}px`);
    }
    console.log("Next CSS hot reload verified");
  } finally {
    writeFileSync(cssPath, originalCss);
    await frame.locator("#invalid-stylesheet-fixture").evaluate((element) => element.remove());
  }
  const viteRoot = mkdtempSync("/tmp/preview-vite-");
  cleanup.unshift(() => rmSync(viteRoot, { recursive: true, force: true }));
  writeFileSync(
    `${viteRoot}/index.html`,
    '<html><head><script type="importmap">{"imports":{"fixture":"/mapped.js"}}</script></head><body><h1>Vite preview</h1><script type="module" src="/main.js"></script></body></html>',
  );
  writeFileSync(
    `${viteRoot}/main.js`,
    'import "/style.css"; document.querySelector("h1").dataset.ready="yes"; const name="fixture"; import(/* @vite-ignore */ name).then(m=>document.querySelector("h1").dataset.mapped=m.value);',
  );
  writeFileSync(`${viteRoot}/style.css`, "h1{color:rgb(1, 2, 3)}");
  writeFileSync(`${viteRoot}/mapped.js`, 'export const value="mapped";');
  const vite = spawn(
    "bun",
    [
      `${process.cwd()}/apps/server/web/node_modules/vite/bin/vite.js`,
      viteRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "3491",
      "--strictPort",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  cleanup.unshift(() => vite.kill());
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://127.0.0.1:3491")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const viteService = await post(`/api/subshells/${pane.id}/services`, {
    name: "Vite fixture",
    host: "127.0.0.1",
    port: 3491,
    protocol: "http",
  });
  const opened = await post(`/api/subshells/${pane.id}/views/open`, { serviceId: viteService.id });
  const direct = await context.newPage();
  direct.on("pageerror", (e) => console.log("Vite error", e.message));
  direct.on("console", (m) => {
    if (m.type() === "error") console.log("Vite console", m.text());
  });
  await direct.goto(opened.proxyBase);
  await expect(direct.locator("h1")).toHaveAttribute("data-ready", "yes");
  await expect(direct.locator("h1")).toHaveAttribute("data-mapped", "mapped");
  await expect(direct.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  writeFileSync(`${viteRoot}/style.css`, "h1{color:rgb(4, 5, 6)}");
  await expect(direct.locator("h1")).toHaveCSS("color", "rgb(4, 5, 6)", { timeout: 15000 });
  console.log("Vite modules, CSS and hot reload verified");
  expect(failedAssets).toEqual([]);
  expect(errors).toEqual([]);
  const fixture = `${viteRoot}/website.ts`;
  writeFileSync(
    fixture,
    `
    import { appendFileSync } from "node:fs";
    process.stdin.setRawMode(true);
    process.stdin.on("data", bytes => appendFileSync(${JSON.stringify(`${viteRoot}/keys`)}, bytes));
    process.stdout.write("\\x1b[?1049hHistory test ready");
    Bun.serve({ hostname: "127.0.0.1", port: 3492, fetch: request => new URL(request.url).pathname === "/download"
      ? new Response(new Uint8Array([1, 2]), {headers:{"content-type":"application/octet-stream", "content-disposition":"attachment"}})
      : new Response('<head><title>Project dashboard &amp; release notes for a long website title</title></head><h1>Website fixture</h1><a href="/download">Download</a>', {headers:{"content-type":"text/html"}}) });
    Bun.serve({ hostname: "127.0.0.1", port: 3493, fetch: () => Response.json({ok:true}) });
  `,
  );
  await post(`/api/subshells/${pane.id}/input`, { text: `bun ${fixture}`, submit: true });
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/subshells/${pane.id}/views`);
        return (await response.json()).ports;
      },
      { timeout: 15000 },
    )
    .toEqual([
      {
        proto: "tcp",
        port: 3492,
        pid: expect.any(Number),
        title: "Project dashboard & release notes for a long website title",
      },
    ]);
  const phone = await browser.newContext({
    baseURL: BASE_URL,
    storageState: await api.storageState(),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
  });
  cleanup.unshift(() => phone.close());
  const phonePage = await phone.newPage();
  // Render a foreign-node disclosure without changing the fixture server's ownership.
  await phonePage.route("**/api/nodes", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        nodes: data.nodes.map((node: { id: string }) =>
          node.id === "local" ? { ...node, kind: "agent", access: "edit" } : node,
        ),
      },
    });
  });
  await phonePage.goto(`/workspaces/${workspace.id}`);
  await phonePage.getByRole("button", { name: /^Open web preview or screen/ }).tap();
  await phonePage.getByRole("button", { name: /^Open Project dashboard.*3492/ }).tap();
  const title = phonePage.getByTitle("Project dashboard & release notes for a long website title · 3492 · Website");
  await expect(title).toBeVisible();
  expect(
    await title
      .locator("span")
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  const titleBox = await title.boundingBox();
  expect(titleBox && titleBox.x >= 0 && titleBox.x + titleBox.width <= 390).toBe(true);
  const phoneFrame = phonePage.frameLocator("iframe");
  await expect(phoneFrame.getByRole("heading", { name: "Website fixture" })).toBeVisible();
  await phonePage.screenshot({ path: "/tmp/subshell-preview-titles-mobile.png" });
  await phoneFrame.getByRole("link", { name: "Download" }).tap();
  await expect(phoneFrame.getByRole("heading", { name: "This isn't a web page" })).toBeVisible();
  await expect(phonePage.getByRole("button", { name: "More view actions" })).toBeVisible();
  console.log("HTML-only discovery, page titles, phone truncation, and download navigation verified");
  await phonePage.getByRole("button", { name: "Website", exact: true }).tap();
  // This marker follows the alternate-buffer switch in the terminal replay.
  await expect(phonePage.locator(".xterm-rows")).toContainText("History test ready");
  for (const name of ["Scroll to top", "Scroll page up", "Scroll page down", "Scroll to bottom"]) {
    await phonePage.getByRole("button", { name, exact: true }).tap();
  }
  await expect
    .poll(() => {
      try {
        return readFileSync(`${viteRoot}/keys`, "utf8");
      } catch {
        return "";
      }
    })
    .toBe("\x1b[H\x1b[5~\x1b[6~\x1b[F");
  console.log("Touch history buttons reached the full-screen terminal app");
  const watcher = await context.newPage();
  await watcher.goto(`/subshells/${pane.id}`);
  const devicesButton = phonePage.getByRole("button", { name: /devices watching this subshell/ });
  await expect(devicesButton).toBeVisible();
  const ownership = phonePage.getByRole("button", { name: /Runs on .*machine you don't own/ });
  await expect(ownership).toBeVisible();
  const devicesBox = await devicesButton.boundingBox();
  const ownershipBox = await ownership.boundingBox();
  expect(devicesBox && ownershipBox && devicesBox.x < ownershipBox.x).toBe(true);
  await phonePage.screenshot({ path: "/tmp/subshell-header-icons-mobile.png" });
  await ownership.tap();
  await expect(phonePage.getByRole("dialog", { name: "Subshell access" })).toHaveCSS("opacity", "1");
  await expect(phonePage.getByText(/Its owner can read this terminal/)).toBeVisible();
  await phonePage.screenshot({ path: "/tmp/subshell-ownership-mobile.png" });
  console.log("Device badge and tappable ownership disclosure verified on mobile");
} finally {
  for (const close of cleanup) await close();
}
