import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import {
  buildSshConfigPath,
  renderSshConfigContents,
  sshDestinationToken,
  sshOptionTokens,
} from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { getHeld, holdConnection, releaseHeld, resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, SCRIPTED_DATA_DIR, statDirEcho } from "@/test-helpers/scripted-node.js";

/**
 * The `/api/ssh` surface (spec 2026-10-07 §4.3/§5/§7) — the gate doctrine, the
 * refusal shapes, and the compose the launch answers with.
 *
 * The properties this matrix exists to pin, each by its own case:
 * - **Gate order**: the plane's row + `nodeCanSsh` answer lands BEFORE any
 *   `sendCommand`; a held agent is refused before the resolve round trip;
 *   discovery, resolve and launch all sit behind the same gate.
 * - **Refusal placement**: `POST /resolve` answers a refusal outcome IN THE
 *   DATA (200, tier-1 grammar); `POST /launch` and `PUT /saved-hosts` refuse a
 *   refusal-shaped outcome with 422 carrying `{outcome}`.
 * - **Compose**: the launch frame carries the config at the NODE's derived
 *   path, the rendered bytes, and the option tail `-F … -- host`; the row
 *   carries the approved snapshot; `SSH_AUTH_SOCK` rides only when the
 *   snapshot names a socket.
 * - **Saved hosts**: lists never carry another owner's rows; a foreign delete
 *   is the same 404 as an absent one; preferences store the id and the read
 *   tolerates the node vanishing.
 * - **Audit**: `ssh.launch` lands on SUCCESS only, with `{nodeId, destination,
 *   subshellId}` and nothing else; saved-host CRUD audits nothing (prompts precedent).
 *
 * The agent answers come from the scripted node (the real `sendCommand` chain,
 * the real frame parser) — the `ssh`/`resolve` frames this surface emits are
 * what the shipped agent would switch on.
 */

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);

const pw = "ssh-api-1";
const ownerEmail = `ssha-owner-${crypto.randomUUID()}@subshell.local`;
const editorEmail = `ssha-editor-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `ssha-other-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `ssha-admin-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let editorId: string;
let ownerCookie: string;
let editorCookie: string;
let otherCookie: string;
let adminCookie: string;

/** The agent node this file's launch cases run on (SSH row switched ON). */
const NODE_ON = `n-ssh-on-${crypto.randomUUID()}`;
/** Same machine with the SSH row OFF — the gate's negative fixture. */
const NODE_OFF = `n-ssh-off-${crypto.randomUUID()}`;

const nodes = new NodesRepository(db);

/** An approved snapshot in its wire spelling (the shape `parseSshConnectionSnapshot` rebuilds). */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "work",
    host: "example.test",
    user: null,
    port: 22,
    identityFiles: [],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: [],
    hostKeyAlias: null,
    proxyJumps: [],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
    ...over,
  };
}
const CANON = "example.test:22";
const ACCEPTED = snapshot();
const REFUSED = { accepted: false, code: "unsupported_setting", settings: ["ProxyCommand"] };

function sshFetch(path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.cookie) headers.cookie = `better-auth.session_token=${init.cookie}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return app.fetch(
    new Request(`http://localhost:3099${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

const aliases = (node: string, cookie: string) => sshFetch(`/api/ssh/aliases?node=${node}`, { cookie });
const resolve = (node: string, alias: string, cookie: string) =>
  sshFetch("/api/ssh/resolve", { method: "POST", body: { node, alias }, cookie });
const launch = (body: Record<string, unknown>, cookie: string) =>
  sshFetch("/api/ssh/launch", { method: "POST", body, cookie });

async function auditRows(): Promise<
  { id: string; targetId: string | null; metadata: Record<string, unknown> | null }[]
> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["id", "targetId", "metadataJson"])
    .where("action", "=", "ssh.launch")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    targetId: r.targetId,
    metadata: r.metadataJson ? JSON.parse(r.metadataJson) : null,
  }));
}

async function mkNode(id: string, sshEnabled: boolean, owner = ownerId): Promise<NodeTable> {
  await nodes.create({ id, ownerUserId: owner, name: `sshapi-${id.slice(0, 20)}`, kind: "agent", status: "offline" });
  if (sshEnabled) await nodes.setSshEnabled(id, { on: true, changedAt: "2026-10-07T09:00:00.000Z" });
  // A fresh detection that found the ssh binary — the launch's per-node
  // usability gate reads it exactly as the picker does (spec §6.2).
  await db
    .updateTable("nodes")
    .set({
      inventoryJson: JSON.stringify([{ harnessId: "ssh", installed: true, binaryPath: "/usr/bin/ssh", version: "1" }]),
      inventoryAt: new Date().toISOString(),
    } as never)
    .where("id", "=", id)
    .execute();
  return (await nodes.findById(id)) as NodeTable;
}

/** The scripted node every gate-order case observes from the outside. */
function silentScript(nodeId: string) {
  return attachScriptedNode(nodeId, {
    ssh_discover_aliases: () => ({ aliases: ["work"], includeCycle: false, truncated: false }),
    ssh_resolve_config: (cmd) =>
      cmd.type === "ssh_resolve_config" && cmd.alias === "work" ? { accepted: true, snapshot: ACCEPTED } : REFUSED,
    launch: ok,
    stat_dir: statDirEcho,
  });
}

const createdSubshellIds: string[] = [];
const createdNodeIds: string[] = [];
const emails: string[] = [];

beforeAll(async () => {
  await setupAuthTables();
  const mk = async (email: string, role: "user" | "admin") =>
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  ownerId = await mk(ownerEmail, "user");
  editorId = await mk(editorEmail, "user");
  await mk(otherEmail, "user");
  await mk(adminEmail, "admin");
  emails.push(ownerEmail, editorEmail, otherEmail, adminEmail);
  ownerCookie = await signIn(ownerEmail, pw);
  editorCookie = await signIn(editorEmail, pw);
  otherCookie = await signIn(otherEmail, pw);
  adminCookie = await signIn(adminEmail, pw);
  await ensureLocalNode(db);
  await mkNode(NODE_ON, true);
  await mkNode(NODE_OFF, false);
  await new NodeSharesRepository(db).replaceForNode(
    NODE_ON,
    [{ granteeUserId: editorId, permission: "edit" }],
    ownerId,
  );
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of createdSubshellIds) await new SubshellsRepository(db).delete(id).catch(() => {});
  await db.deleteFrom("sshSavedHosts").execute();
  for (const id of createdNodeIds.concat(NODE_ON, NODE_OFF)) await nodes.deleteById(id).catch(() => {});
  await db
    .updateTable("nodes")
    .set({ sshEnabled: 0, sshEnabledAt: null } as never)
    .where("id", "=", LOCAL_NODE_ID)
    .execute();
  await db.deleteFrom("settings").where("key", "like", "ssh.defaultNode:%").execute();
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

describe("/api/ssh gate order (row + nodeCanSsh BEFORE any sendCommand)", () => {
  it("a node whose row is OFF never receives a command: aliases, resolve and launch all 403 ssh_gate_off", async () => {
    const scripted = silentScript(NODE_OFF);
    try {
      for (const res of [
        await aliases(NODE_OFF, ownerCookie),
        await resolve(NODE_OFF, "work", ownerCookie),
        await launch({ node: NODE_OFF, destination: "work" }, ownerCookie),
      ]) {
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GATE_OFF);
      }
      // The load-bearing assertion: the gate answered before the machine was
      // asked. A sendCommand anywhere in the path would have put a frame here.
      expect(scripted.cmdTypes()).toEqual([]);
    } finally {
      scripted.detach();
    }
  });

  it("a held agent is refused with the update remedy before any resolve; even ahead of destination validation", async () => {
    const scripted = silentScript(NODE_ON);
    const held = holdConnection(NODE_ON, scripted.conn, {
      reason: "protocol-mismatch",
      agentVersion: "0.0.1",
      protocolVersion: 12,
      os: "linux",
      arch: "x64",
      onIdle: () => {},
    });
    try {
      const res = await aliases(NODE_ON, ownerCookie);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.NODE_PROTOCOL_HELD);
      expect(body.message.toLowerCase()).toContain("update");
      // Held BEFORE the destination check: an unsafe token still answers 409.
      expect((await launch({ node: NODE_ON, destination: "-oProxyCommand=x" }, ownerCookie)).status).toBe(409);
      expect(scripted.cmdTypes()).toEqual([]);
    } finally {
      if (getHeld(NODE_ON)) releaseHeld(NODE_ON, held.conn);
      scripted.detach();
    }
  });

  it("the machine's owner acts; an edit grantee is 403 (visible, not theirs), a stranger is 404 (never a leak)", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      // Row ON, but SSH USE is owner-only: the grantee sees the node (it is on
      // their screen) and is refused, not hidden.
      expect((await aliases(NODE_ON, editorCookie)).status).toBe(403);
      expect((await resolve(NODE_ON, "work", editorCookie)).status).toBe(403);
      // The admin boost is instance-wide EDIT, never ownership — SSH use stays
      // with the machine's owner (spec §4.3: broker an OS account's keys).
      expect((await aliases(NODE_ON, adminCookie)).status).toBe(403);
      expect((await aliases(NODE_ON, otherCookie)).status).toBe(404);
      expect((await launch({ node: NODE_ON, destination: "work" }, otherCookie)).status).toBe(404);
      // An unknown id answers the same 404 a foreign one did (no existence oracle).
      expect((await aliases(`n-never-${crypto.randomUUID()}`, ownerCookie)).status).toBe(404);
    } finally {
      scripted.detach();
    }
  });

  it("bearer credentials are refused at the door: this surface is browser sessions only", async () => {
    // A real subshell token (its own row, its owner's key) — the actor kind is
    // refused regardless of the owner it resolves to.
    const subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: ownerId,
      harnessId: "terminal",
      name: "bearer-probe",
      workingDir: tmpdir(),
      tmuxSocket: null,
      nodeId: LOCAL_NODE_ID,
    });
    createdSubshellIds.push(subshellId);
    const key = await issueSubshellToken(subshellId, ownerId);
    // An empty cookie is just a failed authentication (401), before any actor kind exists.
    expect((await sshFetch(`/api/ssh/aliases?node=${NODE_ON}`, { cookie: "" })).status).toBe(401);
    const res = await sshFetch(`/api/ssh/aliases?node=${NODE_ON}`, { bearer: key });
    expect(res.status).toBe(403);
  });
});

describe("/api/ssh/resolve (refusal rides IN THE DATA)", () => {
  it("an accepted alias returns the full outcome, and the machine got exactly one resolve frame", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      const res = await resolve(NODE_ON, "work", ownerCookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accepted: boolean; snapshot?: { host: string } };
      expect(body.accepted).toBe(true);
      expect(body.snapshot?.host).toBe("example.test");
      expect(scripted.cmdsOf("ssh_resolve_config").map((c) => c.alias)).toEqual(["work"]);
    } finally {
      scripted.detach();
    }
  });

  it("a refused resolution is a 200 carrying the refusal (settings named), never an error status", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      const res = await resolve(NODE_ON, "proxy-box", ownerCookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accepted: boolean; code: string; settings: string[] };
      expect(body.accepted).toBe(false);
      expect(body.code).toBe("unsupported_setting");
      expect(body.settings).toEqual(["ProxyCommand"]);
    } finally {
      scripted.detach();
    }
  });

  it("an unsafe destination is 400 alias_unsafe and never reaches the machine", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      for (const alias of ["-x", "-oProxyCommand=evil", "has space", "escape"]) {
        const res = await resolve(NODE_ON, alias, ownerCookie);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.ALIAS_UNSAFE);
      }
      expect(scripted.cmdTypes()).toEqual([]);
    } finally {
      scripted.detach();
    }
  });

  it("an offline agent answers 409 NODE_OFFLINE, a machine-level refusal answers 502 SSH_NODE_REFUSED", async () => {
    // No socket at all: the row says ON, the machine is not there.
    const resOffline = await resolve(NODE_ON, "work", ownerCookie);
    expect(resOffline.status).toBe(409);
    expect(((await resOffline.json()) as { code: string }).code).toBe(BackendErrorCodes.NODE_OFFLINE);
    // Attached but answering `ok:false` (no ssh binary / gate mirror says no):
    // the machine's own refusal maps to the 502 family, verbatim text NOT echoed.
    const scripted = attachScriptedNode(NODE_ON, {
      ssh_resolve_config: () => new Error("ssh binary missing: ssh"),
    });
    try {
      const res = await resolve(NODE_ON, "work", ownerCookie);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.SSH_NODE_REFUSED);
      expect(body.message).not.toContain("ssh binary missing");
    } finally {
      scripted.detach();
    }
  });
});

describe("POST /api/ssh/launch", () => {
  it("refuses a refusal-shaped outcome with 422 carrying {outcome}, and launches nothing", async () => {
    const scripted = silentScript(NODE_ON);
    const rowsBefore = (await db.selectFrom("subshells").select("id").execute()).length;
    try {
      const res = await launch({ node: NODE_ON, destination: "proxy-box" }, ownerCookie);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { outcome: { accepted: boolean; code: string; settings: string[] } };
      expect(body.outcome.accepted).toBe(false);
      expect(body.outcome.code).toBe("unsupported_setting");
      expect(body.outcome.settings).toEqual(["ProxyCommand"]);
      // Nothing was written: no row, no audit, no recency touch.
      expect((await db.selectFrom("subshells").select("id").execute()).length).toBe(rowsBefore);
      expect(scripted.countOf("launch")).toBe(0);
      expect(await auditRows()).toHaveLength(0);
    } finally {
      scripted.detach();
    }
  });

  it("an unsafe destination is 400 alias_unsafe before any resolve frame", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      const res = await launch({ node: NODE_ON, destination: "-x" }, ownerCookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.ALIAS_UNSAFE);
      expect(scripted.cmdTypes()).toEqual([]);
    } finally {
      scripted.detach();
    }
  });

  it("launches the ssh pane: the frame carries the config at the NODE's derived path, the option tail, the agent socket env; the row keeps the snapshot", async () => {
    const snap = snapshot({ authAgentSocket: "/run/user/501/ssh-agent.sock" });
    const scripted = attachScriptedNode(NODE_ON, {
      ssh_resolve_config: () => ({ accepted: true, snapshot: snap }),
      launch: ok,
      stat_dir: statDirEcho,
    });
    const beforeIds = new Set((await auditRows()).map((r) => r.id));
    try {
      const res = await launch({ node: NODE_ON, destination: "work", name: "desk" }, ownerCookie);
      expect(res.status).toBe(201);
      const { subshell } = (await res.json()) as { subshell: Record<string, unknown> };
      createdSubshellIds.push(subshell.id as string);
      expect(subshell.harnessId).toBe("ssh");
      expect(subshell.name).toBe("desk");
      expect(subshell.nodeOffline).toBe(false);

      const parsed = snap; // what the agent answered is what the row must hold
      const row = await new SubshellsRepository(db).findById(subshell.id as string);
      expect(row).toBeDefined();
      expect(JSON.parse(String(row?.ssh))).toEqual(parsed); // the snapshot column IS the kind fact
      expect(row?.presetId).toBeNull();
      expect(row?.nodeId).toBe(NODE_ON);
      expect(row?.restartOnExit).toBe(0); // auto-restart is forced off for ssh panes (decision 7)

      const cmd = scripted.cmdsOf("launch")[0] as Record<string, unknown> & {
        ssh?: { configPath: string; fileContent: string };
        argv?: string[];
        subshellEnv?: Record<string, string>;
        preset?: { flags?: string[] };
      };
      expect(cmd.ssh?.configPath).toBe(buildSshConfigPath(SCRIPTED_DATA_DIR, subshell.id as string)); // the node's dataDir, not the server's
      expect(cmd.ssh?.fileContent).toBe(renderSshConfigContents(parsed as never));
      // Handoff 4's tail: every option token, then `--`, then the bare host.
      const configPath = buildSshConfigPath(SCRIPTED_DATA_DIR, subshell.id as string);
      expect(cmd.argv?.slice(1)).toEqual([
        ...sshOptionTokens(parsed as never, configPath),
        "--",
        sshDestinationToken(parsed as never),
      ]);
      expect(cmd.preset?.flags?.[0]).toBe("-F");
      // Decision 3: the snapshot's agent socket rides the pane env ONLY when named.
      expect(cmd.subshellEnv?.SSH_AUTH_SOCK).toBe("/run/user/501/ssh-agent.sock");
    } finally {
      scripted.detach();
    }
    // Audit: success lands exactly one ssh.launch row with the three named facts.
    const added = (await auditRows()).filter((r) => !beforeIds.has(r.id));
    expect(added).toHaveLength(1);
    expect(added[0].targetId).toBe(NODE_ON);
    expect(added[0].metadata).toEqual({ nodeId: NODE_ON, destination: CANON, subshellId: createdSubshellIds.at(-1) });
  });

  it("a snapshot naming no agent socket leaves SSH_AUTH_SOCK out of the pane env", async () => {
    const scripted = attachScriptedNode(NODE_ON, {
      ssh_resolve_config: () => ({ accepted: true, snapshot: ACCEPTED }),
      launch: ok,
      stat_dir: statDirEcho,
    });
    try {
      const res = await launch({ node: NODE_ON, destination: "work" }, ownerCookie);
      expect(res.status).toBe(201);
      const { subshell } = (await res.json()) as { subshell: { id: string } };
      createdSubshellIds.push(subshell.id);
      const cmd = scripted.cmdsOf("launch")[0] as { subshellEnv?: Record<string, string> };
      expect(cmd.subshellEnv?.SSH_AUTH_SOCK).toBeUndefined();
    } finally {
      scripted.detach();
    }
  });

  it("a successful launch records the recency row (saved_at stays null until the human saves)", async () => {
    const scripted = attachScriptedNode(NODE_ON, {
      ssh_resolve_config: () => ({ accepted: true, snapshot: ACCEPTED }),
      launch: ok,
      stat_dir: statDirEcho,
    });
    try {
      const res = await launch({ node: NODE_ON, destination: "work" }, ownerCookie);
      expect(res.status).toBe(201);
      await res.json();
      const rows = await db
        .selectFrom("sshSavedHosts")
        .selectAll()
        .where("destination", "=", CANON)
        .where("ownerUserId", "=", ownerId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].savedAt).toBeNull();
      expect(rows[0].alias).toBe("work");
      expect(rows[0].nodeId).toBe(NODE_ON);
    } finally {
      scripted.detach();
    }
  });
});

describe("/api/ssh/saved-hosts", () => {
  it("PUT resolves then upsert-marks-saved, and audits NOTHING (prompts precedent)", async () => {
    const scripted = silentScript(NODE_ON);
    const before = await db.selectFrom("auditEvents").select("id").execute();
    try {
      const res = await sshFetch("/api/ssh/saved-hosts", {
        method: "PUT",
        body: { node: NODE_ON, destination: "work" },
        cookie: ownerCookie,
      });
      expect(res.status).toBe(200);
      const row = (await res.json()) as { destination: string; savedAt: string | null; alias: string | null };
      expect(row.destination).toBe(CANON);
      expect(row.savedAt).not.toBeNull();
      expect(row.alias).toBe("work");
    } finally {
      scripted.detach();
    }
    const after = await db.selectFrom("auditEvents").select("id").execute();
    expect(after.length).toBe(before.length); // saved-host CRUD records nothing, ever
  });

  it("PUT refuses a refusal-shaped outcome with 422 {outcome} and writes no row", async () => {
    const scripted = silentScript(NODE_ON);
    try {
      const res = await sshFetch("/api/ssh/saved-hosts", {
        method: "PUT",
        body: { node: NODE_ON, destination: "proxy-box" },
        cookie: ownerCookie,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { outcome: { code: string } };
      expect(body.outcome.code).toBe("unsupported_setting");
      const rows = await db.selectFrom("sshSavedHosts").selectAll().where("ownerUserId", "=", ownerId).execute();
      expect(rows.find((r) => r.destination === "proxy-box")).toBeUndefined();
    } finally {
      scripted.detach();
    }
  });

  it("GET lists the caller's own saved and recent rows only — never another owner's", async () => {
    // Owner A saves; owner B (a second human with their own node) must see
    // none of A's rows, and vice versa.
    await db
      .insertInto("sshSavedHosts")
      .values({
        id: crypto.randomUUID(),
        ownerUserId: ownerId,
        destination: "a-private.test:22",
        alias: "mine",
        nodeId: NODE_ON,
        savedAt: "2026-10-07T10:00:00.000Z",
        lastConnectAt: "2026-10-07T10:00:00.000Z",
      } as never)
      .execute();
    const resA = await sshFetch("/api/ssh/saved-hosts", { cookie: ownerCookie });
    expect(resA.status).toBe(200);
    const viewA = (await resA.json()) as {
      saved: { destination: string }[];
      recent: unknown[];
      defaultNodeId: string | null;
    };
    expect(viewA.saved.map((r) => r.destination)).toContain("a-private.test:22");

    const resB = await sshFetch("/api/ssh/saved-hosts", { cookie: editorCookie });
    const viewB = (await resB.json()) as { saved: { destination: string }[]; recent: unknown[] };
    expect(viewB.saved.map((r) => r.destination)).not.toContain("a-private.test:22");
    expect(viewB.recent).toEqual([]);
  });

  it("DELETE removes the owner's row (204) and a foreign id answers the same 404 as an absent one", async () => {
    const row = await db
      .insertInto("sshSavedHosts")
      .values({
        id: crypto.randomUUID(),
        ownerUserId: ownerId,
        destination: "to-delete.test:22",
        alias: null,
        nodeId: NODE_ON,
        savedAt: "2026-10-07T10:00:00.000Z",
        lastConnectAt: "2026-10-07T10:00:00.000Z",
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    const foreign = await sshFetch(`/api/ssh/saved-hosts/${row.id}`, { method: "DELETE", cookie: editorCookie });
    expect(foreign.status).toBe(404); // refused like an absent row — the id is no oracle
    const own = await sshFetch(`/api/ssh/saved-hosts/${row.id}`, { method: "DELETE", cookie: ownerCookie });
    expect(own.status).toBe(204);
    const again = await sshFetch(`/api/ssh/saved-hosts/${row.id}`, { method: "DELETE", cookie: ownerCookie });
    expect(again.status).toBe(404);
  });
});

describe("/api/ssh/preferences (default connecting machine)", () => {
  async function patchPreferences(cookie: string, defaultNodeId: string | null) {
    return sshFetch("/api/ssh/preferences", { method: "PATCH", body: { defaultNodeId }, cookie });
  }

  it("stores a visible node's id, reads it back on the saved-hosts view, and null clears it", async () => {
    const set = await patchPreferences(ownerCookie, NODE_ON);
    expect(set.status).toBe(200);
    expect(((await set.json()) as { defaultNodeId: string | null }).defaultNodeId).toBe(NODE_ON);
    const view = (await (await sshFetch("/api/ssh/saved-hosts", { cookie: ownerCookie })).json()) as {
      defaultNodeId: string | null;
    };
    expect(view.defaultNodeId).toBe(NODE_ON);
    const cleared = await patchPreferences(ownerCookie, null);
    expect(((await cleared.json()) as { defaultNodeId: string | null }).defaultNodeId).toBeNull();
  });

  it("an invisible or unknown node id is 404 (validation happens at the write)", async () => {
    expect((await patchPreferences(ownerCookie, "no-such-node")).status).toBe(404);
    expect((await patchPreferences(editorCookie, NODE_OFF)).status).toBe(404); // the editor cannot see NODE_OFF
  });

  it("a node that vanishes after the write still reads back as the stored id (the SPA decides)", async () => {
    const transient = `n-vanish-${crypto.randomUUID()}`;
    createdNodeIds.push(transient);
    await nodes.create({
      id: transient,
      ownerUserId: ownerId,
      name: `sshapi-vanish-${transient.slice(0, 8)}`,
      kind: "agent",
      status: "offline",
    });
    await patchPreferences(ownerCookie, transient);
    await nodes.deleteById(transient);
    const view = (await (await sshFetch("/api/ssh/saved-hosts", { cookie: ownerCookie })).json()) as {
      defaultNodeId: string | null;
    };
    expect(view.defaultNodeId).toBe(transient);
  });
});

describe("the local node answers in-process (no agent socket exists to reach)", () => {
  // NOTE on HOME: Bun's `os.homedir()` reads HOME at PROCESS START and caches
  // it (measured on 1.4.2), so a test cannot swap `process.env.HOME` to feed
  // the discovery engine a fixture `~`. The alias-list CONTENTS are therefore
  // whatever the server account's own config holds (machine-dependent; the
  // discovery engine's fixture-parsed contents are pinned in
  // pane-runtime's `ssh-discover` suite). What this case owns is the plane
  // half: the gate is asked BEFORE the filesystem is read, and `local` answers
  // through the in-process runtime rather than an RPC.
  let homeDir: string;
  let previousSshPath: string | undefined;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "subshell-ssh-home-"));
    // A stub ssh that answers `-G` like a clean OpenSSH would for the manual
    // destination (no forwarding lines, one hostname, a chosen user, a
    // non-default port): the resolution engine here is the SAME code the
    // agent runs, fed this deterministic answer.
    const stub = join(homeDir, "ssh-stub.sh");
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "host verify.example\\nhostname verify.example\\nport 2222\\nuser stubuser\\n"\nexit 0\n',
    );
    chmodSync(stub, 0o755);
    previousSshPath = process.env.SUBSHELL_SSH_PATH;
    process.env.SUBSHELL_SSH_PATH = stub; // findBinary's first rung, like every harness override
  });

  afterAll(() => {
    if (previousSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
    else process.env.SUBSHELL_SSH_PATH = previousSshPath;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("local SSH off answers 403 before the account's config is read; the admin opens it and the in-process discovery answers", async () => {
    const gated = await aliases(LOCAL_NODE_ID, adminCookie);
    expect(gated.status).toBe(403); // local ships OFF (spec §4.3)

    await nodes.setSshEnabled(LOCAL_NODE_ID, { on: true, changedAt: "2026-10-07T09:00:00.000Z" });
    const res = await aliases(LOCAL_NODE_ID, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aliases: string[]; includeCycle: boolean; truncated: boolean };
    // The SHAPE is the contract here (sorted names + the two cycle/truncation
    // facts); contents belong to whoever's account runs the server.
    expect(Array.isArray(body.aliases)).toBe(true);
    expect(body.includeCycle).toBe(false);
    expect(body.truncated).toBe(false);
    // A member holds Everyone/edit on `local` — visibility, never SSH use.
    expect((await aliases(LOCAL_NODE_ID, otherCookie)).status).toBe(403);
  });

  it("local resolve runs the same engine in-process: the -G answer becomes an approved snapshot", async () => {
    await nodes.setSshEnabled(LOCAL_NODE_ID, { on: true, changedAt: "2026-10-07T09:00:00.000Z" });
    const res = await resolve(LOCAL_NODE_ID, "verify.example", adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: boolean;
      snapshot?: { host: string; port: number; user: string | null; alias: string };
      connectingAccount?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.snapshot?.host).toBe("verify.example");
    expect(body.snapshot?.port).toBe(2222);
    expect(body.snapshot?.user).toBe("stubuser");
    expect(body.snapshot?.alias).toBe("verify.example");
    expect(body.connectingAccount).toBeDefined();
  });
});
