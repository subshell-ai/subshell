import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, request } from "@playwright/test";
import { BASE_URL, PORTS } from "./ports";
import { startStack, stopStack } from "./stack";

// Real commands and UI on an isolated server; no fabricated agent output.
// Requires an authenticated Codex CLI. Authentication stays off camera.
if (PORTS.backend === 3080) throw new Error("Never record against the live server");
const subagents = process.argv.includes("--subagents");
const mobileOnly = process.argv.includes("--mobile-only");
const root = mkdtempSync(path.join(tmpdir(), "demo-"));
const out = path.resolve(import.meta.dirname, "../apps/website/public/demos");
const cleanup: (() => void | Promise<void>)[] = [() => rmSync(root, { recursive: true, force: true }), stopStack];
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
}
try {
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
    password: "demo-fixture-password-1",
  });
  expect((await api.patch("/api/setup/progress", { data: { step: null } })).ok()).toBe(true);
  // Keep personal configuration, history, and MCP connections out of the demo.
  // Create ~/.cache first: mkdtempSync fails with ENOENT when its parent is
  // absent (fresh macOS homes have no ~/.cache), which would only surface
  // after the whole stack had been booted.
  const cacheRoot = path.join(homedir(), ".cache");
  mkdirSync(cacheRoot, { recursive: true });
  const codexHome = mkdtempSync(path.join(cacheRoot, "subshell-demo-codex-"));
  cleanup.push(() => rmSync(codexHome, { recursive: true, force: true }));
  copyFileSync(path.join(homedir(), ".codex/auth.json"), path.join(codexHome, "auth.json"));
  const agentPreset = await post("/api/presets", {
    name: "Feature development",
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
  const shellPreset = await post("/api/presets", {
    name: "Project tests",
    harnessId: "terminal",
    flags: ["--noprofile", "--norc"],
    env: { PS1: "$ " },
  });
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  for (const mobile of mobileOnly
    ? [true]
    : process.argv.includes("--desktop-only") || subagents
      ? [false]
      : [false, true]) {
    const workingDir = path.join("/tmp/subshell-demo", mobile ? "phone" : "desktop", "task-board");
    mkdirSync(workingDir, { recursive: true });
    // This root is shared between runs, and the completion gate below treats an
    // existing tasks.test.js as proof the agent wrote tests. Leave the previous
    // run's file in place and a run where the agent skips that step ends early,
    // on a green bun test of work nobody did. The scratch root is cleaned at
    // exit, so nothing else removes it.
    rmSync(path.join(workingDir, "tasks.test.js"), { force: true });
    writeFileSync(
      path.join(workingDir, "package.json"),
      JSON.stringify({ name: "task-board", type: "module", scripts: { test: "bun test" } }),
    );
    writeFileSync(
      path.join(workingDir, "tasks.js"),
      `export const tasks = [
  { title: "Build search", done: true },
  { title: "Add keyboard shortcuts", done: false },
  { title: "Ship dark mode", done: true },
];

export function summarize(tasks) {
  // TODO: count completed and remaining tasks, and calculate progress.
  // Empty lists have 0 percent progress.
}
`,
    );
    writeFileSync(
      path.join(workingDir, "AGENTS.md"),
      subagents
        ? "Work only in this sample project. Use two subagents for implementation and tests when asked. Do not use MCP tools. Keep your final response brief.\n"
        : "Work only in this sample project. Implement the requested feature and run bun test. Do not use MCP tools or launch other agents. Keep your final response brief.\n",
    );
    run("git", ["-C", workingDir, "init", "-q"]);
    const panes = [
      await post("/api/subshells", { name: "Build feature", harnessId: "codex", presetId: agentPreset.id, workingDir }),
      await post("/api/subshells", { name: "Run tests", harnessId: "terminal", presetId: shellPreset.id, workingDir }),
    ];
    const workspace = await post("/api/workspaces", { name: "Task board", subshellId: panes[0].id });
    await post(`/api/workspaces/${workspace.id}/panes`, { subshellId: panes[1].id });
    const name = mobile ? "mobile-workspace" : "desktop-workspace";
    const frames = path.join(root, name);
    mkdirSync(frames);
    const context = await browser.newContext({
      storageState: await api.storageState(),
      baseURL: BASE_URL,
      viewport: mobile ? { width: 390, height: 844 } : { width: 900, height: 560 },
      deviceScaleFactor: 2,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: "dark",
    });
    await context.addInitScript(
      ({ size }) => {
        localStorage.setItem("subshell.termFontSize", String(size));
      },
      { size: mobile ? 22 : subagents ? 20 : 22 },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`/workspaces/${workspace.id}`);
    // Desktop tabs can include a waiting marker in their accessible name.
    const tab = (label: string) =>
      mobile
        ? page.getByRole("button", { name: new RegExp(`^${label}(?: waiting for you)?$`) })
        : page.getByRole("tab").filter({ has: page.getByText(label, { exact: true }) });
    await expect(tab("Build feature")).toBeVisible();
    await tab("Build feature").click();
    const log = async (id: string) =>
      (await (await api.get(`/api/subshells/${id}/log`)).json()).lines.join("\n") as string;
    await page.waitForTimeout(4000);
    const initial = await log(panes[0].id);
    if (initial.includes("trust") || initial.includes("Trust")) {
      await post(`/api/subshells/${panes[0].id}/input`, { text: "\r", submit: false });
      await page.waitForTimeout(3000);
    }
    // Codex explains that per-launch preset overrides use its embedded mode.
    // Read and dismiss startup notices through the CLI before filming the task.
    for (let notice = 0; notice < 3; notice++) {
      await post(`/api/subshells/${panes[0].id}/input`, { text: "\x1b[12~", submit: false });
      await page.waitForTimeout(400);
      console.log(name, "startup notice", (await log(panes[0].id)).slice(-600));
      await post(`/api/subshells/${panes[0].id}/input`, { text: "\x1b", submit: false });
      await page.waitForTimeout(400);
    }
    if (subagents) {
      // This fresh CODEX_HOME contains only this fixture's three monitoring
      // hooks. Review them through the CLI before filming, never in real profiles.
      await post(`/api/subshells/${panes[0].id}/input`, { text: "/hooks", submit: false });
      await page.waitForTimeout(500);
      await post(`/api/subshells/${panes[0].id}/input`, { text: "\r", submit: false });
      await page.waitForTimeout(700);
      expect(await log(panes[0].id)).toContain("3 hooks need review");
      await post(`/api/subshells/${panes[0].id}/input`, { text: "t", submit: false });
      await page.waitForTimeout(500);
      await post(`/api/subshells/${panes[0].id}/input`, { text: "\x1b", submit: false });
      await page.waitForTimeout(500);
    }
    let frame = 0;
    async function hold(seconds: number, keepPointer = false) {
      if (!keepPointer) await page.mouse.move(890, 550);
      for (let i = 0; i < seconds * 15; i++) {
        const start = Date.now();
        await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(4, "0")}.png`) });
        await page.waitForTimeout(Math.max(0, 1000 / 15 - (Date.now() - start)));
      }
    }
    const inset = await page
      .locator(".xterm:visible")
      .first()
      .evaluate((terminal) => {
        const box = terminal.getBoundingClientRect();
        const screen = terminal.querySelector(".xterm-screen")?.getBoundingClientRect();
        if (!screen) throw new Error("Missing terminal grid");
        return {
          left: screen.left - box.left,
          top: screen.top - box.top,
          right: box.right - screen.right,
          bottom: box.bottom - screen.bottom,
        };
      });
    for (const edge of Object.values(inset)) expect(edge).toBeGreaterThanOrEqual(7);
    console.log(name, "terminal insets", inset);
    const prompt = subagents
      ? "Use two subagents: one implements summarize() in tasks.js; the other writes tasks.test.js. Return total, completed, remaining, and rounded percent; empty lists have 0 percent. Test empty, mixed, and completed lists. Then run bun test and summarize the result."
      : "Add task progress to summarize(): total, completed, remaining, and rounded percent. Test empty, mixed, and completed lists. Run bun test.";
    await post(`/api/subshells/${panes[0].id}/input`, { text: prompt, submit: false });
    await hold(2);
    await post(`/api/subshells/${panes[0].id}/input`, { text: "\r", submit: false });
    // Retain real bursts of work, trimming idle time between them.
    let demonstrated = false;
    let posterFrame: number | undefined;
    for (let stage = 0; stage < 90; stage++) {
      await hold(1);
      if (
        subagents &&
        !demonstrated &&
        (await page.getByRole("button", { name: "Collapse subshell details", exact: true }).count())
      ) {
        await hold(2);
        posterFrame = frame - 1;
        await page.getByRole("button", { name: "Collapse subshell details", exact: true }).click();
        await hold(1);
        await page.getByRole("button", { name: "Expand subshell details", exact: true }).click();
        await hold(2);
        await page.getByRole("link", { name: /Build feature/ }).click();
        await hold(1);
        await page.getByRole("link", { name: /Build feature/ }).click();
        await hold(2);
        demonstrated = true;
      }
      await page.waitForTimeout(3000);
      const output = await log(panes[0].id);
      console.log(name, "stage", stage, output.slice(-900));
      if (
        output.includes("tokens used") ||
        (output.includes("Worked for") && existsSync(path.join(workingDir, "tasks.test.js")))
      )
        break;
      if (stage === 89) throw new Error("Agent did not finish the sample task");
    }
    if (subagents) expect(demonstrated).toBe(true);
    await hold(3);
    expect(readFileSync(path.join(workingDir, "tasks.js"), "utf8")).not.toContain("// TODO");
    run("bun", ["test", path.join(workingDir, "tasks.test.js")]);
    if (subagents) {
      // Membership changes don't stop the tests shell or leave this workspace.
      const members = page.locator('[data-sidebar-drop="add"]');
      const others = page.locator('[data-sidebar-drop="remove"]');
      async function transferRow(from: typeof members, to: typeof members, label: string) {
        const row = from.locator(`a[href="/subshells/${panes[1].id}"]`);
        const source = await row.boundingBox();
        const target = await to.boundingBox();
        if (!source || !target) throw new Error("Sidebar transfer bounds unavailable");
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
        await expect(to.getByRole("status")).toHaveText(label);
        await hold(2, true);
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
        await page.mouse.up();
        await expect(to.locator(`a[href="/subshells/${panes[1].id}"]`)).toBeVisible();
        await hold(2);
      }
      await transferRow(members, others, "Remove from workspace");
      await transferRow(others, members, "Add to workspace");
    }
    await tab("Run tests").click();
    await post(`/api/subshells/${panes[1].id}/input`, { text: "bun test", submit: false });
    await hold(1);
    await post(`/api/subshells/${panes[1].id}/input`, { text: "\r", submit: false });
    await hold(4);
    await post(`/api/subshells/${panes[1].id}/input`, {
      text: `bun -e 'import { tasks, summarize } from "./tasks.js"; console.table(summarize(tasks))'`,
      submit: true,
    });
    await hold(3);
    // The harness can rename the subshell while doing the task.
    const finishedPane = await (await api.get(`/api/subshells/${panes[0].id}`)).json();
    await tab(finishedPane.name).click();
    await hold(2);
    expect(page.url()).toContain(`/workspaces/${workspace.id}`);
    if (mobile) await expect(page.getByRole("navigation", { name: "Main sections" })).not.toBeVisible();
    // Every ffmpeg write lands in the scratch root first and is copied to the
    // committed path only on success: an encode killed mid-write (Ctrl-C, OOM)
    // would otherwise leave a corrupt binary sitting exactly where the next
    // commit would pick it up.
    const publish = (file: string) => copyFileSync(path.join(root, file), path.join(out, file));
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
      path.join(root, `${name}.mp4`),
    ]);
    publish(`${name}.mp4`);
    run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      path.join(frames, `${String(posterFrame ?? frame - 15).padStart(4, "0")}.png`),
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      path.join(root, `${name}.webp`),
    ]);
    publish(`${name}.webp`);
    if (subagents) {
      run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        path.join(root, `${name}.webp`),
        path.join(root, "harness-subagents.png"),
      ]);
      copyFileSync(
        path.join(root, "harness-subagents.png"),
        path.resolve(import.meta.dirname, "../apps/docs/public/screenshots/harness-subagents.png"),
      );
    }
    await context.close();
    console.log(`Captured ${name}: ${frame} frames`);
  }
  // Same scratch-then-copy rule for the gif: only a finished encode reaches docs/.
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    path.join(out, "desktop-workspace.mp4"),
    "-filter_complex",
    "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop",
    "0",
    path.join(root, "subshell-demo.gif"),
  ]);
  copyFileSync(
    path.join(root, "subshell-demo.gif"),
    path.resolve(import.meta.dirname, "../docs/assets/subshell-demo.gif"),
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
}
