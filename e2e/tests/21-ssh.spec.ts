import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { shortTmuxBase } from "../stack";
import { type RunningNode, startNode } from "../stub/client";
import { ADMIN_STATE, expectSubshellRunning, pollUntil, sleep, sweepTmuxServers } from "./helpers";
import { ensureConnection, type NodeRow, type RunView, rmScratch, SSH_HEADERS, seedAdminApi } from "./ssh-support";

/**
 * SSH feature end to end (SSH-SUPPORT.md §6): a real browser and the real
 * backend driving a REAL node agent dispatching SSH to a REAL sshd on loopback
 * through the REAL `ssh(1)` — the composition unit coverage cannot reach.
 * Terminal truth is server/network truth and chrome text only, never xterm
 * rows (AGENTS.md). All sshd material comes from `fixtures/sshd.ts`; the node
 * runs with `HOME` at the fixture config home so `ssh -G` resolves `e2edest`
 * against fixture bytes. Both home readers (`reportHomeDir` via os.homedir,
 * `connectingHomeDir` via $HOME) follow the env, which the ready-fact check
 * pins. The loud-skip names the missing binaries on hosts without sshd.
 */

const missing = missingSshBins();
test.skip(missing.length > 0, `real-ssh e2e skipped: this host lacks ${missing.join(", ")}`);
test.use({ storageState: ADMIN_STATE });
test.describe.configure({ mode: "serial" });

/** Per-attempt uniqueness: a retry gets a fresh worker (fresh module) and fresh names. */
const RUN = Math.random().toString(36).slice(2, 7);
const NODE_NAME = `e2e-ssh-${RUN}`;

let fixture: SshFixture | undefined;
let agent: RunningNode | undefined;
let agentHome = "";
let tmuxBase = "";
let fixtureRoot = "";
let nodeId = "";
let setupKey = "";
let setupKeyId = "";
let api: APIRequestContext;

/** beforeAll owns the fixture; a hook failure fails the file before any test reads this. */
const ssh = (): SshFixture => {
  if (fixture === undefined) throw new Error("the sshd fixture never started");
  return fixture;
};
/** Polls surface the agent log tail on a stuck fixture (shared helpers.ts; spec 21 always has an agent). */
const agentTail = (): string => agent?.logTail() ?? "(agent never started)";

test.beforeAll(async () => {
  api = await seedAdminApi();

  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-sshd-"));
  fixture = await startSshFixture(fixtureRoot);

  const mint = await api.post("/api/nodes/setup-keys");
  expect(mint.ok(), await mint.text()).toBe(true);
  const key = (await mint.json()) as { id: string; key: string };
  setupKeyId = key.id;
  setupKey = key.key;

  agentHome = mkdtempSync(path.join(tmpdir(), "subshell-e2e-ssh-node-"));
  tmuxBase = shortTmuxBase(); // NOT under agentHome: the sun_path budget (spec 12's reason, unchanged)
  agent = await startNode({
    home: agentHome,
    dataDir: path.join(agentHome, "data"),
    tmuxBase,
    setupKey,
    name: NODE_NAME,
    // HOME is the whole fixture handoff (discovery, ssh -G, runs, the pane's
    // env -i ssh all follow it); USER/LOGNAME pin the daemon's
    // `connectingAccount` to the fixture account NAME (bun's userInfo reads
    // the env, node's reads passwd - without this the bun-run daemon answers
    // "unknown" in a bare container and the snapshot's user-vs-default
    // comparison drifts); SSH_AUTH_SOCK is blanked so an ambient agent
    // cannot leak into a snapshot's auth-agent reference.
    extraEnv: { HOME: fixture.sshConfigHome, USER: fixture.user, LOGNAME: fixture.user, SSH_AUTH_SOCK: "" },
  });

  await pollUntil(
    `node "${NODE_NAME}" never came online`,
    async () => {
      const res = await api.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.name === NODE_NAME);
      if (row) nodeId = row.id;
      return row?.status === "online";
    },
    { tail: agentTail },
  );

  // The ready-reported home must be the fixture home (`GET /api/files/recent`
  // answers the live registry's agent homeDir) — the proof os.homedir followed
  // the env HOME into the daemon.
  await pollUntil(
    "the ready-reported homeDir never became the fixture home",
    async () => {
      const res = await api.get("/api/files/recent", { params: { node: nodeId } });
      if (!res.ok()) return false;
      return ((await res.json()) as { home: string | null }).home === fixture?.sshConfigHome;
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
  try {
    await fixture?.stop();
  } catch (err) {
    leaks.push(`sshd stop: ${String(err)}`);
  }
  if (api !== undefined) {
    // This spec's connections only (display names carry the RUN stamp); a
    // still-active-work refusal would leave the row for the DB wipe.
    try {
      const list = await api.get("/api/ssh/connections");
      if (list.ok()) {
        for (const c of ((await list.json()) as { connections: { id: string; displayName: string }[] }).connections) {
          if (!c.displayName.includes(RUN)) continue;
          const del = await api.delete(`/api/ssh/connections/${c.id}`, { headers: SSH_HEADERS });
          if (!del.ok() && del.status() !== 404) leaks.push(`connection ${c.id}: HTTP ${del.status()}`);
        }
      }
    } catch (err) {
      leaks.push(`connection cleanup: ${String(err)}`);
    }
    if (nodeId) {
      for (let i = 0; i < 10; i++) {
        try {
          const del = await api.delete(`/api/nodes/${nodeId}?force=true`);
          if (del.ok() || del.status() === 404) break;
          if (i === 9) leaks.push(`node delete: HTTP ${del.status()}`);
        } catch (err) {
          leaks.push(`node delete: ${String(err)}`);
          break;
        }
        await sleep(500);
      }
    }
    if (setupKeyId) {
      const rev = await api.delete(`/api/nodes/setup-keys/${setupKeyId}`);
      if (!rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
    }
    await api.dispose();
  }
  // Guard against removing anything but an absolute scratch path: if beforeAll
  // failed before a var was set it is still "", and path.dirname("") is "." —
  // an unguarded rmSync(".") deletes the whole e2e working tree (the worker CWD).
  rmScratch(agentHome);
  rmScratch(fixtureRoot);
  rmScratch(path.dirname(tmuxBase));
  if (leaks.length > 0) console.error(`[21-ssh] cleanup problems: ${leaks.join("; ")}`);
});

test("connection setup: the browser discovers the alias, resolves it on the real node, and saves it", async ({
  page,
}) => {
  const f = ssh();
  const displayName = `E2E Dest ${RUN}`;
  await page.goto("/settings/ssh");
  await expect(page.getByRole("heading", { name: "SSH connections" })).toBeVisible();

  await page.getByRole("button", { name: "New connection" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New SSH connection" })).toBeVisible();

  // The connecting node is the REAL enrolled agent; discovery/resolve run on it.
  await dialog.locator("#ssh-node").click();
  await page.getByRole("option", { name: NODE_NAME, exact: true }).click();

  // Discovery answers NAMES from the agent's bounded config parse; the fixture
  // chip can only exist if the fixture HOME's config was read.
  const chip = dialog.getByRole("button", { name: SSH_FIXTURE_ALIAS, exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();

  // Resolution is the real `ssh -G`: the review card shows the RESOLVED route
  // (host and ephemeral port), never the raw alias, and names the account.
  await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
  const review = dialog.getByLabel("Resolved destination");
  await expect(review.getByText(`127.0.0.1:${f.port}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(review).toContainText(`Alias ${SSH_FIXTURE_ALIAS} · connecting account ${f.user}`);

  // "Configuration is executable": F's disclosure rides the review, and Save
  // stays inert until the human names the connection.
  await expect(
    dialog.getByText(
      "Resolution reads the account's config on the connecting node. Trusted local config such as a Match exec block can run programs there.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save connection" })).toBeDisabled();

  // The probe is the fixed benign command against the live fixture sshd.
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByText("Passed", { exact: true })).toBeVisible({ timeout: 30_000 });

  await dialog.locator("#ssh-name").fill(displayName);
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The list carries the route line: destination AND the machine the ssh runs from.
  const card = page.locator("div.rounded-lg", { hasText: displayName });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(`127.0.0.1:${f.port} · via ${NODE_NAME}`, { exact: true })).toBeVisible();
});

test("structured run: echo 6x7 through the real node executes on sshd; the dead-port 255 answers honestly", async () => {
  const f = ssh();
  const connId = await ensureConnection(api, nodeId, `E2E Run ${RUN}`);
  const start = await api.post("/api/ssh/runs", {
    data: { connectionId: connId, command: "echo ssh-e2e-$((6*7))" },
    headers: SSH_HEADERS,
  });
  expect(start.ok(), await start.text()).toBe(true);
  const run = (await start.json()) as { id: string };

  let out: { run: RunView; stdout: string } | undefined;
  await pollUntil(
    "the echo run never reached a terminal state",
    async () => {
      const res = await api.get(`/api/ssh/runs/${run.id}/output`);
      if (!res.ok()) return false; // transient non-OK retries inside the budget, like the dead arm
      out = (await res.json()) as { run: RunView; stdout: string };
      return out.run.status === "completed" || out.run.status === "unknown";
    },
    { budgetMs: 60_000, tail: agentTail },
  );
  expect(out?.run.status).toBe("completed");
  expect(out?.run.remoteStatus).toBe(0);
  expect(out?.run.remoteStatusConfirmed, "a status in [0,254] proves an established transport").toBe(true);
  expect(out?.run.localExitCode).toBe(0);
  expect(out?.stdout).toContain("ssh-e2e-42");

  // Exit-255 honesty, the SHIPPED spelling (ssh-run-supervisor `#finalize`):
  // a refused connection corroborates `sshTransportFailure`, so the run lands
  // `completed` with NO remote status and the 255 kept as the LOCAL ssh fact.
  const deadConnId = await ensureConnection(api, nodeId, `E2E Dead ${RUN}`, f.deadPort);
  const deadStart = await api.post("/api/ssh/runs", {
    data: { connectionId: deadConnId, command: "echo never-ran" },
    headers: SSH_HEADERS,
  });
  expect(deadStart.ok(), await deadStart.text()).toBe(true);
  const deadRun = (await deadStart.json()) as { id: string };
  let dead: { run: RunView; stdout: string } | undefined;
  await pollUntil(
    "the dead-port run never reached a terminal state",
    async () => {
      const res = await api.get(`/api/ssh/runs/${deadRun.id}/output`);
      if (!res.ok()) return false;
      dead = (await res.json()) as { run: RunView; stdout: string };
      return dead.run.status === "completed" || dead.run.status === "unknown";
    },
    { budgetMs: 60_000, tail: agentTail },
  );
  expect(dead?.run.status).toBe("completed");
  expect(dead?.run.remoteStatus).toBeNull();
  expect(dead?.run.remoteStatusConfirmed).toBe(false);
  expect(dead?.run.localExitCode).toBe(255);
  expect(dead?.stdout).not.toContain("never-ran");

  const del = await api.delete(`/api/ssh/connections/${deadConnId}`, { headers: SSH_HEADERS });
  expect(del.ok(), await del.text()).toBe(true);
});

test("managed terminal: opens from the card with the trusted chrome, and control flips both ways by REST", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const f = ssh();
  await ensureConnection(api, nodeId, `E2E Term ${RUN}`);
  await page.goto("/settings/ssh");
  const card = page.locator("div.rounded-lg", { hasText: `E2E Term ${RUN}` });
  await expect(card).toHaveCount(1);
  // Wait until the nodes read has resolved the connecting node's NAME: the
  // managed-terminal facts are captured at open time from the card's label,
  // which is the short node id until that read lands.
  await expect(card.getByText(`127.0.0.1:${f.port} · via ${NODE_NAME}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await card.getByRole("button", { name: "Open terminal" }).click();
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: 30_000 });
  const subshellId = new URL(page.url()).pathname.split("/").pop() as string;

  // The session is genuinely established: the fixture daemon's OWN log carries
  // the accepted key (server truth, not a line of xterm).
  await pollUntil(
    "sshd never accepted the managed terminal's key",
    async () => {
      try {
        return new RegExp(`Accepted publickey for ${f.user} from 127\\.0\\.0\\.1`).test(
          readFileSync(f.logPath, "utf8"),
        );
      } catch {
        return false;
      }
    },
    { budgetMs: 30_000, tail: agentTail },
  );

  // The trusted identity line (spec §3), assembled from open-time facts; the
  // dots are in the component, per ssh-pane-chrome's source.
  await expect(page.getByText(`SSH · 127.0.0.1:${f.port} · via ${NODE_NAME}`, { exact: true })).toBeVisible();

  // A HUMAN-opened pane starts in HUMAN control (spec §3), so the offered flip
  // first is "Return to agent" and "Take over" follows as its mirror. Each
  // transition is asserted by the POST's REST answer, never by terminal text.
  await expect(page.getByText("You have input", { exact: true })).toBeVisible();
  const returnedP = page.waitForResponse((r) => r.url().includes("/ssh-control") && r.status() === 200);
  await page.getByRole("button", { name: "Return to agent" }).click();
  const returned = (await (await returnedP).json()) as { controlOwner: string; controlGeneration: number };
  expect(returned.controlOwner).toBe("agent");
  await expect(page.getByText("Agent has input", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible();
  const tookP = page.waitForResponse((r) => r.url().includes("/ssh-control") && r.status() === 200);
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  const took = (await (await tookP).json()) as { controlOwner: string; controlGeneration: number };
  expect(took.controlOwner).toBe("human");
  expect(took.controlGeneration, "every transition raises the fence generation").toBeGreaterThan(
    returned.controlGeneration,
  );
  await expect(page.getByText("You have input", { exact: true })).toBeVisible();

  // Still a LIVE session after both flips: the dot is the running+alive pair.
  await expectSubshellRunning(page, 30_000);

  const kill = await api.post(`/api/subshells/${subshellId}/terminate`, { headers: SSH_HEADERS });
  expect(kill.ok(), await kill.text()).toBe(true);
});

test("invariants: uploads name UPLOAD_SSH_UNSUPPORTED; delete refuses active_work until the pane dies", async () => {
  const connId = await ensureConnection(api, nodeId, `E2E Inv ${RUN}`);
  const term = await api.post("/api/ssh/terminals", { data: { connectionId: connId }, headers: SSH_HEADERS });
  expect(term.ok(), await term.text()).toBe(true);
  const pane = (await term.json()) as { subshellId: string; initiatedBy: string };
  expect(pane.initiatedBy).toBe("human");

  // Uploads name their refusal before a byte moves (§3; the server's ssh_panes
  // marker is the boundary, the client gate is only tab memory).
  const up = await api.post(`/api/subshells/${pane.subshellId}/uploads`, {
    headers: SSH_HEADERS,
    multipart: { file: { name: "nope.txt", mimeType: "text/plain", buffer: Buffer.from("must not land") } },
  });
  expect(up.status()).toBe(400);
  expect(((await up.json()) as { code: string }).code).toBe("UPLOAD_SSH_UNSUPPORTED");

  // A pane row that is running blocks its connection's delete — even parked
  // (open, attached to nobody, idle). Once the pane dies, the delete passes.
  const parked = (await (await api.get("/api/subshells")).json()) as { id: string; status: string }[];
  expect(parked.find((s) => s.id === pane.subshellId)?.status).toBe("running");
  await sleep(1_000);
  const del1 = await api.delete(`/api/ssh/connections/${connId}`, { headers: SSH_HEADERS });
  expect(del1.status()).toBe(403);
  expect(await del1.text(), "C2's active-work gate answers with the named code").toContain("active_work");

  const kill = await api.post(`/api/subshells/${pane.subshellId}/terminate`, { headers: SSH_HEADERS });
  expect(kill.ok(), await kill.text()).toBe(true);
  await pollUntil(
    "the terminated pane never left the running set",
    async () => {
      const res = await api.get("/api/subshells");
      if (!res.ok()) return false;
      const found = ((await res.json()) as { id: string; status: string }[]).find((s) => s.id === pane.subshellId);
      return found?.status !== "running";
    },
    { budgetMs: 30_000, tail: agentTail },
  );
  const del2 = await api.delete(`/api/ssh/connections/${connId}`, { headers: SSH_HEADERS });
  expect(del2.ok(), await del2.text()).toBe(true);
  expect(((await del2.json()) as { deleted: boolean }).deleted).toBe(true);
});

test("protocol 16 reality: the online node registered its SSH support on the exact-match handshake", async () => {
  const res = await api.get("/api/nodes");
  expect(res.ok(), await res.text()).toBe(true);
  const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
  // The SSH surface has no capability negotiation and no v15 fallback: the ws
  // handler refuses any agent whose `ready` protocol is not exactly
  // NODE_PROTOCOL_VERSION, and a refused agent is HELD — offline to every
  // `ssh_*` command. An online row at exactly 16 IS the registration (the
  // capabilities list is a pre-SSH fact, not an SSH claim); tests 1-4 above
  // are its functional half, against the real daemon.
  expect(row?.status).toBe("online");
  expect(row?.protocolVersion).toBe(NODE_PROTOCOL_VERSION);
});
