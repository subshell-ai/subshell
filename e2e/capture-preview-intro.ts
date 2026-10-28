/** Capture a loaded website in the real preview UI. Start the marketing site on :3401 first. */
import { mkdirSync } from "node:fs";
import { chromium, expect, request } from "@playwright/test";
import { BASE_URL } from "./ports";
import { captureScreenshot } from "./screenshot";
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
  await api.put("/api/nodes/local/views-enabled", { data: { on: true, feature: "display" } });
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
    // Match 200% browser zoom: half the CSS viewport at twice the pixel density.
    // Keep the exported image at 2400 × 1700 while making text and controls twice as large.
    viewport: { width: 600, height: 425 },
    deviceScaleFactor: 4,
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
  await captureScreenshot(
    page,
    "apps/docs/public/screenshots/preview-picker.png",
    page.getByRole("dialog", { name: "Open web preview or screen" }),
  );
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
  await page.screenshot({ path: "apps/docs/public/screenshots/preview-intro.png", animations: "disabled" });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByRole("button", { name: "More view actions" }).click();
  await page.getByRole("menuitem", { name: "Configure preview" }).click();
  await captureScreenshot(
    page,
    "apps/docs/public/screenshots/preview-settings.png",
    page.getByRole("dialog", { name: "Configure preview" }),
  );
} finally {
  for (const close of cleanup) await close();
}
