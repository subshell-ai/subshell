import { spawn } from "node:child_process";
import { accessSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type Page, request as pwRequest, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { BASE_URL } from "../ports";
import { shortTmuxBase } from "../stack";
import { NODE_MAIN, type RunningNode, startNode } from "../stub/client";
import { pollUntil, sweepTmuxServers } from "./helpers";
import { rmScratch, seedAdminApi } from "./ssh-support";

/**
 * CONNECT OVER SSH end to end (design 2026-10-05 §1/§7, workstream U): the
 * personal journey from the SIDEBAR, driven by a NON-ADMIN who owns the
 * connecting node. No direct URLs: sign in, press the rail's "Connect over
 * SSH", pick the machine, discover the host aliases on it, review the
 * resolved destination, connect (the probe IS the test), browse the
 * destination's folders, launch a terminal pane, read the pane's trusted
 * identity line, and SEE it live: an open streaming /ws with no
 * "reconnecting…" pill and a browser-typed marker landing in the pane's log
 * (the acceptance run's F1 was precisely this journey's attach loop). Then
 * the session is closed from the sessions view, and the missing-runtime
 * guidance path is proven against a second fixture sshd whose PATH carries no
 * `subshell` shim.
 *
 * The destination IS this host (spec 22's posture): the fixture sshd accepts
 * the same account, and the happy destination's PATH carries a `subshell`
 * shim - a scratch script re-entering this checkout in source mode (spec 12's
 * parity), pinning the runtime's data dir and TMUX_TMPDIR into scratch dirs
 * the teardown owns. The guidance destination's daemon starts from the
 * un-prepended PATH, so its probe answers absence for real. The connecting
 * node's HOME is the fixture config dir, where a second alias
 * `e2edest-nobin` is appended to point at the second daemon.
 *
 * Truth assertions are server/network truth and this app's own chrome text
 * (e2e/AGENTS.md): every pane fact is read from the REST API; the xterm grid
 * is never grepped.
 */

const missing = missingSshBins();
test.skip(missing.length > 0, `connect-over-ssh e2e skipped: this host lacks ${missing.join(", ")}`);
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const NODE_NAME = `e2e-conn-${RUN}`;
const MEMBER_EMAIL = `conn23-${RUN}@subshell.test`;
const MEMBER_PW = `conn23-pass-${RUN}`;
/** The second destination's alias (this spec appends it to the fixture config). */
const NOBIN_ALIAS = "e2edest-nobin";

function mkdtemp(prefix: string): string {
  const base = path.join(tmpdir(), `${prefix}${RUN}-`);
  mkdirSync(base, { recursive: true });
  return base;
}

/** The wrapper the happy destination finds on PATH as `subshell`. */
function resolveBun(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "")) {
    try {
      accessSync(path.join(dir, "bun"));
      return path.join(dir, "bun");
    } catch {
      // not here
    }
  }
  throw new Error("the e2e host has no bun on PATH (spec 12/21/22 would already have died)");
}

let admin: APIRequestContext;
let memberApi: APIRequestContext;
let fixtureA: SshFixture | undefined; // the happy destination (PATH carries the shim)
let fixtureB: SshFixture | undefined; // the runtime-less destination
let agent: RunningNode | undefined;
let agentHome = "";
let tmuxBase = "";
let destTmuxBase = "";
let rootA = "";
let rootB = "";
let scratch = "";
let nodeId = "";
let setupKeyId = "";
let sessionId = "";
let paneId = "";

const sshA = (): SshFixture => {
  if (fixtureA === undefined) throw new Error("fixture sshd A never started");
  return fixtureA;
};
const sshB = (): SshFixture => {
  if (fixtureB === undefined) throw new Error("fixture sshd B never started");
  return fixtureB;
};
const agentTail = (): string => agent?.logTail() ?? "(agent never started)";

interface SessionRow {
  id: string;
  status: string;
  runtimeNodeId: string;
}

/** The member signs in through the login form (the rail journey starts here, and only here). */
async function loginMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", MEMBER_EMAIL);
  await page.fill("#password", MEMBER_PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

test.beforeAll(async () => {
  admin = await seedAdminApi();

  scratch = mkdtemp("subshell-e2e-conn-");
  const shimDir = path.join(scratch, "bin");
  const runtimeData = path.join(scratch, "runtime-data");
  destTmuxBase = path.join(scratch, "tmux-dest");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(runtimeData, { recursive: true, mode: 0o700 });
  mkdirSync(destTmuxBase, { recursive: true, mode: 0o700 });
  const shimPath = path.join(shimDir, "subshell");
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      `export SUBSHELL_RUNTIME_DATA_DIR=${runtimeData}`,
      `export TMUX_TMPDIR=${destTmuxBase}`,
      `exec ${resolveBun()} ${NODE_MAIN} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);

  // sshd resets a session's PATH to the platform login default (measured), so
  // the happy fixture HANDS OUT a session PATH that carries the shim via the
  // fixture's SetEnv seam; the guidance fixture does not, which is exactly the
  // missing-runtime world. The runner's own PATH is never mutated.
  rootA = mkdtemp("subshell-e2e-conn-sshd-a-");
  fixtureA = await startSshFixture(rootA, {
    envPath: `${shimDir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  rootB = mkdtemp("subshell-e2e-conn-sshd-b-");
  fixtureB = await startSshFixture(rootB);

  // The connecting account's config gains the second alias, pointing at the
  // shim-less daemon; its host key joins the same pre-trusted known_hosts
  // (the session render consults the account's default file, spec 22's rule).
  const hostB = readFileSync(path.join(rootB, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  const knownHosts = path.join(fixtureA.sshConfigHome, ".ssh", "known_hosts");
  writeFileSync(knownHosts, `${readFileSync(knownHosts, "utf8")}[127.0.0.1]:${fixtureB.port} ${hostB}\n`, {
    mode: 0o600,
  });
  const configPath = path.join(fixtureA.sshConfigHome, ".ssh", "config");
  writeFileSync(
    configPath,
    `${readFileSync(configPath, "utf8")}Host ${NOBIN_ALIAS}
    HostName 127.0.0.1
    Port ${fixtureB.port}
    User ${fixtureA.user}
    IdentityFile ${fixtureB.trustedKeyPath}
    IdentitiesOnly yes
    IdentityAgent none
    UserKnownHostsFile ${knownHosts}
`,
    { mode: 0o600 },
  );

  // The member: created by the admin, and the node it enrolls is its OWN (the
  // non-admin owner is the exact actor the auth widening is about).
  const created = await admin.post("/api/users", {
    data: { email: MEMBER_EMAIL, name: MEMBER_EMAIL, password: MEMBER_PW, role: "user" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  memberApi = await pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const signInRes = await memberApi.post("/api/auth/sign-in/email", {
    data: { email: MEMBER_EMAIL, password: MEMBER_PW },
  });
  expect(signInRes.ok(), await signInRes.text()).toBe(true);

  const mint = await memberApi.post("/api/nodes/setup-keys");
  expect(mint.ok(), await mint.text()).toBe(true);
  const key = (await mint.json()) as { id: string; key: string };
  setupKeyId = key.id;

  agentHome = mkdtemp("subshell-e2e-conn-node-");
  tmuxBase = shortTmuxBase();
  agent = await startNode({
    home: agentHome,
    dataDir: path.join(agentHome, "data"),
    tmuxBase,
    setupKey: key.key,
    name: NODE_NAME,
    // The fixture account, pinned (the fixture's account-name rule): the daemon's own
    // USER/LOGNAME must agree with what sshd logs, across runtimes.
    extraEnv: { HOME: fixtureA.sshConfigHome, USER: fixtureA.user, LOGNAME: fixtureA.user, SSH_AUTH_SOCK: "" },
  });

  await pollUntil(
    `node "${NODE_NAME}" never came online`,
    async () => {
      const res = await memberApi.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: { id: string; name: string; status: string }[] }).nodes.find(
        (n) => n.name === NODE_NAME,
      );
      if (row) nodeId = row.id;
      return row?.status === "online";
    },
    { tail: agentTail },
  );
});

test.afterAll(async () => {
  const leaks: string[] = [];
  try {
    await agent?.stop();
  } catch (err) {
    leaks.push(`agent stop: ${String(err)}`);
  }
  sweepTmuxServers(tmuxBase);
  sweepTmuxServers(destTmuxBase);
  try {
    await fixtureA?.stop();
  } catch (err) {
    leaks.push(`sshd A stop: ${String(err)}`);
  }
  try {
    await fixtureB?.stop();
  } catch (err) {
    leaks.push(`sshd B stop: ${String(err)}`);
  }
  if (memberApi !== undefined) {
    if (sessionId) await memberApi.post(`/api/ssh-runtime/sessions/${sessionId}/close`).catch(() => undefined);
    if (nodeId) {
      const del = await memberApi.delete(`/api/nodes/${nodeId}?force=true`).catch(() => null);
      if (del !== null && !del.ok() && del.status() !== 404) leaks.push(`node delete: HTTP ${del.status()}`);
    }
    if (setupKeyId) {
      const rev = await memberApi.delete(`/api/nodes/setup-keys/${setupKeyId}`).catch(() => null);
      if (rev !== null && !rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
    }
    await memberApi.dispose();
  }
  await admin?.dispose();
  rmScratch(agentHome);
  rmScratch(rootA);
  rmScratch(rootB);
  rmScratch(scratch);
  rmScratch(path.dirname(tmuxBase));
  if (leaks.length > 0) console.error(`[23-ssh-connect] cleanup problems: ${leaks.join("; ")}`);
});

test("the shared launch journey: discover, review, connect, browse, launch, identity", async ({ page }) => {
  test.setTimeout(240_000);
  const f = sshA();

  await loginMember(page);

  // The flow starts from the RAIL, never a URL.
  await page.locator("aside").getByRole("button", { name: "New subshell", exact: true }).click();
  await page.getByRole("button", { name: "SSH host", exact: true }).click();

  // Machine: only the member's own node is offered.
  await expect(page.getByRole("button", { name: new RegExp(NODE_NAME) })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: new RegExp(NODE_NAME) }).click();

  // Host: the real config on the node, discovered through the RPC.
  await expect(page.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true }).click();

  // Review: the concrete destination and the connecting account, server facts.
  await expect(page.getByText(`127.0.0.1:${f.port}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`as ${f.user}`)).toBeVisible();

  // Connection setup has one primary act; ready hosts need no installation lecture.
  await expect(page.getByRole("button", { name: "Start subshell", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download the Subshell CLI" })).toHaveCount(0);

  // Connect = open the session (the probe is the test).
  const openRespP = page.waitForResponse(
    (r) => r.url().endsWith("/api/ssh-runtime/sessions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const openResp = await openRespP;
  expect(openResp.status(), await openResp.text()).toBe(200);
  const opened = (await openResp.json()) as SessionRow;
  sessionId = opened.id;
  expect(opened.status).toBe("active");

  // Browse: the home listing lands with the absolute path stated.
  await expect(page.getByText("Choose the folder")).toBeVisible();
  const pathLine = page.getByTestId("connect-current-path");
  await expect(pathLine).toHaveText(/Current folder: \//, { timeout: 30_000 });
  const homeShown = (await pathLine.textContent())?.replace("Current folder: ", "").trim() ?? "";
  expect(path.isAbsolute(homeShown), `the picker must show an absolute path, got "${homeShown}"`).toBe(true);

  const savedResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/ssh-runtime/locations") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Remember this host and folder" }).click();
  expect((await savedResponse).ok()).toBe(true);

  // Launch: the terminal seam, and the pane it opens is an ordinary row.
  // The F1 finding lived on this page: the pane's live-terminal socket looped
  // `4004 node offline` and the "reconnecting…" pill stayed up, because the
  // relay had no session-backed liveness for the hidden runtime node. The
  // sockets the page dials are collected here and asserted as network truth
  // below (e2e/AGENTS.md: the pill and the upgrade, never the xterm grid).
  const terminalSockets: { url: string; frames: number; open: boolean }[] = [];
  page.on("websocket", (w) => {
    if (!w.url().includes("/ws?subshell=")) return;
    const entry = { url: w.url(), frames: 0, open: true };
    terminalSockets.push(entry);
    w.on("framereceived", () => {
      entry.frames += 1;
    });
    w.on("close", () => {
      entry.open = false;
    });
  });
  const launchRespP = page.waitForResponse((r) => r.url().endsWith("/launch-harness"));
  await page.locator("#picker-agent").click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const launchButton = page.getByRole("button", { name: "Start subshell", exact: true });
  await expect(launchButton).toBeInViewport();
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(launchButton).toBeInViewport();
  if (originalViewport) await page.setViewportSize(originalViewport);
  await launchButton.click();
  const launchResp = await launchRespP;
  expect(launchResp.status(), await launchResp.text()).toBe(200);
  paneId = ((await launchResp.json()) as { subshellId: string }).subshellId;
  await expect(page).toHaveURL(new RegExp(`/subshells/${paneId}`), { timeout: 30_000 });

  // The trusted identity line (design §7), assembled from server rows.
  await expect(page.getByText(`SSH · 127.0.0.1:${f.port} · via ${NODE_NAME}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await expect(page.locator("aside").getByText(`SSH · ${SSH_FIXTURE_ALIAS}`, { exact: true })).toBeVisible();

  // Server truth behind the chrome: an ordinary running row on the hidden
  // runtime node, in the folder the picker showed. The runtime row never
  // appears in the nodes listing (design §4's concealment), and the by-pane
  // identity read answers what the line claims.
  await pollUntil(
    "the runtime pane never read running on the API",
    async () => {
      const res = await memberApi.get(`/api/subshells/${paneId}`);
      if (!res.ok()) return false;
      const row = (await res.json()) as { status: string; alive: boolean; workingDir: string; nodeId: string };
      return (
        row.status === "running" &&
        row.alive === true &&
        row.workingDir === homeShown &&
        row.nodeId === opened.runtimeNodeId
      );
    },
    { budgetMs: 30_000, tail: agentTail },
  );
  const identity = await memberApi.get(`/api/ssh-runtime/sessions/by-pane/${paneId}`);
  expect(identity.ok(), await identity.text()).toBe(true);
  const line = (await identity.json()) as {
    host: string;
    port: number;
    user: string | null;
    connectingNodeName: string;
  };
  expect(line.host).toBe("127.0.0.1");
  expect(line.port).toBe(f.port);
  expect(line.user, "resolve keeps the connecting default un-named").toBeNull();
  expect(line.connectingNodeName).toBe(NODE_NAME);
  const listed = (await (await memberApi.get("/api/nodes")).json()) as { nodes: { id: string }[] };
  expect(listed.nodes.some((n) => n.id === opened.runtimeNodeId)).toBe(false);

  // F1 (the browser journey the acceptance run found broken): the pane page's
  // live terminal actually ATTACHES a runtime pane. Network truth, not the
  // grid: one /ws socket stays OPEN and keeps RECEIVING frames (pre-fix every
  // attempt closed at 4004 and the pill stayed up), and the "reconnecting…"
  // pill is absent on the settled page.
  await pollUntil(
    "the browser terminal never held an open streaming /ws for the runtime pane",
    async () => terminalSockets.some((s) => s.open && s.frames > 0),
    { budgetMs: 60_000, tail: agentTail },
  );
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: 10_000 });

  // Browser typing reaches the destination pane (pre-fix, keystrokes died in
  // the 4004 loop while REST input worked). The proof is the REST log tail:
  // echoed AND executed, spec 22's two-occurrence rigor.
  const uiMarker = `WALK-UI-${RUN}`;
  await page.locator(".xterm-helper-textarea").click();
  await page.keyboard.type(`echo ${uiMarker}`);
  await page.keyboard.press("Enter");
  await pollUntil(
    "the browser-typed marker never appeared (echoed AND run) in the destination pane's log",
    async () => {
      const res = await memberApi.get(`/api/subshells/${paneId}/log`);
      if (!res.ok()) return false;
      const text = ((await res.json()) as { lines: string[] }).lines.join("\n");
      return text.split(uiMarker).length - 1 >= 2 && text.includes(`echo ${uiMarker}`);
    },
    { budgetMs: 60_000, tail: agentTail },
  );
});

test("workspace pane uses an existing SSH connection without leaving the workspace", async ({ page }) => {
  test.setTimeout(120_000);
  await loginMember(page);
  const created = await memberApi.post("/api/workspaces", { data: { name: `SSH workspace ${RUN}` } });
  expect(created.ok()).toBe(true);
  const workspace = (await created.json()) as { id: string };
  try {
    await page.goto(`/workspaces/${workspace.id}`);
    await page.getByRole("button", { name: "Add a subshell to this workspace" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "New subshell", exact: true }).click();
    await page.getByRole("button", { name: "SSH host", exact: true }).click();
    const opens: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/ssh-runtime/sessions")) opens.push(r.url());
    });
    await page.getByPlaceholder("Choose a saved host and folder").click();
    await page.getByRole("option", { name: new RegExp(SSH_FIXTURE_ALIAS) }).click();
    await expect(page.getByTestId("connect-current-path")).toHaveText(/Current folder: \//);
    await page.locator("#picker-agent").click();
    await page.getByRole("option", { name: "Terminal", exact: true }).click();
    await page.screenshot({ path: "/tmp/subshell-ssh-workspace-launch.png", fullPage: true });
    const response = page.waitForResponse((r) => r.url().endsWith("/launch-harness"));
    await page.getByRole("button", { name: "Start subshell", exact: true }).click();
    const launched = await response;
    expect(launched.ok(), await launched.text()).toBe(true);
    const pane = (await launched.json()) as { subshellId: string };
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.id}$`));
    expect(opens).toEqual([]);
    const state = await memberApi.get(`/api/workspaces/${workspace.id}`);
    expect(JSON.stringify(await state.json())).toContain(pane.subshellId);
    await memberApi.post(`/api/subshells/${pane.subshellId}/terminate`);
  } finally {
    await memberApi.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("sessions view: the row closes from the page, and the history says so", async ({ page }) => {
  test.setTimeout(120_000);
  expect(sessionId, "the journey test owns the session").not.toBe("");

  await loginMember(page);
  await page.locator("aside").getByRole("button", { name: "New subshell", exact: true }).click();
  await page.getByRole("button", { name: "SSH host", exact: true }).click();
  await page.getByRole("link", { name: "Manage SSH connections and reconnect" }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await expect(page.getByText(new RegExp(`127\\.0\\.0\\.1:${sshA().port}`))).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Close" }).first().click();
  // The dialog names the ACT; the body carries the destination's price.
  await expect(page.getByRole("dialog")).toContainText("Close session?");
  const closeRespP = page.waitForResponse(
    (r) => r.url().includes("/api/ssh-runtime/sessions/") && r.url().endsWith("/close"),
  );
  // The dialog carries TWO accessible names "Close": the destructive confirm
  // and the overlay's icon-only ×. The confirm is the one with the WORD; the
  // × is an aria-label over an svg.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .filter({ hasText: "Close" })
    .click();
  const closeResp = await closeRespP;
  expect(closeResp.status(), await closeResp.text()).toBe(200);

  await pollUntil(
    "the session row never settled closed on the API",
    async () => {
      const res = await memberApi.get(`/api/ssh-runtime/sessions/${sessionId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as SessionRow).status === "closed";
    },
    { budgetMs: 30_000, tail: agentTail },
  );
  // The honest history sentence for a closed row (design §6): the panes
  // outlive the session, on the destination's own tmux.
  await expect(page.getByText("Panes launched on it keep running on the destination")).toBeVisible({
    timeout: 30_000,
  });
  // The pane row survives the close as the design promises (running, its
  // channel gone): unavailable, not completed.
  await pollUntil(
    "the closed session's pane never read unavailable-with-status-intact",
    async () => {
      const res = await memberApi.get(`/api/subshells/${paneId}`);
      if (!res.ok()) return false;
      const row = (await res.json()) as { status: string; alive: boolean };
      return row.status === "running" && row.alive === false;
    },
    { budgetMs: 30_000, tail: agentTail },
  );
});

test("missing runtime: the probe's absence renders the binary-install guidance", async ({ page }) => {
  test.setTimeout(120_000);
  const fB = sshB();

  await loginMember(page);
  await page.locator("aside").getByRole("button", { name: "New subshell", exact: true }).click();
  await page.getByRole("button", { name: "SSH host", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(NODE_NAME) }).click();
  await expect(page.getByRole("button", { name: NOBIN_ALIAS, exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: NOBIN_ALIAS, exact: true }).click();
  await expect(page.getByText(`127.0.0.1:${fB.port}`, { exact: true })).toBeVisible({ timeout: 30_000 });

  const openRespP = page.waitForResponse(
    (r) => r.url().endsWith("/api/ssh-runtime/sessions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const refused = await openRespP;
  expect(refused.status(), await refused.text()).toBe(403);
  expect(await refused.text()).toContain("runtime_missing");

  // The UI remedy names the BINARY and nothing else: never enrollment, never
  // `subshell setup`.
  await expect(page.getByText(/Install the Subshell binary on 127\.0\.0\.1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy runtime verification command" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  const list = (await (await memberApi.get("/api/ssh-runtime/sessions")).json()) as { sessions: SessionRow[] };
  expect(list.sessions.some((s) => s.status === "opening")).toBe(false);
});

test("desktop SSH connects without enrollment and restores the same pane in place", async ({ page }) => {
  test.setTimeout(120_000);
  await loginMember(page);
  await page.goto("/settings/connections");
  await page.getByLabel("Computer name").fill(`Laptop ${RUN}`);
  const pairingResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/ssh-runtime/desktop-brokers") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  const pairing = (await (await pairingResponse).json()) as { id: string; pairingToken: string };
  const brokerHome = path.join(scratch, "desktop-broker");
  mkdirSync(brokerHome, { recursive: true });
  const child = spawn(resolveBun(), [NODE_MAIN, "ssh-broker", "--server", BASE_URL], {
    env: {
      ...process.env,
      HOME: sshA().sshConfigHome,
      USER: sshA().user,
      LOGNAME: sshA().user,
      SSH_AUTH_SOCK: "",
      SUBSHELL_CONFIG_HOME: brokerHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(`${JSON.stringify({ pairingToken: pairing.pairingToken })}\n`);
  let desktopPane = "";
  try {
    await expect(page.getByText(`Laptop ${RUN} · online`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator("aside").getByRole("button", { name: "New subshell", exact: true }).click();
    await page.getByRole("button", { name: "SSH host", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`Laptop ${RUN}`) }).click();
    await page.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByTestId("connect-current-path")).toHaveText(/Current folder: \//);
    await page.locator("#picker-agent").click();
    await page.getByRole("option", { name: "Terminal", exact: true }).click();
    const launchResponse = page.waitForResponse((r) => r.url().endsWith("/launch-harness"));
    await page.getByRole("button", { name: "Start subshell", exact: true }).click();
    const launched = await launchResponse;
    expect(launched.ok(), await launched.text()).toBe(true);
    desktopPane = ((await launched.json()) as { subshellId: string }).subshellId;
    await expect(page).toHaveURL(new RegExp(`/subshells/${desktopPane}`));
    await expect(page.getByText(new RegExp(`via Laptop ${RUN}`))).toBeVisible();
    const identity = (await (await memberApi.get(`/api/ssh-runtime/sessions/by-pane/${desktopPane}`)).json()) as {
      sessionId: string;
    };
    const closed = await memberApi.post(`/api/ssh-runtime/sessions/${identity.sessionId}/close`);
    expect(closed.ok()).toBe(true);
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Reconnect to SSH host" })).toBeVisible();
    await page.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Reconnect to SSH host" })).not.toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/subshells/${desktopPane}`));
    await pollUntil("the reconnected desktop pane never became available", async () => {
      const row = (await (await memberApi.get(`/api/subshells/${desktopPane}`)).json()) as {
        alive: boolean;
        status: string;
      };
      return row.alive === true && row.status === "running";
    });
    await expect(page.getByText("Subshell exited", { exact: true })).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: 30_000 });
    const marker = `DESKTOP-RESUMED-${RUN}`;
    await page.locator(".xterm-helper-textarea").click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await pollUntil("typing after desktop reconnect did not reach the remote terminal", async () => {
      const response = await memberApi.get(`/api/subshells/${desktopPane}/log`);
      if (!response.ok()) return false;
      const text = ((await response.json()) as { lines: string[] }).lines.join("\n");
      return text.split(marker).length >= 3;
    });
    await page.screenshot({ path: "/tmp/subshell-ssh-desktop-reconnected.png", fullPage: true });
  } finally {
    if (desktopPane) await memberApi.delete(`/api/subshells/${desktopPane}`);
    await memberApi.delete(`/api/ssh-runtime/desktop-brokers/${encodeURIComponent(pairing.id)}`);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 40_000);
      if (child.exitCode !== null) {
        clearTimeout(timer);
        resolve();
      } else
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
    });
  }
});
