import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Locator, type Page, request } from "@playwright/test";
import { BASE_URL, PORTS } from "./ports";
import { captureScreenshot } from "./screenshot";
import { startStack, stopStack } from "./stack";

// Real UI, real API records, and real terminal commands on a disposable stack.
// No agent responses or browser states are mocked for documentation images.
if (PORTS.backend === 3080) throw new Error("Documentation capture must not use the live instance");
process.env.TRUSTED_ORIGINS = "https://subshell.example.com";
const project = mkdtempSync(path.join(tmpdir(), "subshell-docs-project-"));
const output = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");
const cleanup: (() => Promise<void> | void)[] = [() => rmSync(project, { recursive: true, force: true }), stopStack];
const dimensions: Record<string, { width: number; height: number }> = {};

async function capture(page: Page, name: string, first: Locator, last = first) {
  dimensions[name] = await captureScreenshot(page, path.join(output, `${name}.png`), first, last);
}

try {
  mkdirSync(path.join(project, "src"));
  writeFileSync(
    path.join(project, "src/tasks.ts"),
    "export const complete = (tasks, id) =>\n  tasks.map(task =>\n    task.id === id ? { ...task, done: true } : task\n  );\n",
  );
  writeFileSync(
    path.join(project, "tasks.test.ts"),
    'import { expect, test } from "bun:test";\nimport { complete } from "./src/tasks";\ntest("completes the matching task", () => { expect(complete([{id:1, done:false}], 1)[0].done).toBe(true); });\ntest("keeps other tasks unchanged", () => { expect(complete([{id:1, done:false}], 2)[0].done).toBe(false); });\n',
  );
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.push(() => api.dispose());
  async function post(url: string, data: object) {
    const res = await api.post(url, { data });
    if (!res.ok()) throw new Error(`${url}: ${res.status()} ${await res.text()}`);
    return res.json();
  }
  await post("/api/auth/sign-up/email", {
    name: "Alex Morgan",
    email: "alex@example.test",
    password: "docs-fixture-password-1",
  });
  expect((await api.patch("/api/setup/progress", { data: { step: null } })).ok()).toBe(true);
  expect((await api.patch("/api/settings", { data: { instanceName: "Demo workspace" } })).ok()).toBe(true);
  const prompts: { id: string; description: string; body: string }[] = [];
  for (const [description, body] of [
    ["Project context", "Read AGENTS.md and use the package test scripts."],
    ["Review changes", "Review uncommitted changes for correctness and missing tests. Do not modify files."],
    ["Review report format", "Order findings by severity, with file paths, line numbers, and suggested fixes."],
  ])
    prompts.push(await post("/api/prompts", { description, body }));
  await post("/api/prompts/stacks", {
    label: "Repository review checklist",
    items: prompts.map((p) => ({ promptId: p.id })),
  });
  await post("/api/presets", {
    harnessId: "codex",
    name: "Repository review",
    flags: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    nodeId: "local",
    workingDir: project,
    promptBlocks: [
      { kind: "saved", promptId: prompts[1].id, description: prompts[1].description, body: prompts[1].body },
    ],
    crossCommEnabled: true,
  });
  const shell = await post("/api/presets", {
    harnessId: "terminal",
    name: "Project shell",
    flags: ["--noprofile", "--norc"],
    env: { PS1: "$ " },
    nodeId: "local",
    workingDir: project,
  });
  const panes: { id: string }[] = [];
  for (const name of ["Project shell", "Test results"])
    panes.push(await post("/api/subshells", { harnessId: "terminal", presetId: shell.id, workingDir: project, name }));
  const workspace = await post("/api/workspaces", { name: "Project workspace", subshellId: panes[0].id });
  await post(`/api/workspaces/${workspace.id}/panes`, { subshellId: panes[1].id });
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: await api.storageState(),
    viewport: { width: 1180, height: 1200 },
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const dialog = page.getByRole("dialog");
  const card = page.locator("main .bg-card");
  async function close() {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }

  const enableSsh = await api.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
  expect(enableSsh.ok(), await enableSsh.text()).toBe(true);
  await page.goto("/new?kind=ssh");
  await expect(dialog.getByRole("button", { name: "SSH terminal", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#ssh-wizard-destination").fill("developer@build.example.com:22");
  await dialog.getByRole("button", { name: "Add port forward", exact: true }).click();
  await page.locator("#ssh-fwd-port").fill("8080");
  await page.locator("#ssh-fwd-target-host").fill("127.0.0.1");
  await page.locator("#ssh-fwd-target-port").fill("3000");
  await dialog.getByRole("button", { name: "Add port forward", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove this forward" })).toBeVisible();
  // Capture connection choices without opening a connection to the sample address.
  await capture(page, "ssh-connection", dialog);
  await close();

  await page.goto("/presets");
  await expect(page.getByRole("button", { name: "Repository review", exact: true })).toBeVisible();
  await capture(page, "preset-library", page.locator("main h1"), card.last());
  await page.getByRole("button", { name: "New preset", exact: true }).click();
  await page.getByRole("menuitem", { name: "New agent preset", exact: true }).click();
  await page.locator("#preset-harness").click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await page.locator("#preset-name").fill("Repository review");
  await page.locator("#preset-command textarea").fill("codex --sandbox workspace-write --ask-for-approval on-request");
  await expect(page.getByText("0 env vars · 2 flags")).toBeVisible();
  await capture(page, "preset-codex-configuration", dialog.getByRole("heading"), page.locator("#preset-command"));
  await close();
  await page.getByRole("button", { name: "Actions for Repository review", exact: true }).click();
  await page.getByRole("menuitem", { name: "Share preset", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await capture(page, "preset-sharing", dialog);
  await close();
  await page.getByRole("button", { name: "Actions for Repository review", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await capture(page, "preset-launch-defaults", page.getByText("Launch defaults", { exact: true }).locator(".."));

  await page.goto("/prompts");
  await expect(page.getByRole("button", { name: "Repository review checklist", exact: true })).toBeVisible();
  await capture(page, "prompt-library", page.locator("main h1"), card.last());
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await page.getByRole("button", { name: "Repository review checklist", exact: true }).click();
  await expect(page.getByRole("list", { name: "Stack members" })).toBeVisible();
  await capture(page, "prompt-stack-members", card.last());

  await page.goto("/nodes");
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByRole("button", { name: "Desktop App", exact: true }).click();
  await capture(page, "node-enrollment", dialog);
  await close();

  await page.goto("/mobile?platform=apple");
  await capture(page, "mobile-web-install", page.locator("main h1"), card.last());

  await page.goto("/settings/networking");
  await expect(page.locator("#server-base-url")).toHaveValue(BASE_URL);
  await capture(
    page,
    "server-addresses",
    page.locator("#server-base-url").locator(".."),
    page.locator("#server-trusted-origins").locator(".."),
  );

  await page.goto(`/subshells/${panes[0].id}`);
  await page.locator("main").getByRole("button", { name: "Actions for Project shell", exact: true }).click();
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await capture(page, "session-sharing", dialog);
  await close();
  await page.goto("/subshells");
  await expect(page.locator("main").getByText("Project shell", { exact: true })).toBeVisible();
  await page.locator("main").getByRole("button", { name: "List view", exact: true }).click();
  await page.getByRole("combobox", { name: "Group by", exact: true }).click();
  await page.getByRole("option", { name: "No grouping", exact: true }).click();
  await capture(page, "session-dashboard", page.locator("main h1"), card.last());

  await page.setViewportSize({ width: 1280, height: 540 });
  await page.goto(`/workspaces/${workspace.id}`);
  // Leave room around the full-bleed workspace for the same capture margin.
  await page.addStyleTag({ content: "main { margin: 12px; max-width: calc(100% - 24px); }" });
  const tab = page.getByRole("tab", { name: "Test results", exact: true });
  await expect(tab).toBeVisible();
  const source = await tab.boundingBox();
  const target = await page.getByRole("tabpanel", { name: "Test results" }).boundingBox();
  if (!source || !target) throw new Error("Workspace drag bounds unavailable");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height + 30, { steps: 5 });
  await page.mouse.move(target.x + target.width - 15, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByRole("tabpanel")).toHaveCount(2);
  await expect(page.locator(".xterm")).toHaveCount(2);
  await post(`/api/subshells/${panes[0].id}/input`, { text: "clear; ls -R; cat src/tasks.ts", submit: true });
  await post(`/api/subshells/${panes[1].id}/input`, { text: "clear; bun test", submit: true });
  await expect.poll(async () => (await api.get(`/api/subshells/${panes[1].id}/log`)).text()).toContain("2 pass");
  await page.waitForTimeout(500);
  // Keep the workspace header and actual output, omitting empty terminal space.
  dimensions["workspace-layout"] = await captureScreenshot(
    page,
    path.join(output, "workspace-layout.png"),
    page.locator("main"),
    page.locator("main"),
    310,
  );
  await post("/api/subshells", { harnessId: "terminal", presetId: shell.id, workingDir: project, name: "Build tools" });
  await expect(page.locator('[data-sidebar-drop="add"] a[href^="/subshells/"]')).toHaveCount(2);
  await expect(page.locator("aside").getByText("Build tools", { exact: true })).toBeVisible();
  const sidebarMargin = await page.addStyleTag({ content: "aside { margin: 12px; height: calc(100% - 24px); }" });
  await capture(page, "workspace-browser", page.locator("aside"));
  await sidebarMargin.evaluate((element) => element.parentNode?.removeChild(element));
  await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
  await capture(page, "add-subshell", dialog);
  await close();
  for (const name of [
    "workspace-layout",
    "prompt-stack-members",
    "preset-library",
    "session-sharing",
    "node-enrollment",
    "ssh-connection",
  ]) {
    // Encode into the temp project dir and copy only on success, so an
    // interrupted ffmpeg never leaves a corrupt webp at the committed path
    // (the site's install one-liners reference these by name).
    const scratch = path.join(project, `${name}.webp`);
    const encoded = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      path.join(output, `${name}.png`),
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      scratch,
    ]);
    if (encoded.status !== 0) throw new Error(`Could not encode ${name}: ${encoded.stderr}`);
    copyFileSync(scratch, path.resolve(import.meta.dirname, `../apps/website/public/shots/${name}.webp`));
  }
  console.log(JSON.stringify(dimensions));
} finally {
  for (const stop of cleanup.reverse()) {
    try {
      await stop();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
