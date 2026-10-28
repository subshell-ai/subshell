import { spawn } from "node:child_process";
/** Isolated real-node smoke test and mobile captures for preview compatibility. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium, expect, request } from "@playwright/test";
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
  const pane = await post("/api/subshells", {
    name: "Website",
    harnessId: "terminal",
    presetId: preset.id,
    workingDir: process.cwd(),
  });
  cleanup.unshift(() => api.delete(`/api/subshells/${pane.id}`));
  await post(`/api/subshells/${pane.id}/services`, {
    name: "Subshell website",
    host: "127.0.0.1",
    port: 3401,
    protocol: "http",
  });
  const workspace = await post("/api/workspaces", { name: "Website preview", subshellId: pane.id });
  const browser = await chromium.launch();
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
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
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
  await page.getByRole("button", { name: "Save and open" }).click();
  await expect(frame.getByRole("heading", { name: "Manage multiple agents away from your desk" })).toBeVisible();
  console.log("Saved and reopened preview");
  // Verify a real Next CSS update rather than merely an established HMR socket.
  const cssPath = "apps/website/app/globals.css";
  const originalCss = readFileSync(cssPath, "utf8");
  try {
    writeFileSync(cssPath, `${originalCss}\nh1 { outline: 7px solid rgb(1, 2, 3) !important; }\n`);
    await expect
      .poll(() => frame.locator("h1").evaluate((el) => getComputedStyle(el).outlineWidth), { timeout: 20000 })
      .toBe("7px");
    console.log("Next CSS hot reload verified");
  } finally {
    writeFileSync(cssPath, originalCss);
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
} finally {
  for (const close of cleanup) await close();
}
