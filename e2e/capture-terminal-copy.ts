import path from "node:path";
import { chromium, expect, request } from "@playwright/test";
import { BASE_URL, PORTS } from "./ports";
import { captureScreenshot } from "./screenshot";
import { startStack, stopStack } from "./stack";

// Capture the real touch UI against a disposable server and shell.
if (PORTS.backend === 3080) throw new Error("Documentation capture must not use the live instance");
const output = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");
const cleanup: (() => Promise<void>)[] = [stopStack];
try {
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.push(() => api.dispose());
  async function post(url: string, data: object) {
    const response = await api.post(url, { data });
    if (!response.ok()) throw new Error(`${url}: ${response.status()} ${await response.text()}`);
    return response.json();
  }
  await post("/api/auth/sign-up/email", {
    name: "Alex Morgan",
    email: "alex@example.test",
    password: "docs-fixture-password-1",
  });
  expect((await api.patch("/api/setup/progress", { data: { step: null } })).ok()).toBe(true);
  const preset = await post("/api/presets", {
    harnessId: "terminal",
    name: "Project shell",
    flags: ["--noprofile", "--norc"],
    env: { PS1: "$ " },
    nodeId: "local",
    workingDir: "/tmp",
  });
  const pane = await post("/api/subshells", {
    harnessId: "terminal",
    presetId: preset.id,
    workingDir: "/tmp",
    name: "Project shell",
  });
  const workspace = await post("/api/workspaces", { name: "Project workspace", subshellId: pane.id });
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: await api.storageState(),
    viewport: { width: 430, height: 900 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto(`/workspaces/${workspace.id}`);
  await expect(page.locator(".xterm-rows")).toBeVisible();
  await post(`/api/subshells/${pane.id}/input`, {
    text: "clear; printf 'Build complete.\\n3 checks passed.\\n'",
    submit: true,
  });
  await expect(page.locator(".xterm-rows")).toContainText("3 checks passed.");
  await page.getByRole("button", { name: /^Actions for / }).click();
  await expect(page.getByRole("menuitem", { name: "Enable text copying" })).toBeVisible();
  await captureScreenshot(page, path.join(output, "terminal-copy-menu.png"), page.getByRole("menu"));
  await page.getByRole("menuitem", { name: "Enable text copying" }).click();
  await expect(page.locator(".xterm-helper-textarea")).toBeDisabled();
  // Wait for the mode toast to leave the crop, then select actual rendered text.
  await expect(page.getByText("Text copying enabled", { exact: true })).toHaveCount(0, { timeout: 10000 });
  const row = page.locator(".xterm-rows > div").filter({ hasText: "3 checks passed." });
  const bounds = await row.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(bounds.left + 1, bounds.y);
  await page.mouse.down();
  await page.mouse.move(400, bounds.y, { steps: 10 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("checks passed");
  await captureScreenshot(
    page,
    path.join(output, "terminal-copy-selection.png"),
    page.locator(".xterm-rows"),
    undefined,
    86,
  );
} finally {
  for (const dispose of cleanup.reverse()) await dispose();
}
