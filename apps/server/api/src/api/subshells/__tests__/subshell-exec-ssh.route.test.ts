import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * `POST /api/subshells/:id/exec` on SSH panes (spec 2026-10-07 §5.4): exec
 * TYPES into the pane, so it carries the input rule verbatim. The kind check
 * rides the same `#gate` follow-up as `sendSubshellInput`, and it precedes
 * every frame AND every read: the refusal never even quiet-probes the log.
 *
 * The grant rules, the sentinel machinery and the scripted-log idiom are
 * `subshell-exec-route.test.ts`'s, copied rather than shared so that suite
 * stays byte-identical; what differs here is the row's kind. The first case
 * re-pins the ordinary terminal row + edit grantee from this suite's own
 * door, because the rule must not graze panes whose snapshot column is NULL.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import {
  attachScriptedNode,
  ok,
  type ScriptedHandler,
  type ScriptedNode,
  statDirEcho,
} from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** What a RUNNING pane's node answers; the exec suites extend it with `log_read`. */
const LIFECYCLE = { stat_dir: statDirEcho, launch: ok };

/** A minimal but truthful snapshot JSON; the exec door reads presence, not content. */
const SNAPSHOT = JSON.stringify({ destination: "host.example", user: "theo", port: 22 });

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const SENTINEL_FRAME_RE = /__xcomm_([0-9a-f]{16})_DONE/;

/** The scripted pane's log as a function of the typed frames (the exec suite's idiom). */
function scriptedExecLog(typed: string[]): string {
  const sentinelFrame = typed[2];
  if (typed.length < 4 || sentinelFrame === undefined) return "";
  const token = SENTINEL_FRAME_RE.exec(sentinelFrame)?.[1];
  if (!token) return "";
  return `out line\n__xcomm_${token}_DONE rc=0\n$ `;
}

function windowOver(text: string, fromByte: number, maxBytes: number) {
  const full = enc.encode(text);
  const end = Math.min(full.byteLength, fromByte + maxBytes);
  return { bytes_b64: b64(full.subarray(fromByte, end)), next: end, size: full.byteLength };
}

function execLogRead(typed: string[]): ScriptedHandler {
  return (cmd) => {
    if (cmd.type !== "log_read") return new Error(`exec-ssh sim: wrong cmd ${cmd.type}`);
    return windowOver(scriptedExecLog(typed), cmd.fromByte, cmd.maxBytes);
  };
}

function typingInto(typed: string[]): ScriptedHandler {
  return (cmd) => {
    if (cmd.type === "input") typed.push(cmd.data);
    return undefined;
  };
}

const fourFramesTyped = (sim: ScriptedNode) => sim.cmdsOf("input").map((c) => c.data).length === 4;

describe("POST /api/subshells/:id/exec on ssh panes (spec §5.4)", () => {
  const ownerEmail = `exssh-owner-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `exssh-grantee-${crypto.randomUUID()}@subshell.local`;
  const pw = "execssh-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;
  let node: string;
  const createdSubshellIds: string[] = [];

  async function exec(id: string, opts: { cookie?: string; bearer?: string; body: unknown }) {
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/exec`, {
        method: "POST",
        headers,
        body: JSON.stringify(opts.body),
      }),
    );
  }

  /** A RUNNING row written straight to the table (kind chosen by the caller). */
  async function directRow(overrides: {
    name: string;
    userId?: string;
    harnessId?: string;
    ssh?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: overrides.userId ?? ownerId,
      presetId: null,
      harnessId: overrides.harnessId ?? "terminal",
      name: overrides.name,
      workingDir: "/tmp",
      tmuxSocket: `exssh-sock-${id}`,
      nodeId: node,
      status: "running",
      alive: 1,
      ssh: overrides.ssh ?? null,
    });
    return id;
  }

  const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    granteeId = await users.createUser({
      email: granteeEmail,
      name: granteeEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    granteeCookie = await signIn(granteeEmail, pw);

    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `exssh-${node.slice(0, 8)}`, kind: "agent" });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    for (const email of [ownerEmail, granteeEmail]) await deleteUserByEmailOrId(email);
  });

  it("an ordinary terminal row + edit grantee is unchanged (the kind rule must not graze NULL)", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: execLogRead(typed) });
    try {
      const id = await directRow({ name: "exssh-ordinary" });
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "edit" }], ownerId);
      const res = await exec(id, { cookie: granteeCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(200);
      expect(fourFramesTyped(sim)).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + the OWNER cookie 200s and types the four frames (the harness is a terminal too)", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: execLogRead(typed) });
    try {
      const id = await directRow({ name: "exssh-owner", harnessId: "ssh", ssh: SNAPSHOT });
      const res = await exec(id, { cookie: ownerCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; exitCode: number | null };
      expect(body.status).toBe("completed");
      expect(body.exitCode).toBe(0);
      expect(fourFramesTyped(sim)).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + an EDIT grantee 403s SSH_OWNER_INPUT_ONLY before any frame or read", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "exssh-grantee", harnessId: "ssh", ssh: SNAPSHOT });
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "edit" }], ownerId);
      const res = await exec(id, { cookie: granteeCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(403);
      expect((await errorBody(res)).code).toBe(BackendErrorCodes.SSH_OWNER_INPUT_ONLY);
      // The refusal precedes even the quiet probes: nothing reached the pane
      // and nothing was read from it.
      expect(sim.countOf("input")).toBe(0);
      expect(sim.countOf("log_read")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + its OWN pane key 403s (decision 5: the pane must not type into itself)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "exssh-selfkey", harnessId: "ssh", ssh: SNAPSHOT });
      const key = await issueSubshellToken(id, ownerId);
      const res = await exec(id, { bearer: key, body: { command: "echo hi" } });
      expect(res.status).toBe(403);
      expect((await errorBody(res)).code).toBe(BackendErrorCodes.SSH_OWNER_INPUT_ONLY);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });
});
