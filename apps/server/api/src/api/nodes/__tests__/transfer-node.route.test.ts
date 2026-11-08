import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { transferNodeOwnership } from "@/modules/nodes/transfer-ownership.js";
import { type RelayBroker, setRelayBrokerForTests } from "@/modules/ssh/relay-broker.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * `POST /api/nodes/:id/transfer` — the ownership handover (spec 2026-11-07).
 *
 * Direct handover, one transaction, strict owner: the manage band stopped one
 * rank below this act on purpose, and the retire gate's admin arm does not
 * reach it either. Machine actors arrive only through an explicit
 * `nodes:transfer` grant (system keys, or pane credentials that INHERITED the
 * grant), and loadNodeGate keeps them on their own account's rows — the
 * provisioning story, never someone else's machine.
 */

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
const shares = new NodeSharesRepository(db);
const userMeta = new UserMetaRepository(db);

type AuditRow = { action: string; actorUserId: string | null; targetId: string | null; metadataJson: string | null };

describe("POST /api/nodes/:id/transfer", () => {
  const pw = "node-transfer-1";
  const emails = {
    alice: `nt-alice-${crypto.randomUUID()}@subshell.local`,
    bob: `nt-bob-${crypto.randomUUID()}@subshell.local`,
    carol: `nt-carol-${crypto.randomUUID()}@subshell.local`,
    dave: `nt-dave-${crypto.randomUUID()}@subshell.local`,
    root: `nt-root-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId = "";
  let bobId = "";
  let carolId = "";
  let daveId = "";
  let systemUserId = "";
  let aliceCookie = "";
  let bobCookie = "";
  let carolCookie = "";
  let adminCookie = "";
  const createdNodeIds: string[] = [];
  const createdKeyIds: string[] = [];

  async function mkNode(ownerId: string, name: string): Promise<{ id: string; keyRowId: string; key: string }> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: ownerId, name, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    // Mirrors enroll's mint exactly: kind-tagged, no permissions map.
    const created = (await getAuth().api.createApiKey({
      body: { name: `node:${id}`, userId: ownerId, metadata: { kind: "node", nodeId: id } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    await nodes.setApiKeyId(id, created.id);
    return { id, keyRowId: created.id, key: created.key };
  }

  async function mkSystemKey(permissions: string[] | null): Promise<string> {
    const metadata =
      permissions === null
        ? { kind: "system" } // legacy spelling: no versioned grants
        : { kind: "system", permissionVersion: 1, systemPermissions: permissions };
    const created = (await getAuth().api.createApiKey({
      body: { name: "nt-system", userId: systemUserId, metadata },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    return created.key;
  }

  function apikeyRow(id: string): { referenceId: string; name: string } | null {
    return authDatabase()
      .query<{ referenceId: string; name: string }, [string]>(`SELECT "referenceId", "name" FROM apikey WHERE id = ?`)
      .get(id);
  }

  async function transferAudit(): Promise<AuditRow[]> {
    return (await db
      .selectFrom("auditEvents")
      .select(["action", "actorUserId", "targetId", "metadataJson"])
      .where("action", "=", "node.owner_transfer")
      .execute()) as AuditRow[];
  }

  async function req(
    method: string,
    path: string,
    opts: { cookie?: string; bearer?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return app.fetch(
      new Request(`http://localhost:3080/api/nodes${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    aliceId = await users.createUser({
      email: emails.alice,
      name: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    bobId = await users.createUser({
      email: emails.bob,
      name: emails.bob,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    carolId = await users.createUser({
      email: emails.carol,
      name: emails.carol,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    daveId = await users.createUser({
      email: emails.dave,
      name: emails.dave,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await users.createUser({
      email: emails.root,
      name: emails.root,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    aliceCookie = await signIn(emails.alice, pw);
    bobCookie = await signIn(emails.bob, pw);
    carolCookie = await signIn(emails.carol, pw);
    adminCookie = await signIn(emails.root, pw);
    systemUserId = await ensureSystemUser();
    await ensureLocalNode(db);
  });

  afterAll(async () => {
    for (const id of createdKeyIds) {
      authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [id]);
    }
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  // ── refusals ─────────────────────────────────────────────────────────────

  it("the cookie admin is refused on a foreign node: retire authority does not transfer", async () => {
    const { id } = await mkNode(aliceId, `t-admin-${crypto.randomUUID().slice(0, 8)}`);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          cookie: adminCookie,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);
    expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
  });

  it("a manage grantee cannot transfer, and still manages everything else", async () => {
    // The two arms must not move together: manage opens the shares door and
    // stops at ownership.
    const { id } = await mkNode(aliceId, `t-manage-${crypto.randomUUID().slice(0, 8)}`);
    await shares.replaceForNode(id, [{ granteeUserId: carolId, permission: "manage" }], aliceId);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          cookie: carolCookie,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);
    expect((await req("GET", `/${id}/shares`, { cookie: carolCookie })).status).toBe(200);
    expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
  });

  it("foreign viewer 404 and ghost 404 collapse: invisible stays invisible", async () => {
    const { id } = await mkNode(aliceId, `t-404-${crypto.randomUUID().slice(0, 8)}`);
    const foreign = (
      await req("POST", `/${id}/transfer`, {
        cookie: bobCookie,
        body: { toUserId: daveId, retainAccessAsManager: false },
      })
    ).status;
    const ghost = (
      await req("POST", `/ghost-${crypto.randomUUID()}/transfer`, {
        cookie: aliceCookie,
        body: { toUserId: bobId, retainAccessAsManager: false },
      })
    ).status;
    expect(foreign).toBe(404);
    expect(ghost).toBe(404);
  });

  it("local is 400 on the route shape, before the caller is asked", async () => {
    // Alice is only an Everyone/`edit` viewer of `local` — a 403 would send
    // her looking for an owner to ask, when the truth is the surface never
    // applies to the control-plane host.
    const res = await req("POST", "/local/transfer", {
      cookie: aliceCookie,
      body: { toUserId: bobId, retainAccessAsManager: false },
    });
    expect(res.status).toBe(400);
  });

  it("self, unknown, and disabled recipients are refused before anything moves", async () => {
    const { id } = await mkNode(aliceId, `t-body-${crypto.randomUUID().slice(0, 8)}`);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          cookie: aliceCookie,
          body: { toUserId: aliceId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          cookie: aliceCookie,
          body: { toUserId: "user-does-not-exist", retainAccessAsManager: false },
        })
      ).status,
    ).toBe(400);
    await userMeta.setDisabled(daveId, true);
    try {
      expect(
        (
          await req("POST", `/${id}/transfer`, {
            cookie: aliceCookie,
            body: { toUserId: daveId, retainAccessAsManager: false },
          })
        ).status,
      ).toBe(400);
      expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    } finally {
      await userMeta.setDisabled(daveId, false);
    }
  });

  it("a name collision with the recipient's fleet answers 409 and moves nothing", async () => {
    const shared = `t-clash-${crypto.randomUUID().slice(0, 8)}`;
    const { id } = await mkNode(aliceId, shared);
    const { id: bobNode } = await mkNode(bobId, shared);
    const res = await req("POST", `/${id}/transfer`, {
      cookie: aliceCookie,
      body: { toUserId: bobId, retainAccessAsManager: false },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_NAME_TAKEN");
    expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    expect((await nodes.findById(bobNode))?.ownerUserId).toBe(bobId);
  });

  // ── success ──────────────────────────────────────────────────────────────

  it("the handover moves the owner, re-homes the bearer key, and keeps the machine standing", async () => {
    const { id, keyRowId } = await mkNode(aliceId, `t-ok-${crypto.randomUUID().slice(0, 8)}`);
    // A recovery key minted for this node, unused, and a used one for history.
    const now = new Date().toISOString();
    const dayAhead = new Date(Date.now() + 86_400_000).toISOString();
    await db
      .insertInto("nodeSetupKeys")
      .values([
        {
          id: crypto.randomUUID(),
          ownerUserId: aliceId,
          key: `unused-${crypto.randomUUID()}`,
          targetNodeId: id,
          targetApiKeyId: keyRowId,
          createdAt: now,
          expiresAt: dayAhead,
          usedAt: null,
          consumedNodeId: null,
        },
        {
          id: crypto.randomUUID(),
          ownerUserId: aliceId,
          key: `used-${crypto.randomUUID()}`,
          targetNodeId: id,
          targetApiKeyId: keyRowId,
          createdAt: now,
          expiresAt: dayAhead,
          usedAt: now,
          consumedNodeId: null,
        },
      ] as never[])
      .execute();
    // Shares to bob at view (survive) and a pane row of alice's (untouched).
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], aliceId);
    const paneId = crypto.randomUUID();
    await db
      .insertInto("subshells")
      .values({
        id: paneId,
        userId: aliceId,
        name: "t-probe",
        harnessId: "terminal",
        workingDir: "/tmp",
        tmuxSocket: "subshell-t-probe",
        nodeId: id,
        status: "running",
        alive: 1,
      } as never)
      .execute();

    const res = await req("POST", `/${id}/transfer`, {
      cookie: aliceCookie,
      body: { toUserId: bobId, retainAccessAsManager: true },
    });
    expect(res.status).toBe(200);

    expect((await nodes.findById(id))?.ownerUserId).toBe(bobId);
    // The node's bearer key is managed by whoever manages the machine now.
    // `referenceId` is better-auth's physical owner column; the NAME stays
    // enroll's `node:<nodeId>` spelling — it names the machine, not a person.
    const row = apikeyRow(keyRowId);
    expect(row?.referenceId).toBe(bobId);
    expect(row?.name).toBe(`node:${id}`);
    // The link binding never moved: same key row id on the node.
    expect((await nodes.findById(id))?.apiKeyId).toBe(keyRowId);

    // The unused recovery key is gone; the used sibling keeps its history.
    const remaining = await db
      .selectFrom("nodeSetupKeys")
      .select(["key", "usedAt"])
      .where("targetNodeId", "=", id)
      .execute();
    expect(remaining.some((k) => k.key.startsWith("unused-"))).toBe(false);
    expect(remaining.some((k) => k.key.startsWith("used-") && k.usedAt !== null)).toBe(true);

    // Shares: bob's pre-existing `view` row survived the handover (different
    // grantee rows are left alone) and alice gained exactly one `manage` row.
    const after = await shares.listForNode(id);
    expect(after.find((s) => s.granteeUserId === bobId)?.permission).toBe("view");
    const aliceRows = after.filter((s) => s.granteeUserId === aliceId);
    expect(aliceRows.length).toBe(1);
    expect(aliceRows[0]?.permission).toBe("manage");

    // Alice's running pane is bob's machine's problem no more than before:
    // the row is untouched, and she can still see it.
    const pane = await db
      .selectFrom("subshells")
      .select(["userId", "nodeId"])
      .where("id", "=", paneId)
      .executeTakeFirst();
    expect(pane).toEqual({ userId: aliceId, nodeId: id });

    // The audit row names the act and never a key.
    const audits = (await transferAudit()).filter((a) => a.targetId === id);
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]?.metadataJson ?? "{}")).toEqual({
      fromUserId: aliceId,
      toUserId: bobId,
      retainAccessAsManager: true,
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("unused-");
    expect(serialized).not.toContain("used-");

    // After the handover the new owner manages; the old owner keeps manage
    // (via the share-back) but cannot transfer again.
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          cookie: aliceCookie,
          body: { toUserId: daveId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);
    expect((await req("PUT", `/${id}/shares`, { cookie: bobCookie, body: { shares: [] } })).status).toBe(200);

    await db.deleteFrom("subshells").where("id", "=", paneId).execute();
  });

  it("retainAccessAsManager false leaves the old owner with no grant at all", async () => {
    const { id } = await mkNode(aliceId, `t-clean-${crypto.randomUUID().slice(0, 8)}`);
    // A leftover self-grant is the realistic shape, not the empty case: a
    // round-trip transfer (or a shares edit naming the owner) plants a row,
    // and a declined share-back must clear it. Without the unconditional
    // delete the giver silently keeps manage after saying no.
    await db
      .insertInto("nodeShares")
      .values({
        id: crypto.randomUUID(),
        nodeId: id,
        granteeUserId: aliceId,
        permission: "manage",
        createdBy: aliceId,
        createdAt: new Date().toISOString(),
      })
      .execute();
    const res = await req("POST", `/${id}/transfer`, {
      cookie: aliceCookie,
      body: { toUserId: bobId, retainAccessAsManager: false },
    });
    expect(res.status).toBe(200);
    expect((await shares.listForNode(id)).filter((s) => s.granteeUserId === aliceId)).toHaveLength(0);
  });

  it("a handover closes brokered relays the new access no longer authorizes", async () => {
    // The shares route's mandatory revocation cut, same posture (spec
    // 2026-11-07 review): the giver who parts clean must not keep streaming
    // through a relay opened under their old authority.
    const { id } = await mkNode(aliceId, `t-relay-${crypto.randomUUID().slice(0, 8)}`);
    const cuts: string[] = [];
    const spy = {
      openRelay: async () => {
        throw new Error("unused");
      },
      routeRelayFrame: () => {},
      closeRelay: async () => false,
      closeUnauthorizedForNode: async (nodeId: string) => {
        cuts.push(nodeId);
        return 0;
      },
      closeForPane: async () => 0,
      refuseOverCap: async () => false,
      onNodeSocketClosed: async () => 0,
      activeRelayCount: () => 0,
      sessionInfo: () => null,
      reset: () => {},
    };
    setRelayBrokerForTests(spy as unknown as RelayBroker);
    try {
      const res = await req("POST", `/${id}/transfer`, {
        cookie: aliceCookie,
        body: { toUserId: bobId, retainAccessAsManager: false },
      });
      expect(res.status).toBe(200);
    } finally {
      setRelayBrokerForTests(null);
    }
    expect(cuts).toEqual([id]);
  });

  it("the success body names the move it performed", async () => {
    const { id } = await mkNode(aliceId, `t-body-${crypto.randomUUID().slice(0, 8)}`);
    const res = await req("POST", `/${id}/transfer`, {
      cookie: aliceCookie,
      body: { toUserId: bobId, retainAccessAsManager: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId: id, ownerUserId: bobId, retainedAccessAsManager: true });
  });

  it("a stale compare-and-swap answers 409 and rewrites nothing", async () => {
    // The module's own guard rail: whoever races the row loses cleanly. Reaching
    // it through the route needs a mid-request race; the module call states the
    // arm directly.
    const { id } = await mkNode(aliceId, `t-cas-${crypto.randomUUID().slice(0, 8)}`);
    const err = await transferNodeOwnership({
      nodeId: id,
      fromUserId: "user-not-the-owner",
      toUserId: bobId,
      retainAccessAsManager: true,
      apiKeyId: null,
    }).then(
      () => null,
      (e: unknown) => e as { status?: number },
    );
    expect(err?.status).toBe(409);
    expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    expect(await shares.listForNode(id)).toHaveLength(0);
  });

  // Security pass on merged #495: the transaction must not COMMIT a state the
  // route refused at READ time. The owner CAS cannot catch these — the racing
  // act touches a different row — so the transaction re-asserts them inside.

  it("a recipient disabled between the route's check and the commit refuses the handover", async () => {
    const daveId = await new UsersRepository(db).createUser({
      email: `t-rdis-${crypto.randomUUID()}@subshell.local`,
      name: "t-rdis",
      passwordHash: await hashPassword("t-1"),
      role: "user",
    });
    // The REAL key id so the refusal can only come from the recipient
    // re-assert, not from an incidental CAS miss (round-2 nit).
    const { id, keyRowId } = await mkNode(aliceId, `t-rdis-${crypto.randomUUID().slice(0, 8)}`);
    const meta = new UserMetaRepository(db);
    await meta.setDisabled(daveId, true);
    try {
      const err = await transferNodeOwnership({
        nodeId: id,
        fromUserId: aliceId,
        toUserId: daveId,
        retainAccessAsManager: true,
        apiKeyId: keyRowId,
      }).then(
        () => null,
        (e: unknown) => e as { status?: number },
      );
      expect(err?.status).toBe(400);
      expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    } finally {
      await meta.setDisabled(daveId, false);
    }
  });

  it("a recipient awaiting approval is the same stranded machine, refused in the transaction too", async () => {
    const daveId = await new UsersRepository(db).createUser({
      email: `t-rpen-${crypto.randomUUID()}@subshell.local`,
      name: "t-rpen",
      passwordHash: await hashPassword("t-1"),
      role: "user",
    });
    // The REAL key id: a 400 can only come from the recipient re-assert, not
    // an incidental CAS miss (round-2 nit).
    const { id, keyRowId } = await mkNode(aliceId, `t-rpen-${crypto.randomUUID().slice(0, 8)}`);
    const meta = new UserMetaRepository(db);
    await meta.setApproval(daveId, "pending");
    try {
      const err = await transferNodeOwnership({
        nodeId: id,
        fromUserId: aliceId,
        toUserId: daveId,
        retainAccessAsManager: true,
        apiKeyId: keyRowId,
      }).then(
        () => null,
        (e: unknown) => e as { status?: number },
      );
      expect(err?.status).toBe(400);
      expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    } finally {
      await meta.setApproval(daveId, "approved");
    }
  });

  it("a key rotated under the transfer loses the race: a stale apiKeyId cannot re-home a dead row", async () => {
    // The transfer's CAS must cover the OTHER half of the link fact too.
    // Rotate CASes apiKeyId but not the owner; the transfer CASed only the
    // owner, so an interleaved rotate committed a node owned by bob whose
    // LIVE key belonged to alice — the exact split the module docstring says
    // the transaction exists to prevent.
    const { id, keyRowId } = await mkNode(aliceId, `t-stale-${crypto.randomUUID().slice(0, 8)}`);
    const second = (await getAuth().api.createApiKey({
      body: { name: `node:${id}`, userId: aliceId, metadata: { kind: "node", nodeId: id } },
    })) as unknown as { id: string };
    createdKeyIds.push(second.id);
    await nodes.setApiKeyId(id, second.id); // the rotate's committed write
    const err = await transferNodeOwnership({
      nodeId: id,
      fromUserId: aliceId,
      toUserId: bobId,
      retainAccessAsManager: false,
      apiKeyId: keyRowId, // the transfer's stale read
    }).then(
      () => null,
      (e: unknown) => e as { status?: number },
    );
    expect(err?.status).toBe(409);
    expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    expect(apikeyRow(keyRowId)?.referenceId).toBe(aliceId); // the stale key was not re-homed
  });

  it("the route itself refuses an approval-pending recipient (same posture as disabled)", async () => {
    const daveId = await new UsersRepository(db).createUser({
      email: `t-rpenr-${crypto.randomUUID()}@subshell.local`,
      name: "t-rpenr",
      passwordHash: await hashPassword("t-1"),
      role: "user",
    });
    const { id } = await mkNode(aliceId, `t-rpenr-${crypto.randomUUID().slice(0, 8)}`);
    const meta = new UserMetaRepository(db);
    await meta.setApproval(daveId, "pending");
    try {
      const res = await req("POST", `/${id}/transfer`, {
        cookie: aliceCookie,
        body: { toUserId: daveId, retainAccessAsManager: true },
      });
      expect(res.status).toBe(400);
      expect((await nodes.findById(id))?.ownerUserId).toBe(aliceId);
    } finally {
      await meta.setApproval(daveId, "approved");
    }
  });

  it("a rotation that races a committed transfer loses: no giver-owned key on the new owner's machine", async () => {
    // Round-2 closure: the transfer CAS loses to a committed rotation; the
    // mirror direction needs the rotate CAS to cover the OWNER too, because
    // its slow better-auth mint is exactly where a transfer lands. Staged at
    // that seam: the ownership write commits while rotate's mint is in
    // flight (the fixture stages the owner flip only — none of the transfer's
    // other writes bear on what rotate's CAS must reject). Without the owner
    // guard this commits a bob-owned node bound to an alice-owned live key —
    // a credential the giver kept over a machine she no longer owns.
    const { id, keyRowId } = await mkNode(aliceId, `t-rrot-${crypto.randomUUID().slice(0, 8)}`);
    const auth = getAuth();
    const api = auth.api as unknown as { createApiKey: (input: unknown) => Promise<unknown> };
    const original = api.createApiKey.bind(auth.api);
    let mintedId = "";
    api.createApiKey = async (input: unknown) => {
      const created = (await original(input)) as { id: string };
      mintedId = created.id;
      createdKeyIds.push(created.id);
      // The transfer commits inside the mint's await window.
      await db.updateTable("nodes").set({ ownerUserId: bobId }).where("id", "=", id).execute();
      return created;
    };
    try {
      const res = await req("POST", `/${id}/rotate-key`, { cookie: aliceCookie });
      expect(res.status).toBe(409);
      expect((await nodes.findById(id))?.apiKeyId).toBe(keyRowId); // no flip
      expect((await nodes.findById(id))?.ownerUserId).toBe(bobId); // the transfer stands
      const orphan = authDatabase()
        .query<{ enabled: number }, [string]>(`SELECT enabled FROM apikey WHERE id = ?`)
        .get(mintedId);
      expect(orphan?.enabled).toBe(0); // the catch disables the loser's mint
    } finally {
      api.createApiKey = original;
    }
  });

  // ── machine doors ────────────────────────────────────────────────────────

  it("a system key without the grant is refused; with nodes:transfer it assigns its own account's node", async () => {
    const without = await mkSystemKey(["nodes:read"]);
    const withGrant = await mkSystemKey(["nodes:transfer"]);
    const legacy = await mkSystemKey(null);
    const { id } = await mkNode(systemUserId, `t-prov-${crypto.randomUUID().slice(0, 8)}`);
    // No grant: refused. Legacy (unversioned) keys stay off this door entirely.
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: without,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: legacy,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);
    // Granted: the provisioning story — automation hands out machines the
    // system account holds.
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: withGrant,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(200);
    expect((await nodes.findById(id))?.ownerUserId).toBe(bobId);
  });

  it("a system key never reaches a HUMAN's node: the bearer arm is owner-equality", async () => {
    const withGrant = await mkSystemKey(["nodes:transfer"]);
    const { id } = await mkNode(aliceId, `t-fence-${crypto.randomUUID().slice(0, 8)}`);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: withGrant,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(404);
  });

  it("a plain pane token is refused; a pane that inherited nodes:transfer acts for its creator", async () => {
    const plainPane = crypto.randomUUID();
    await db
      .insertInto("subshells")
      .values({
        id: plainPane,
        userId: aliceId,
        name: "t-pane-plain",
        harnessId: "terminal",
        workingDir: "/tmp",
        tmuxSocket: "subshell-t-pane-plain",
        nodeId: "local",
        status: "terminated",
        alive: 0,
      } as never)
      .execute();
    const plainKey = await issueSubshellToken(plainPane, aliceId);

    const { id } = await mkNode(aliceId, `t-pane-${crypto.randomUUID().slice(0, 8)}`);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: plainKey,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(403);

    // Derived pane credentials carry the creator's ceiling — an explicit
    // inheritance here, which is how a scoped automation key's child reaches
    // the same doors its parent can.
    //
    // NOTE (security pass on #495): production keeps the invariant "a pane
    // whose token has a non-null ceiling is a SYSTEM row", because the ceiling
    // only arrives from the creating key and that key resolves as the system
    // account (create route passes systemKeyPermissions through to
    // issueSubshellToken with the SYSTEM user id; the re-mint path re-asserts
    // owner equality). This test hand-inserts the human-owned pairing directly
    // — the gate itself would NOT refuse such a credential, so if any future
    // feature ever issues ceilings on human-owned rows (an admin-on-behalf-of
    // flow), the human transfer door opens to a prompt-controlled pane. That
    // mint-site invariant is the defense; keep it true, or gate here.
    const derivedPane = crypto.randomUUID();
    await db
      .insertInto("subshells")
      .values({
        id: derivedPane,
        userId: aliceId,
        name: "t-pane-derived",
        harnessId: "terminal",
        workingDir: "/tmp",
        tmuxSocket: "subshell-t-pane-derived",
        nodeId: "local",
        status: "terminated",
        alive: 0,
      } as never)
      .execute();
    const derivedKey = await issueSubshellToken(derivedPane, aliceId, ["nodes:transfer"]);
    expect(
      (
        await req("POST", `/${id}/transfer`, {
          bearer: derivedKey,
          body: { toUserId: bobId, retainAccessAsManager: false },
        })
      ).status,
    ).toBe(200);
    expect((await nodes.findById(id))?.ownerUserId).toBe(bobId);

    await db.deleteFrom("subshells").where("id", "in", [plainPane, derivedPane]).execute();
  });
});
