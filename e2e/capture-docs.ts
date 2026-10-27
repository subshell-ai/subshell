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
/** The pane's own dev server, and the fake CDP endpoint that earns the browser
 *  row. Ports are spec 47's, deliberately off 9222 (a developer's real chromium
 *  answers there, and a stray listener would let the scan find a port this
 *  documentation capture never started). */
const HTTP_PORT = 4123;
const CDP_PORT = 9423;

/** Fail before the stack boots rather than after a 90-second wait: a leftover
 *  listener from an interrupted run makes the pane's own `Bun.serve` die with
 *  EADDRINUSE, and the discovery wait would then spend its whole budget for a
 *  reason this probe names in one line. Both handles close immediately; the
 *  check only asks whether the port is free. */
for (const port of [HTTP_PORT, CDP_PORT]) {
  let probe: { stop(): void } | undefined;
  try {
    probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") }) as unknown as {
      stop(): void;
    };
  } catch (error) {
    throw new Error(
      `Port ${port} is already in use; the preview capture needs ${HTTP_PORT} and ${CDP_PORT} free. (${String(error)})`,
    );
  }
  probe?.stop();
}

/** Typed verbatim into the preview pane so the header has something to count.
 *  Carries only double quotes: the `-e` argument is single-quoted at the shell,
 *  and `!` would history-expand even inside single quotes. */
const PANE_SCRIPT =
  `const ver={"Browser":"Docs preview CDP/0.0","Protocol-Version":"1.3","User-Agent":"docs",` +
  `"webSocketDebuggerUrl":"ws://127.0.0.1:${CDP_PORT}/devtools/browser/docsbrowser"};` +
  `const target={"description":"","id":"docspage","title":"Docs preview page","type":"page",` +
  `"url":"http://127.0.0.1:${HTTP_PORT}/","webSocketDebuggerUrl":"ws://127.0.0.1:${CDP_PORT}/devtools/page/docspage"};` +
  `Bun.serve({hostname:"127.0.0.1",port:${CDP_PORT},reuseAddress:true,fetch(req,server){` +
  `const u=new URL(req.url).pathname;if(u==="/json/version"){return Response.json(ver)}` +
  `if(u.startsWith("/json")){return Response.json([target])}` +
  `if(u.startsWith("/devtools/")){if(server.upgrade(req,{data:0})){return}` +
  `return new Response("upgrade refused",{status:426})}return new Response("nope",{status:404})},` +
  `websocket:{open(){},message(){},close(){}},error(){return new Response("nope",{status:400})}});` +
  `Bun.serve({hostname:"127.0.0.1",port:${HTTP_PORT},reuseAddress:true,fetch(){` +
  `return new Response("ok",{headers:{"set-cookie":"t=1"}})}});`;

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
  // The dialog's title, named: the preset editor has grown a section heading
  // for every optional block it carries, so "the heading in this dialog" is no
  // longer one element.
  await capture(
    page,
    "preset-codex-configuration",
    dialog.getByRole("heading", { name: "Create preset" }),
    page.locator("#preset-command"),
  );
  await close();
  await page.getByRole("button", { name: "Actions for Repository review", exact: true }).click();
  await page.getByRole("menuitem", { name: "Share preset", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await capture(page, "preset-sharing", dialog);
  await close();
  await page.getByRole("button", { name: "Actions for Repository review", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  // The preset editor scrolls inside its own panel, so a crop taller than that
  // panel would photograph the clipped-away part as blank card. Widen the
  // window and let the panel lay out at full height for this one shot, then
  // put both back. (The capture had also shrunk to a 49-pixel strip while the
  // page described the machine, directory, prompt, and switch it contains.)
  await page.setViewportSize({ width: 1180, height: 1500 });
  const unscroll = await page.addStyleTag({
    content: '[role="dialog"], [role="dialog"] > * { max-height: none !important; overflow: visible !important; }',
  });
  // One element, the section itself (title span → its wrapper): the crop helper
  // scrolls only its FIRST locator into view, so a heading→switch span left
  // everything below the fold photographing as empty card, and a heading-only
  // span shipped a 49-pixel strip while the page described the machine, the
  // directory, the prompt and the switch it contains.
  const launchSection = page.getByText("Launch defaults", { exact: true }).locator("xpath=../..");
  await capture(page, "preset-launch-defaults", launchSection);
  await unscroll.evaluate((element) => element.parentNode?.removeChild(element));
  await page.setViewportSize({ width: 1180, height: 1200 });
  // The section is a stack of labelled fields; a strip of a few dozen pixels
  // means the crop missed them, which is how this image shipped wrong before.
  const launchDefaults = dimensions["preset-launch-defaults"];
  if (!launchDefaults || launchDefaults.height < 600) {
    throw new Error(
      `preset-launch-defaults captured ${launchDefaults?.height ?? "nothing"}px; the launch defaults are not on screen`,
    );
  }

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

  // ── The preview badge and the switch's gold line. Both ride a pane that owns
  // two real loopback servers, so the count is counting discovered things: the
  // port list `GET /views` answers and the CDP endpoint that makes the browser
  // row exist. Same script spec 47 types, same reason (the servers must be
  // children of the pane's shell to fall inside its process tree).
  // Discovery answers nothing while the node's master switch is off, and this
  // stack starts with it off, so the switch goes on before the servers do.
  const enabled = await api.put("/api/nodes/local/views-enabled", { data: { on: true } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  const devPane = await post("/api/subshells", {
    harnessId: "terminal",
    presetId: shell.id,
    workingDir: project,
    name: "Dev server",
  });
  await post(`/api/workspaces/${workspace.id}/panes`, { subshellId: devPane.id });
  await new Promise((resolve) => setTimeout(resolve, 1_500)); // let the shell draw its prompt
  const typed = await api.post(`/api/subshells/${devPane.id}/input`, {
    data: { text: `bun -e '${PANE_SCRIPT}' &`, submit: true },
  });
  expect(typed.ok(), await typed.text()).toBe(true);
  // One /proc pass per ask behind the plane's short cache, so this waits on
  // discovery rather than on a guessed delay.
  const discoveryDeadline = Date.now() + 90_000;
  let discovered = false;
  while (!discovered && Date.now() < discoveryDeadline) {
    const res = await api.get(`/api/subshells/${devPane.id}/views`);
    if (res.ok()) {
      const body = (await res.json()) as { ports: { port: number }[]; cdpPort: number | null };
      discovered = body.ports.some((row) => row.port === HTTP_PORT) && body.cdpPort === CDP_PORT;
    }
    if (!discovered) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!discovered) {
    // The usual cause is a leftover listener on one of the two ports from an
    // interrupted run, which makes the pane's own `Bun.serve` die with
    // EADDRINUSE. Say so with the pane's words rather than a bare timeout.
    const log = await api.get(`/api/subshells/${devPane.id}/log`);
    throw new Error(
      `Preview discovery never saw ${HTTP_PORT}/${CDP_PORT}. Is a leftover server holding them? ` +
        `Pane log tail: ${(await log.text()).slice(-600)}`,
    );
  }
  // Re-enter the workspace rather than clicking a tab that is not there yet:
  // a pane added over REST lands in the rail, and the open dock only learns of
  // it from the detail read.
  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("tab", { name: "Dev server", exact: true }).click();
  const previewButton = page.getByRole("button", { name: /^Open web preview or screen; \d+ to open or save/ });
  await expect(previewButton).toBeVisible();
  dimensions["preview-badge"] = await captureScreenshot(
    page,
    path.join(output, "preview-badge.png"),
    page.locator("header").first(),
  );

  // The node's master switch off: the chooser says so in gold and names who can
  // turn it, which is the difference between "nothing is listening" and "this
  // is switched off". Captured before the switch goes back on, so the image
  // shows the state the words describe.
  const off = await api.put("/api/nodes/local/views-enabled", { data: { on: false } });
  expect(off.ok(), await off.text()).toBe(true);
  await page.waitForTimeout(1_200);
  await previewButton.click();
  await expect(dialog.getByText(/switched off on this node/)).toBeVisible();
  dimensions["node-switch-off"] = await captureScreenshot(page, path.join(output, "node-switch-off.png"), dialog);
  await close();
  const on = await api.put("/api/nodes/local/views-enabled", { data: { on: true } });
  expect(on.ok(), await on.text()).toBe(true);
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
