import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * `POST /api/subshells/:id/input` on an SSH pane (spec 2026-10-07 §5.4,
 * decision 5): the pane's session lives on a remote machine under the
 * OWNER's ssh identity, so only the owner's own account may type there. The
 * `subshells.ssh` column is the kind fact; the refusal is the named 403 code
 * `SSH_OWNER_INPUT_ONLY`, asked AFTER the ordinary gate (a stranger still
 * gets the 404; a `view` grantee still gets the plain 403) and BEFORE
 * anything is typed.
 *
 * The decisive case is the bearer one: raw REST resolves a pane's own
 * subshell key as its OWNER (boost/shares off), so a bare owner comparison
 * would let an ssh pane type into itself. `bearerActor` is what refuses it.
 *
 * The sibling suite (`subshell-input-route.test.ts`) pins the ordinary-pane
 * rules; the first case here re-pins the ordinary row + edit grantee from the
 * SSH suite's own door, because the rule must not graze panes whose snapshot
 * column is NULL.
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
import { attachScriptedNode, ok, type ScriptedNode, statDirEcho } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** What a RUNNING pane's node answers; refusals must leave it untouched. */
const LIFECYCLE = { stat_dir: statDirEcho, launch: ok, input: ok };

/** A minimal but truthful snapshot JSON; the input door reads presence, not content. */
const SNAPSHOT = JSON.stringify({ destination: "host.example", user: "theo", port: 22 });

describe("POST /api/subshells/:id/input on ssh panes (spec §5.4)", () => {
  const ownerEmail = `inssh-owner-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `inssh-grantee-${crypto.randomUUID()}@subshell.local`;
  const pw = "inputssh-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;
  let node: string; // agent node with a per-test scripted agent attached
  const createdSubshellIds: string[] = [];

  async function input(id: string, opts: { cookie?: string; bearer?: string; body: unknown }) {
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/input`, {
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
      tmuxSocket: `inssh-sock-${id}`,
      nodeId: node,
      status: "running",
      alive: 1,
      ssh: overrides.ssh ?? null,
    });
    return id;
  }

  const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };
  const inputBytes = (sim: ScriptedNode) => sim.cmdsOf("input").map((c) => c.data);

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
    await nodes.create({ id: node, ownerUserId: ownerId, name: `inssh-${node.slice(0, 8)}`, kind: "agent" });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    for (const email of [ownerEmail, granteeEmail]) await deleteUserByEmailOrId(email);
  });

  it("an ordinary row + edit grantee is unchanged (the kind rule must not graze NULL)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "inssh-ordinary" });
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "edit" }], ownerId);
      const res = await input(id, { cookie: granteeCookie, body: { text: "still types", submit: false } });
      expect(res.status).toBe(200);
      expect(inputBytes(sim)).toEqual(["still types"]);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + the OWNER cookie 200s and types (the owner rule is a permission, not a lockout)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "inssh-owner", harnessId: "ssh", ssh: SNAPSHOT });
      const res = await input(id, { cookie: ownerCookie, body: { text: "owner types" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(inputBytes(sim)).toEqual(["owner types", "\r"]);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + an EDIT grantee 403s SSH_OWNER_INPUT_ONLY and types nothing", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "inssh-grantee", harnessId: "ssh", ssh: SNAPSHOT });
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "edit" }], ownerId);
      const res = await input(id, { cookie: granteeCookie, body: { text: "grantee types" } });
      expect(res.status).toBe(403);
      expect((await errorBody(res)).code).toBe(BackendErrorCodes.SSH_OWNER_INPUT_ONLY);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + its OWN pane key 403s (decision 5: the pane must not type into itself)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "inssh-selfkey", harnessId: "ssh", ssh: SNAPSHOT });
      const key = await issueSubshellToken(id, ownerId);
      // Raw REST resolves a pane's own key as its OWNER (boost/shares off),
      // so the owner comparison alone would ADMIT this; `bearerActor` is the
      // explicit second refusal decision 5 names.
      const res = await input(id, { bearer: key, body: { text: "self type" } });
      expect(res.status).toBe(403);
      expect((await errorBody(res)).code).toBe(BackendErrorCodes.SSH_OWNER_INPUT_ONLY);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("an ssh row + a SIBLING pane's key 403s too (the §4 owner-resolution is still a bearer act)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const ordinaryPane = await directRow({ name: "inssh-sib-src" }); // the token's own row
      const sshPane = await directRow({ name: "inssh-sib-dest", harnessId: "ssh", ssh: SNAPSHOT });
      const key = await issueSubshellToken(ordinaryPane, ownerId);
      // The input route's §4 surface admits the owner's OTHER rows to a pane
      // key; the ssh kind fence closes exactly that door for ssh panes.
      const res = await input(sshPane, { bearer: key, body: { text: "sibling types" } });
      expect(res.status).toBe(403);
      expect((await errorBody(res)).code).toBe(BackendErrorCodes.SSH_OWNER_INPUT_ONLY);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });
});
