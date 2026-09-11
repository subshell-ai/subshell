import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";

/**
 * The claim this branch earns: a machine with NO agent CLI installed walks
 * the first-run wizard and ends up typing into a live terminal. The suite
 * shares one database, so spec 01 owns the pristine instance's single wizard
 * run — this spec therefore boots its OWN backend (port 3200, spec-12's
 * "spawn a child the suite cleans up" pattern) against a fresh temp DB and
 * data dir, with every agent plugin's `envOverride` pointed at a file that
 * does not exist. That last part is what makes the claim machine-independent:
 * a developer's laptop with the real `claude` on PATH still tests the CLEAN
 * machine, because rung 1 of the lookup ladder answers "override-invalid"
 * before PATH is ever consulted.
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const ORIGIN = `http://127.0.0.1:${PORTS.onboarding}`;
/** tmux spawn + first status poll take seconds (same budget as spec 06). */
const SPAWN_TIMEOUT = 30_000;

/** Every agent plugin's detect.envOverride — the clean machine names nothing
 *  it can find. Terminal's SHELL deliberately stays out of this list. */
const AGENT_OVERRIDES = ["CLAUDE_PATH", "CODEX_PATH", "HERMES_PATH", "OPENCODE_PATH", "PI_PATH"];

interface CleanInstance {
  child: ReturnType<typeof spawn>;
  dir: string;
  tmuxBase: string;
}

let instance: CleanInstance | undefined;

async function startCleanInstance(): Promise<CleanInstance> {
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-clean-"));
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });
  const missing = path.join(dir, "absent-binaries");
  mkdirSync(missing, { recursive: true });

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env: {
      ...process.env,
      NODE_ENV: "development",
      SUBSHELL_TEST_MODE: "false",
      SUBSHELL_SERVER_CONFIG_DIR: dir,
      SERVER_PORT: String(PORTS.onboarding),
      HOST: "127.0.0.1",
      DATABASE_PATH: path.join(dir, "subshell.db"),
      SUBSHELL_SERVER_DATA_DIR: path.join(dir, "data"),
      APP_BASE_URL: ORIGIN,
      BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
      // Keep the suite's promise that nothing dials the public registry, even
      // though this spec never installs a plugin.
      SUBSHELL_PLUGIN_REGISTRY_URL: `http://127.0.0.1:${PORTS.fakeRegistry}`,
      TMUX_TMPDIR: tmuxBase,
      // The clean machine: each agent's override names a file in an empty
      // scratch dir, so detection is deterministic on EVERY host — CI image,
      // dev laptop with CLIs installed, both.
      ...Object.fromEntries(AGENT_OVERRIDES.map((name) => [name, path.join(missing, name.toLowerCase())])),
    },
  });
  child.unref();
  const inst: CleanInstance = { child, dir, tmuxBase };
  instance = inst;

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}/api/setup/status`);
      if (res.ok) {
        const body = (await res.json()) as { needsSetup: boolean };
        // A FALSE here means the port answered from a leaked previous run —
        // fail loudly rather than drive a wizard that is not there.
        if (!body.needsSetup) throw new Error("[e2e] clean instance: port already set up");
        return inst;
      }
    } catch (err) {
      if ((err as Error).message.includes("port already set up")) throw err as Error;
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`[e2e] clean instance did not become ready at ${ORIGIN}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function stopCleanInstance(): void {
  if (!instance) return;
  const { child, dir, tmuxBase } = instance;
  instance = undefined;
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  // The pane's tmux server detached away from the backend's process group
  // (the same leak stack.ts's teardown guards), so kill by socket. The
  // Playwright runner is NODE, so node's spawnSync — the spec must not lean
  // on Bun globals the way backend-side code may (see e2e/AGENTS.md).
  for (const uidDir of readdirSafe(tmuxBase)) {
    for (const socket of readdirSafe(path.join(tmuxBase, uidDir))) {
      try {
        spawnSync("tmux", ["-S", path.join(tmuxBase, uidDir, socket), "kill-server"]);
      } catch {
        // Best-effort per socket.
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.dirname(tmuxBase), { recursive: true, force: true });
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test.afterAll(stopCleanInstance);

test("a machine with no agent CLI reaches a live terminal through the wizard", async ({ page }) => {
  test.setTimeout(120_000);
  const inst = await startCleanInstance();
  expect(inst.child.exitCode).toBeNull();

  await page.goto(`${ORIGIN}/setup`);
  await expect(page.getByText("Welcome to Subshell")).toBeVisible();

  // Step 1: account. (Unique per retry — a retry must not collide with
  // attempt 0's leftover row the way spec 06/07's names do.)
  await page.fill("#name", "Ada");
  await page.fill("#email", `onboarding-${test.info().retry}@subshell.test`);
  await page.fill("#password", "e2e-onboarding-pass-1");
  await page.fill("#password-confirm", "e2e-onboarding-pass-1");
  await page.getByRole("button", { name: "Create admin account" }).click();

  // Step 2: skip the agent entirely. This is the whole point: nothing agent-
  // shaped is installed, and the wizard must still reach a subshell.
  await expect(page.getByText("Add an agent (optional)")).toBeVisible();
  // Terminal — the one plugin that needs no program of its own — is the only
  // "ready" row on this machine.
  await expect(
    page.getByRole("group", { name: "Terminal", exact: true }).getByText("ready", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "pi", exact: true }).getByText("ready", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: the form arrives filled in. Assert that BEFORE clicking, so a
  // regression in the defaults fails here rather than as a disabled button.
  await expect(page.locator("#setup-working-dir")).not.toHaveValue("");
  await expect(page.getByPlaceholder("Choose a profile")).toHaveValue(/terminal/);
  const start = page.getByRole("button", { name: "Start my first subshell" });
  await expect(start).toBeEnabled();

  // Arm the liveness listeners BEFORE the click (spec 06's pattern): the
  // terminal's reality is the ws-token mint + /ws upgrade + no reconnecting
  // pill + the running badge — never pane text.
  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });

  await start.click();
  await expect(page).toHaveURL(/\/subshells\//, { timeout: SPAWN_TIMEOUT });
  await tokenRes;
  const ws = await socket;
  expect(ws.url()).toContain(`/ws?subshell=`);
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  await expect(page.getByText("running", { exact: true }).first()).toBeVisible({ timeout: SPAWN_TIMEOUT });
  await expect(page.locator(".xterm-screen")).toBeVisible();

  // And the shell does NOT bounce back to /setup on reload — the launch
  // retired setup-status like any completion does.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Subshells" })).toBeVisible();
});
