import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type Page, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";
import { expectSubshellRunning } from "./helpers";

/**
 * Plan 3's browser proof (spec 2026-10-07 §7, plan Task 5): the destination-
 * first /connect page driven in a REAL browser against a REAL sshd. Four
 * scenarios, in order, each its own test with its own page context:
 *
 *  1. gate OFF (the fresh instance's default): the machine picker keeps the
 *     control-plane host VISIBLE and DISABLED with the reason "SSH is off on
 *     this machine" - greying explains, hiding does not (decision 3). The
 *     disabled row is never clicked; the field staying empty IS the inertness
 *     assertion.
 *  2. the two-sentence Match exec disclosure, verbatim (decision 6), above the
 *     Connect button BEFORE any Connect is attempted - the box-order check
 *     makes "before the button" a literal assertion.
 *  3. gate ON (a REST flip on the admin's own cookie session, then a reload):
 *     the sole SSH-enabled machine pre-selects honestly, the destination
 *     picker's config group carries the fixture alias, Connect POSTs once and
 *     the router lands on /subshells/<id>; the typed line comes back EVALUATED
 *     by the remote shell (only the shell's arithmetic spells CONNECT-7-OK),
 *     read through the pane-log route - spec 22's proof, browser-driven.
 *  4. an EVERYONE-edit sharee opening the SAME pane sees the SSH badge and the
 *     view-only sentence, and their typing leaves nothing in the log (the
 *     client posture; the 403 itself is tier 2's, pinned in spec 22).
 *
 * Why its own backend: exactly spec 22's reason - the ssh tier resolves as the
 * server process's HOME and bun caches `os.homedir()` per process, so this
 * child is SPAWNED with `HOME=<fixture home>` + the spec's ssh-agent socket,
 * on its own temp DB, data dir and tmux base (port: PORTS.connect, a fresh
 * slot so the two ssh specs' instances can never collide).
 *
 * The control-plane host is the seeded `local` node, whose picker NAME is
 * "Server" (seed-local.ts) - the assertions read that name because the page
 * reads node rows, not ids.
 *
 * Binaries: ssh / ssh-keygen / sshd, decided by the fixture's own gate; a host
 * without them SKIPS LOUDLY and never fakes a pass.
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const ORIGIN = `http://127.0.0.1:${PORTS.connect}`;

const READY_TIMEOUT = 60_000;
const SPAWN_TIMEOUT = 90_000;

const missing = missingSshBins();
test.skip(missing.length > 0, `SSH binaries absent on this host (${missing.join(", ")}) - spec 23 needs a real sshd`);

/** The exact strings the page ships (components/connect/* + components/ssh-pane-labels.tsx). */
const SSH_DISCLOSURE_COPY =
  "Resolving asks the connecting machine to read its SSH config. A hidden Match exec in that config can run a local command while it resolves.";
const SSH_VIEW_ONLY_COPY = "SSH sessions take input from their owner only.";
const MACHINE_OFF_REASON = "SSH is off here. An admin can switch it on in Server Settings.";
/** The seeded control-plane host's display name (seed-local.ts): the picker reads names, not ids. */
const LOCAL_NODE_NAME = "Server";
/** `configGroupLabel(selectedNode.name)` for that row. */
const CONFIG_GROUP = `From ${LOCAL_NODE_NAME}'s config`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until true or the deadline; on timeout throws the label's current text. */
async function pollUntil(
  label: string | (() => string),
  check: () => Promise<boolean> | boolean,
  timeoutMs = SPAWN_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(typeof label === "string" ? label : label());
    await sleep(500);
  }
}

interface ConnectInstance {
  child: ReturnType<typeof spawn>;
  dir: string;
  tmuxBase: string;
}

/** Boots the spec's OWN backend on `PORTS.connect` with HOME + SSH_AUTH_SOCK in ITS env (spec 22's recipe). */
async function startConnectBackend(fixtureHome: string, sshAuthSock: string): Promise<ConnectInstance> {
  // Same orphan guard as specs 15/22: a dead retry's detached backend would
  // hold :3202 for the next boot.
  stopConnectBackend();
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-connect-"));
  const dataDir = path.join(dir, "data");
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    SUBSHELL_TEST_MODE: "false",
    SUBSHELL_SERVER_CONFIG_DIR: dir,
    SERVER_PORT: String(PORTS.connect),
    HOST: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "subshell.db"),
    SUBSHELL_SERVER_DATA_DIR: dataDir,
    APP_BASE_URL: ORIGIN,
    BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
    SUBSHELL_PLUGIN_REGISTRY_URL: `http://127.0.0.1:${PORTS.fakeRegistry}`,
    SUBSHELL_RELEASE_URL: "",
    TMUX_TMPDIR: tmuxBase,
    // The two the ssh tier reads (spec 22's header): HOME is the alias/config
    // source for discovery AND for `ssh -G`; SSH_AUTH_SOCK is the resolve's
    // agent-socket fact.
    HOME: fixtureHome,
    SSH_AUTH_SOCK: sshAuthSock,
  };
  // A developer inside tmux must not hand the backend their session's pane.
  delete env.TMUX;
  delete env.TMUX_PANE;

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env,
  });
  child.unref();
  const inst: ConnectInstance = { child, dir, tmuxBase };
  instance = inst;

  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}/api/setup/status`);
      if (res.ok) {
        const body = (await res.json()) as { needsSetup: boolean };
        if (!body.needsSetup) throw new Error("[e2e] connect instance: port already set up (leaked run)");
        return inst;
      }
    } catch (err) {
      if ((err as Error).message.includes("port already set up")) throw err as Error;
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`[e2e] connect instance did not become ready at ${ORIGIN}`);
    await sleep(300);
  }
}

/** The instance this file's beforeAll started (module scope: the cleanup paths reach it across retries). */
let instance: ConnectInstance | undefined;

function stopConnectBackend(): void {
  const inst = instance;
  if (!inst) return;
  instance = undefined;
  try {
    if (inst.child.pid) process.kill(-inst.child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  // The ssh pane's tmux server detached away from the backend's process group
  // (the stack.ts lesson), so kill by socket, then wipe the scratch dirs.
  for (const uidDir of readdirSafe(inst.tmuxBase)) {
    for (const socket of readdirSafe(path.join(inst.tmuxBase, uidDir))) {
      try {
        spawnSync("tmux", ["-S", path.join(inst.tmuxBase, uidDir, socket), "kill-server"]);
      } catch {
        // Best-effort per socket.
      }
    }
  }
  rmSync(inst.dir, { recursive: true, force: true });
  rmSync(path.dirname(inst.tmuxBase), { recursive: true, force: true });
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const ADMIN = {
  name: "Connect Admin",
  email: "connect-admin@subshell.test",
  password: "e2e-connect-admin-pass-1",
} as const;
const MEMBER_PASSWORD = "e2e-connect-member-pass-1";

/**
 * A fresh cookieless API context (spec 22's rule: the sign-up itself passes
 * the Origin/CSRF guard and seeds the jar, so each principal acts as itself).
 */
function freshCtx(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
}

let fixture: SshFixture | undefined;
let fixtureRoot: string | undefined;
let agentPid: number | undefined;
/** The admin's REST session: the gate flips, the pane row, and every log read ride it while the browser does the UI. */
let admin: APIRequestContext | undefined;
/** The pane test 3 launched; test 4 drives a viewer into it, and the cleanup reaches it by id. */
let paneId: string | undefined;

test.beforeAll(async ({ playwright }) => {
  // The module-level skip already holds the file off this path; the guard is
  // so a skipped file never boots daemons either.
  if (missing.length > 0) return;

  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-connfix-"));
  fixture = await startSshFixture(fixtureRoot);

  // An ssh-agent holding the fixture's trusted key (spec 22's setup): the
  // backend's resolve reads SSH_AUTH_SOCK from the SERVER process env. The
  // fixture alias pins `IdentityAgent none`, so the pane dials with the
  // IdentityFile key; the agent is the env fact, not the authenticator.
  const agentOut = spawnSync("ssh-agent", ["-s"], { encoding: "utf8" });
  if (agentOut.status !== 0) throw new Error(`ssh-agent failed: ${agentOut.stderr}`);
  const agentEnv = Object.fromEntries(
    ["SSH_AUTH_SOCK", "SSH_AGENT_PID"].map((k) => [k, agentOut.stdout.match(new RegExp(`${k}=([^;]+)`))?.[1] ?? ""]),
  );
  agentPid = Number(agentEnv.SSH_AGENT_PID);
  if (!agentEnv.SSH_AUTH_SOCK || !Number.isInteger(agentPid) || agentPid <= 0) {
    throw new Error(`ssh-agent output unparseable: ${agentOut.stdout.slice(0, 200)}`);
  }
  const add = spawnSync("ssh-add", [fixture.trustedKeyPath], {
    env: { ...process.env, SSH_AUTH_SOCK: agentEnv.SSH_AUTH_SOCK },
    encoding: "utf8",
  });
  if (add.status !== 0) throw new Error(`ssh-add failed: ${add.stderr}`);

  await startConnectBackend(fixture.sshConfigHome, agentEnv.SSH_AUTH_SOCK);

  // The first registered account becomes admin (spec 01's rule on a fresh
  // instance), through the wizard's own endpoint. needsSetup is `!hasUsers`
  // server-side, so from here the SPA answers the app, not /setup.
  admin = await freshCtx(playwright);
  const signUp = await admin.post("/api/auth/sign-up/email", { data: ADMIN });
  expect(signUp.ok(), await signUp.text()).toBe(true);

  // The first promoted account is born with the wizard bookmark "network"
  // (promoteFirstUserAtomically), which keeps the signed-in root gate on
  // /setup. This account was minted by the API, not the wizard, so the
  // bookmark is cleared the way the wizard's own completion clears it - the
  // PATCH is the same route the wizard's writes go through (cookie session
  // only, which the sign-up above seeded).
  const retired = await admin.patch("/api/setup/progress", { data: { step: null } });
  expect(retired.ok(), await retired.text()).toBe(true);
  expect(((await retired.json()) as { step: string | null }).step).toBeNull();
});

test.afterAll(async () => {
  const leaks: string[] = [];
  if (paneId !== undefined && admin) {
    try {
      const res = await admin.post(`/api/subshells/${paneId}/terminate`);
      if (!res.ok() && res.status() !== 404) leaks.push(`cleanup terminate: HTTP ${res.status()}`);
      await admin.delete(`/api/subshells/${paneId}`);
    } catch (err) {
      leaks.push(`cleanup row: ${String(err)}`);
    }
  }
  try {
    await admin?.dispose();
  } catch (err) {
    leaks.push(`admin ctx dispose: ${String(err)}`);
  }
  admin = undefined;
  paneId = undefined;
  if (agentPid !== undefined) {
    try {
      process.kill(agentPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  try {
    await fixture?.stop();
  } catch (err) {
    leaks.push(`sshd fixture stop: ${String(err)}`);
  }
  try {
    stopConnectBackend();
  } catch (err) {
    leaks.push(`backend stop: ${String(err)}`);
  }
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
  fixture = undefined;
  fixtureRoot = undefined;
  if (leaks.length > 0) console.error(`[23-connect-flow] cleanup problems: ${leaks.join("; ")}`);
});

/** Sign in through the REAL login form on this instance (spec 11's pattern, absolute origin: the page fixture's baseURL is the shared stack). */
async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${ORIGIN}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: READY_TIMEOUT });
}

/** The /connect page, fields mounted (the panel renders them on mount; the queries fill them in). */
async function openConnectPage(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/connect`);
  await expect(page.getByRole("heading", { name: "Connect", exact: true })).toBeVisible();
  await expect(page.locator("#connect-destination")).toBeVisible();
}

function requireAdmin(): APIRequestContext {
  if (!admin) throw new Error("[23] beforeAll did not produce the admin session");
  return admin;
}

function requirePaneId(): string {
  if (paneId === undefined) throw new Error("[23] test 3 never produced a pane");
  return paneId;
}

test("gate off: the control-plane host sits disabled in the machine picker with its reason", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await openConnectPage(page);

  // Base UI opens its popup on the pointer path; a real Playwright click is
  // exactly that. The picker keeps the gated-off row LISTED (decision 3).
  await page.locator("#connect-machine").click();
  const popup = page.locator('[data-slot="combobox-content"]');
  const serverRow = popup.getByRole("option", { name: /Server/ });
  await expect(serverRow).toHaveAttribute("data-disabled", "");
  await expect(serverRow).toContainText(MACHINE_OFF_REASON);

  // Inertness, asserted rather than attempted (the T3 handoff): no click is
  // fired at the disabled row; the field still carries no selection.
  await expect(page.locator("#connect-machine")).toHaveValue("");
});

test("the disclosure names the Match exec risk above the Connect button, before any Connect", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await openConnectPage(page);

  const disclosure = page.getByText(SSH_DISCLOSURE_COPY);
  await expect(disclosure).toBeVisible();
  const connectButton = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connectButton).toBeVisible();

  // "Before the button" literally: the paragraph's box lies above the
  // button's box in the reading column.
  const disclosureBox = await disclosure.boundingBox();
  const buttonBox = await connectButton.boundingBox();
  expect(disclosureBox && buttonBox ? disclosureBox.y + disclosureBox.height <= buttonBox.y : false).toBe(true);
});

test("gate on: destination-first launch reaches a live ssh pane whose remote shell answers", async ({ page }) => {
  test.setTimeout(300_000);
  const adminCtx = requireAdmin();

  // The flip happens OUTSIDE the browser (REST, admin cookie) and the reload
  // picks the fact up: the page reads sshEnabled off the node view it fetches
  // fresh on mount.
  const enable = await adminCtx.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
  expect(enable.ok(), await enable.text()).toBe(true);
  expect(((await enable.json()) as { sshEnabled: boolean }).sshEnabled).toBe(true);

  await login(page, ADMIN.email, ADMIN.password);
  await openConnectPage(page);

  // Exactly one SSH-enabled machine and no preference: pre-selected honestly
  // and still on screen (decision 2), labelled with the node's own name.
  await expect(page.locator("#connect-machine")).toHaveValue(/Server/);

  // The destination picker's config group (the handoff): the BROWSER session
  // fetches the machine's aliases; the fixture's alias rides under it.
  await page.locator("#connect-destination").click();
  const panel = page.locator("#connect-destination-panel");
  await expect(panel.getByText(CONFIG_GROUP, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await panel.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true }).click();
  // The committed pick: the field's text is the row's label, and the wire
  // value behind it is the alias token (buildDestinationOptions).
  await expect(page.locator("#connect-destination")).toHaveValue(SSH_FIXTURE_ALIAS);

  // Connect: one POST, and the router lands on the pane's page. Arm the
  // attach socket BEFORE the click (spec 15's rule): typing needs the live
  // /ws, not just a running row.
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws"),
    timeout: READY_TIMEOUT,
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(/\/subshells\/[a-zA-Z0-9_-]{1,64}$/, { timeout: READY_TIMEOUT });
  paneId = new URL(page.url()).pathname.split("/").pop();

  // The pane's own header labels the kind it is (T4's badge, owner included).
  await expect(page.getByText("SSH", { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await expectSubshellRunning(page, READY_TIMEOUT);
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await socket;

  // Settle on sshd's own truth, not the row (spec 22): `alive` is stamped at
  // create, and the pty is in the pre-raw line discipline during the ssh
  // handshake - it swallows the Enter. The beat after covers the remote
  // shell's init before its line editor exists.
  const daemonLog = fixture?.logPath;
  if (daemonLog === undefined) throw new Error("[23] fixture is gone");
  await pollUntil(
    () => `sshd never reported a shell for ${paneId}; its log ends: ${readFileSync(daemonLog, "utf8").slice(-800)}`,
    () => /Starting session: shell/.test(readFileSync(daemonLog, "utf8")),
    READY_TIMEOUT,
  );
  await sleep(1_500);

  await page.locator(".xterm-helper-textarea").click();
  // The typed line NEVER spells the result (spec 22's argument): only the
  // REMOTE shell's arithmetic prints CONNECT-7-OK, so the log match proves
  // bytes travelled both ways through real ssh, typed here through the page.
  await page.keyboard.type("echo CONNECT-$((6+1))-OK\r");

  let lastLogView = "";
  await pollUntil(
    () =>
      `the pane log never carried the remote shell's evaluated marker; last read: ${JSON.stringify(lastLogView.slice(-1200))}`,
    async () => {
      const res = await adminCtx.get(`/api/subshells/${paneId}/log`);
      if (!res.ok()) {
        lastLogView = `HTTP ${res.status()} ${(await res.text()).slice(0, 300)}`;
        return false;
      }
      lastLogView = ((await res.json()) as { lines: string[] }).lines.join("\n");
      return lastLogView.includes("CONNECT-7-OK");
    },
    SPAWN_TIMEOUT,
  );
});

test("view only: an edit sharee sees the SSH rule in the header and their typing changes nothing", async ({ page }) => {
  test.setTimeout(180_000);
  const adminCtx = requireAdmin();
  const id = requirePaneId();

  // A second account with the ordinary EVERYONE edit grant (spec 22's shape).
  const memberEmail = `connect-member-${test.info().retry}@subshell.test`;
  const created = await adminCtx.post("/api/users", {
    data: { email: memberEmail, name: memberEmail, password: MEMBER_PASSWORD, role: "user" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const shared = await adminCtx.put(`/api/subshells/${id}/shares`, {
    data: { shares: [{ granteeUserId: null, permission: "edit" }] },
  });
  expect(shared.ok(), await shared.text()).toBe(true);

  await login(page, memberEmail, MEMBER_PASSWORD);

  // The VIEW layer's downgrade read through the member's own browser session
  // (decision 1): the grant says edit, the ssh rule answers view.
  const memberView = await page.request.get(`${ORIGIN}/api/subshells/${id}`);
  expect(memberView.ok(), await memberView.text()).toBe(true);
  const view = (await memberView.json()) as { access: string; ssh: boolean };
  expect(view.access).toBe("view");
  expect(view.ssh).toBe(true);

  await page.goto(`${ORIGIN}/subshells/${id}`);
  await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: READY_TIMEOUT });
  // The badge names the kind of pane; the sentence names the rule (T4's copy).
  await expect(page.getByText("SSH", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(SSH_VIEW_ONLY_COPY)).toBeVisible();

  // The client posture: the terminal is mounted but takes nothing. Whether the
  // keystroke dies at disableStdin or at the WS gate, the PROOF is the same -
  // the nonce never reaches the log (spec 22 owns the 403 itself).
  await page.locator(".xterm-helper-textarea").click();
  const nonce = `VIEW-TYPE-${test.info().retry}-${Date.now()}`;
  await page.keyboard.type(`echo ${nonce}\r`);
  await sleep(1_500); // give any raced write a beat, then require absence from the whole log
  const logRes = await adminCtx.get(`/api/subshells/${id}/log`);
  expect(logRes.ok(), await logRes.text()).toBe(true);
  expect(((await logRes.json()) as { lines: string[] }).lines.join("\n")).not.toContain(nonce);
});
