import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { SSH_MAX_GRANT_FINGERPRINTS } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SshGrantsRepository } from "@/db/repositories/ssh-grants.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import {
  approveGrant,
  createGrant,
  denyGrant,
  listGrantRequests,
  matchGrant,
  normalizeSshGrantSelector,
  prepareRelayLeg,
  requestFirstUse,
  revokeGrant,
  type SshGrantView,
  setSshGrantsDepsForTests,
  sshGrantSelectorMatches,
  sweepExpiredGrantRequests,
  updateGrant,
} from "@/services/ssh-grants.service.js";
import { type RelayBroker, SshRelayRefusal } from "@/services/ssh-relay.service.js";

/**
 * The grant authorization layer (spec 2026-10-08 §6; Task 10). What this
 * suite exists to pin, property by property:
 *
 * - FIRST USE: a launch with no standing grant records ONE durable pending
 *   row, notifies the owner once, and a relaunch FINDS that row (no second
 *   approval, no second notification). The row is DB state: a "restart"
 *   (deps swapped, nothing else) still finds it.
 * - APPROVE writes the grant with EXACTLY the chosen fingerprints, flips the
 *   request, and audits `approve` + `create` whose metadata names the COUNT,
 *   never a fingerprint string. A selection over SSH_MAX_GRANT_FINGERPRINTS
 *   is the named red error with the input untouched, never a truncation.
 * - DENY audits only. EXPIRY sweeps the row to `expired` and writes NOTHING.
 * - MATCH: owner + key home + selector against the resolved host; globs are
 *   policy; most specific wins, ties to the OLDEST grant.
 * - REVOKE cuts live relays: closeForGrant(grantId, "grant-revoked") is the
 *   revoke's own act (the T8 hook closing here).
 * - THE LAUNCH LEG: match -> openRelay (peers from the identities store) ->
 *   socket; no grant -> requestFirstUse + the named fail-fast, and the
 *   openRelay NEVER happens; a grant revoked mid-open is found by the
 *   post-open liveness re-check and cut, not orphaned (T8 NIT1).
 *
 * The clock, the broker, and the notification sink are the service's own
 * injected seams (the `getNodeWsDeps` pattern) - nothing waits, nothing dials.
 */

const repo = new SshGrantsRepository(db);
const emails: string[] = [];

async function mkUser(tag: string): Promise<string> {
  const email = `grants-svc-${tag}-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("grants-svc-1"),
    role: "user",
  });
}

let owner: string;
let stranger: string;
const NODE_A = "gsvc-node-a";
const NODE_B = "gsvc-node-b";
const nodes = new NodesRepository(db);

/** The one destination this suite routes through. */
const HOST = "git.example.test";

/** A fake clock the sweep and the expiry windows read; setT() moves it. */
let clockMs = Date.parse("2026-10-08T00:00:00.000Z");
const nowIso = () => new Date(clockMs).toISOString();

interface FakeCall {
  grantId: string;
  reason: string;
}
let openCalls: unknown[] = [];
let closeGrantCalls: FakeCall[] = [];
let notifyCalls: { ownerUserId: string; requestId: string }[] = [];

function installFakeDeps(brokerOverrides: Partial<RelayBroker> = {}) {
  const broker = {
    openRelay: async (input: unknown) => {
      openCalls.push(input);
      return {
        relayId: "relay-1",
        ref: "ref-1",
        expiresAt: new Date(clockMs + 30_000).toISOString(),
        socketPath: "/home/scripted/.subshell/ssh/pane/agent.sock",
      };
    },
    closeForGrant: async (grantId: string, reason: string) => {
      closeGrantCalls.push({ grantId, reason });
      return 1;
    },
    ...brokerOverrides,
  } as unknown as RelayBroker;
  setSshGrantsDepsForTests({
    nowIso,
    broker: () => broker,
    notifyGrantApproval: (ownerUserId, requestId) => {
      notifyCalls.push({ ownerUserId, requestId });
    },
  });
}

const FP = (n: number) => `SHA256:${"a".repeat(43).slice(0, 43 - String(n).length)}${String(n).padStart(2, "0")}`;
const FPS = [FP(1), FP(2)];

beforeAll(async () => {
  await setupAuthTables();
  await ensureMigratedTestDb();
  owner = await mkUser("owner");
  stranger = await mkUser("stranger");
  await nodes.create({ id: NODE_A, ownerUserId: owner, name: "key home", kind: "agent", status: "offline" });
  await nodes.setSshEnabled(NODE_A, { on: true, changedAt: nowIso() });
  await nodes.create({ id: NODE_B, ownerUserId: owner, name: "connector", kind: "agent", status: "offline" });
  await nodes.setSshEnabled(NODE_B, { on: true, changedAt: nowIso() });
  const identities = new IdentitiesRepository(db);
  await identities.register({
    principalId: `node:${NODE_A}`,
    publicKey: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}',
    signingPublicKey: '{"kty":"EC","crv":"P-256","x":"CCC","y":"DDD"}',
    displayName: "A",
  });
  await identities.register({
    principalId: `node:${NODE_B}`,
    publicKey: '{"kty":"EC","crv":"P-256","x":"EEE","y":"FFF"}',
    signingPublicKey: '{"kty":"EC","crv":"P-256","x":"GGG","y":"HHH"}',
    displayName: "B",
  });
});

afterAll(async () => {
  setSshGrantsDepsForTests(null);
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("identities").execute();
  for (const id of [NODE_A, NODE_B]) await nodes.deleteById(id).catch(() => {});
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

beforeEach(() => {
  clockMs = Date.parse("2026-10-08T00:00:00.000Z");
  openCalls = [];
  closeGrantCalls = [];
  notifyCalls = [];
  installFakeDeps();
});

async function cleanTier() {
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("auditEvents").execute();
}

async function latestAudit(action: string): Promise<Record<string, unknown>> {
  const rows = await db
    .selectFrom("auditEvents")
    .select("metadataJson")
    .where("action", "=", action)
    .orderBy("createdAt", "desc")
    .limit(1)
    .execute();
  return rows[0] ? (JSON.parse(rows[0].metadataJson ?? "{}") as Record<string, unknown>) : {};
}

describe("ssh-grants.service", () => {
  beforeEach(async () => {
    await cleanTier();
  });

  describe("requestFirstUse", () => {
    it("creates the pending row, notifies the owner once, and audits the ask (ids + destination, nothing else)", async () => {
      const answer = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "pane-ask-1",
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      const row = await repo.getRequest(owner, answer.value.requestId);
      expect(row).toBeDefined();
      expect(row?.status).toBe("pending");
      expect(row?.keyHomeNodeId).toBe(NODE_A);
      expect(row?.bNodeId).toBe(NODE_B);
      expect(row?.paneId).toBe("pane-ask-1");
      // setup-key scale (24 h): the deadline is a day out from the ask.
      if (!row) throw new Error("pending row vanished");
      expect(Date.parse(row.expiresAt) - Date.parse(row.createdAt)).toBe(24 * 60 * 60 * 1000);
      expect(notifyCalls).toEqual([{ ownerUserId: owner, requestId: answer.value.requestId }]);
      const audit = await latestAudit("node.ssh_grant.request");
      expect(audit.requestId).toBe(answer.value.requestId);
      expect(audit.paneId).toBe("pane-ask-1");
      expect(audit.aNodeId).toBe(NODE_A);
      expect(audit.bNodeId).toBe(NODE_B);
      expect(audit.destination).toBe(HOST);
    });

    it("a relaunch FINDS the pending row: same id, no second row, no second notify, no second audit", async () => {
      const first = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p1",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      clockMs += 60_000;
      const again = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p2",
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.requestId).toBe(first.value.requestId);
      expect(again.value.reused).toBe(true);
      expect(notifyCalls).toHaveLength(1);
      const rows = await db.selectFrom("sshGrantRequests").selectAll().execute();
      expect(rows).toHaveLength(1);
      const asks = await db
        .selectFrom("auditEvents")
        .select("id")
        .where("action", "=", "node.ssh_grant.request")
        .execute();
      expect(asks).toHaveLength(1);
    });

    it("survives a simulated restart: fresh deps (nothing else changed) still find the standing pending row", async () => {
      const first = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p1",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // "Restart": drop and reinstall the seam - only the DB remains.
      setSshGrantsDepsForTests(null);
      notifyCalls = [];
      installFakeDeps();
      const after = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p1",
      });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.requestId).toBe(first.value.requestId);
      expect(notifyCalls).toHaveLength(0);
    });
  });

  describe("approval cap and shape", () => {
    let requestRef = "";
    beforeEach(async () => {
      const asked = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p1",
      });
      if (asked.ok) requestRef = asked.value.requestId;
    });

    it("selecting more than SSH_MAX_GRANT_FINGERPRINTS keys is the named red error, never a truncation", async () => {
      const over = Array.from({ length: SSH_MAX_GRANT_FINGERPRINTS + 1 }, (_, i) => FP(i + 100));
      const refusal = await approveGrant({ ownerUserId: owner, requestId: requestRef, fingerprints: over });
      expect(refusal.ok).toBe(false);
      if (refusal.ok) return;
      expect(refusal.refusal).toMatchObject({ status: 400, code: BackendErrorCodes.SSH_GRANT_KEYS_OVER_LIMIT });
      // Nothing was written: the request still stands pending, no grant row.
      expect((await repo.getRequest(owner, requestRef))?.status).toBe("pending");
      expect(await db.selectFrom("sshKeyGrants").selectAll().execute()).toHaveLength(0);
    });

    it("a fingerprint outside the SHA256 grammar is refused by its own code; duplicates do not count twice", async () => {
      const bad = await approveGrant({
        ownerUserId: owner,
        requestId: requestRef,
        fingerprints: ["not-a-fingerprint"],
      });
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.refusal.code).toBe(BackendErrorCodes.SSH_GRANT_KEYS_INVALID);
      // 8 entries where 7 are the same key: the UNIQUE selection fits under the
      // cap, and the stored grant carries the deduped set.
      const dupes = [...FPS, FP(2), FP(2), FP(2), FP(2), FP(2), FP(2)];
      const eight = [...Array.from({ length: 8 }, (_, i) => FP(i + 200))];
      const deduped = await approveGrant({
        ownerUserId: owner,
        requestId: requestRef,
        fingerprints: dupes.slice(0, 7),
      });
      expect(deduped.ok).toBe(true);
      if (!deduped.ok) return;
      expect(new Set(deduped.value.grant.fingerprints).size).toBe(deduped.value.grant.fingerprints.length);
      // exactly 8 fits; 9 does not (recompute on a fresh request).
      await repo.markRequestStatus(owner, requestRef, "approved", "pending");
      await db.deleteFrom("sshKeyGrants").execute();
      const exact = await approveGrant({ ownerUserId: owner, requestId: requestRef, fingerprints: eight });
      expect(exact.ok).toBe(true);
      await db.deleteFrom("sshKeyGrants").execute();
      const one = await approveGrant({ ownerUserId: owner, requestId: requestRef, fingerprints: [...eight, FP(299)] });
      expect(one.ok).toBe(false);
    });

    it("approve writes the grant (createdVia first-use), answers the request, and audits COUNTS, never fingerprint strings", async () => {
      const approved = await approveGrant({
        ownerUserId: owner,
        requestId: requestRef,
        fingerprints: FPS,
        name: "work git",
      });
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.grant.createdVia).toBe("first-use");
      expect(approved.value.grant.fingerprints).toEqual(FPS);
      expect(approved.value.grant.resolvedSelector).toBe(HOST);
      expect(approved.value.grant.keyHomeNodeId).toBe(NODE_A);
      expect((await repo.getRequest(owner, requestRef))?.status).toBe("approved");
      const create = await latestAudit("node.ssh_grant.create");
      expect(create.fingerprintsCount).toBe(2);
      expect(create.via).toBe("first-use");
      const approve = await latestAudit("node.ssh_grant.approve");
      expect(approve.grantId).toBe(approved.value.grant.id);
      expect(approve.fingerprintsCount).toBe(2);
      // The Global Constraint, read off the WHOLE trail: no fingerprint VALUE
      // in any audit row this act wrote.
      const all = await db.selectFrom("auditEvents").select("metadataJson").execute();
      for (const row of all) {
        for (const fp of FPS) expect(row.metadataJson).not.toContain(fp);
      }
    });

    it("a second answer to the same request is the named 409 (a raced or repeat approver)", async () => {
      const first = await approveGrant({ ownerUserId: owner, requestId: requestRef, fingerprints: FPS });
      expect(first.ok).toBe(true);
      const second = await approveGrant({ ownerUserId: owner, requestId: requestRef, fingerprints: FPS });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.refusal.status).toBe(409);
    });

    it("a foreign owner's request is absent: 404, and the row stands unanswered", async () => {
      const denied = await denyGrant({ ownerUserId: stranger, requestId: requestRef });
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.refusal.status).toBe(404);
      expect((await repo.getRequest(owner, requestRef))?.status).toBe("pending");
    });

    it("deny writes the deny audit and NO grant; expiry sweeps pending rows and writes NOTHING", async () => {
      const denied = await denyGrant({ ownerUserId: owner, requestId: requestRef });
      expect(denied.ok).toBe(true);
      expect(await db.selectFrom("sshKeyGrants").selectAll().execute()).toHaveLength(0);
      expect((await repo.getRequest(owner, requestRef))?.status).toBe("denied");
      const audit = await latestAudit("node.ssh_grant.deny");
      expect(audit.requestId).toBe(requestRef);

      // Fresh ask, then push the clock past the deadline and sweep.
      await cleanTier();
      const asked = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p9",
      });
      expect(asked.ok).toBe(true);
      if (!asked.ok) return;
      const beforeSweep = await db.selectFrom("auditEvents").select("id").execute();
      clockMs += 24 * 60 * 60 * 1000 + 1_000;
      const swept = await sweepExpiredGrantRequests();
      expect(swept).toBe(1);
      expect((await repo.getRequest(owner, asked.value.requestId))?.status).toBe("expired");
      const afterSweep = await db.selectFrom("auditEvents").select("id").execute();
      expect(afterSweep).toHaveLength(beforeSweep.length); // expiry writes NOTHING
      // And an expired row no longer dedups: a relaunch asks a NEW question.
      notifyCalls = [];
      const again = await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p9",
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.requestId).not.toBe(asked.value.requestId);
      expect(notifyCalls).toHaveLength(1);
    });
  });

  describe("matchGrant", () => {
    async function grant(opts: {
      selector: string;
      fps?: string[];
      via?: "first-use" | "manual";
      at?: string;
    }): Promise<SshGrantView> {
      const created = await createGrant({
        ownerUserId: owner,
        aNodeId: NODE_A,
        name: "g",
        selector: opts.selector,
        fingerprints: opts.fps ?? FPS,
      });
      if (!created.ok) throw new Error("grant fixture refused");
      if (opts.at) {
        await db
          .updateTable("sshKeyGrants")
          .set({ createdAt: opts.at })
          .where("id", "=", created.value.grant.id)
          .execute();
      }
      return created.value.grant;
    }

    it("exact host matches; a glob matches under it; the other owner and the other key home never match", async () => {
      const exact = await grant({ selector: HOST });
      expect((await matchGrant({ ownerUserId: owner, aNodeId: NODE_A, resolvedHost: HOST }))?.id).toBe(exact.id);
      expect(await matchGrant({ ownerUserId: owner, aNodeId: NODE_A, resolvedHost: "other.example.test" })).toBeNull();
      const globs = await grant({ selector: "*.example.test" });
      await db.deleteFrom("sshKeyGrants").where("id", "=", exact.id).execute();
      expect(
        (await matchGrant({ ownerUserId: owner, aNodeId: NODE_A, resolvedHost: "deep.git.example.test" }))?.id,
      ).toBe(globs.id);
      expect(await matchGrant({ ownerUserId: stranger, aNodeId: NODE_A, resolvedHost: "git.example.test" })).toBeNull();
      expect(await matchGrant({ ownerUserId: owner, aNodeId: NODE_B, resolvedHost: HOST })).toBeNull();
    });

    it("most specific wins, and equal specificity ties to the OLDEST grant", async () => {
      await grant({ selector: "*.example.test", at: "2026-01-01T00:00:00.000Z" });
      const concrete = await grant({ selector: HOST, at: "2026-02-01T00:00:00.000Z" });
      expect((await matchGrant({ ownerUserId: owner, aNodeId: NODE_A, resolvedHost: HOST }))?.id).toBe(concrete.id);
      // Two matching selectors of EQUAL specificity (identical globs here):
      // the tie breaks to the older grant, §6.3's stated rule.
      await db.deleteFrom("sshKeyGrants").execute();
      const older = await grant({ selector: "*.example.test", at: "2026-01-01T00:00:00.000Z" });
      await grant({ selector: "*.example.test", at: "2026-02-01T00:00:00.000Z" });
      expect((await matchGrant({ ownerUserId: owner, aNodeId: NODE_A, resolvedHost: HOST }))?.id).toBe(older.id);
    });

    it("a matching grant makes the launch leg open the relay with the grant's facts and the STORED peers, and hand back the socket", async () => {
      const g = await grant({ selector: HOST });
      const leg = await prepareRelayLeg({
        viewerId: owner,
        aNode: { id: NODE_A, name: "key home" },
        bNodeId: NODE_B,
        resolvedHost: HOST,
        paneId: "pane-1",
      });
      expect(leg.ok).toBe(true);
      if (!leg.ok) return;
      expect(leg.value.grantId).toBe(g.id);
      expect(openCalls).toHaveLength(1);
      const call = openCalls[0] as Record<string, unknown>;
      expect(call.grantId).toBe(g.id);
      expect(call.fingerprints).toEqual(FPS);
      expect(call.paneId).toBe("pane-1");
      expect(call.aNode).toBe(NODE_A);
      expect(call.bNode).toBe(NODE_B);
      // The peer halves come from the identities store, not from the caller.
      expect((call.aPeer as Record<string, string>).signingPublicKey).toContain("CCC");
      expect((call.bPeer as Record<string, string>).encryptionPublicJwk).toContain("EEE");
      expect(typeof leg.value.socketPath).toBe("string");
    });

    it("NO grant: the leg asks (requestFirstUse), refuses with the named code, and NEVER opens", async () => {
      const leg = await prepareRelayLeg({
        viewerId: owner,
        aNode: { id: NODE_A, name: "key home" },
        bNodeId: NODE_B,
        resolvedHost: HOST,
        paneId: "pane-ask",
      });
      expect(leg.ok).toBe(false);
      if (leg.ok) return;
      expect(leg.refusal).toMatchObject({ status: 409, code: BackendErrorCodes.SSH_GRANT_APPROVAL_REQUIRED });
      expect(openCalls).toHaveLength(0);
      expect(notifyCalls).toHaveLength(1); // the ask happened exactly as first-use prescribes
      // The message names the machine and the remedy, never a key or secret.
      expect(leg.refusal.message).toContain("key home");
      expect(leg.refusal.message.toLowerCase()).toContain("approve");
    });

    it("a machine with no registered signing half refuses SSH_RELAY_IDENTITY_MISSING before anything opens", async () => {
      await grant({ selector: HOST });
      await db
        .updateTable("identities")
        .set({ signingPublicKey: null })
        .where("principalId", "=", `node:${NODE_B}`)
        .execute();
      const leg = await prepareRelayLeg({
        viewerId: owner,
        aNode: { id: NODE_A, name: "A" },
        bNodeId: NODE_B,
        resolvedHost: HOST,
        paneId: "p",
      });
      expect(leg.ok).toBe(false);
      if (leg.ok) return;
      expect(leg.refusal.code).toBe(BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING);
      expect(openCalls).toHaveLength(0);
      await db
        .updateTable("identities")
        .set({ signingPublicKey: '{"kty":"EC","crv":"P-256","x":"GGG","y":"HHH"}' })
        .where("principalId", "=", `node:${NODE_B}`)
        .execute();
    });

    it("the broker's refusal comes back as the named SSH_RELAY_OPEN_FAILED and launches nothing", async () => {
      await grant({ selector: HOST });
      installFakeDeps({
        openRelay: (async () => {
          throw new SshRelayRefusal("quota", "relay open refused: node already holds 8 live relay sessions (max 8)");
        }) as RelayBroker["openRelay"],
      });
      const leg = await prepareRelayLeg({
        viewerId: owner,
        aNode: { id: NODE_A, name: "A" },
        bNodeId: NODE_B,
        resolvedHost: HOST,
        paneId: "p",
      });
      expect(leg.ok).toBe(false);
      if (leg.ok) return;
      expect(leg.refusal.code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
    });

    it("a revoke landing MID-OPEN is caught by the post-open liveness re-check and the fresh session is cut, not orphaned (T8 NIT1)", async () => {
      const g = await grant({ selector: HOST });
      installFakeDeps({
        openRelay: (async (input: unknown) => {
          // The revoke's DB half lands between the match and the open.
          await db
            .deleteFrom("sshKeyGrants")
            .where("id", "=", (input as { grantId: string }).grantId)
            .execute();
          return {
            relayId: "r",
            ref: "f",
            expiresAt: "2026-10-08T00:00:30.000Z",
            socketPath: "/x/agent.sock",
          };
        }) as RelayBroker["openRelay"],
      });
      const leg = await prepareRelayLeg({
        viewerId: owner,
        aNode: { id: NODE_A, name: "A" },
        bNodeId: NODE_B,
        resolvedHost: HOST,
        paneId: "p",
      });
      expect(leg.ok).toBe(false);
      if (leg.ok) return;
      expect(leg.refusal.code).toBe(BackendErrorCodes.SSH_GRANT_APPROVAL_REQUIRED);
      expect(closeGrantCalls).toEqual([{ grantId: g.id, reason: "grant-revoked" }]);
    });
  });

  describe("the grants screen and revoke", () => {
    it("create validates the selector and stores it normalized", async () => {
      expect(normalizeSshGrantSelector("  Git.Example.TEST  ")).toBe("git.example.test");
      expect(normalizeSshGrantSelector("*")).toBeNull(); // names nothing concrete
      expect(normalizeSshGrantSelector("a b")).toBeNull();
      expect(normalizeSshGrantSelector("bad\nhost")).toBeNull();
      expect(normalizeSshGrantSelector("**a**")).toBeNull(); // doubled wildcards are not a host pattern
      expect(normalizeSshGrantSelector(".example.test")).toBeNull();
      const refused = await createGrant({
        ownerUserId: owner,
        aNodeId: NODE_A,
        name: "n",
        selector: "bad host",
        fingerprints: FPS,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.refusal.status).toBe(400);
    });

    it("the selector matcher treats * as the only wildcard and lowercases the host", () => {
      expect(sshGrantSelectorMatches("*.example.test", "GIT.EXAMPLE.TEST")).toBe(true);
      expect(sshGrantSelectorMatches("git.*.test", "git.example.test")).toBe(true);
      expect(sshGrantSelectorMatches("git.example.test", "evilgit.example.test")).toBe(false);
      expect(sshGrantSelectorMatches("a.b", "axb")).toBe(false); // the DOT is literal, not the regex dot
    });

    it("update edits name and selector and audits the change (no fingerprint rewrite path exists)", async () => {
      const created = await createGrant({
        ownerUserId: owner,
        aNodeId: NODE_A,
        name: "one",
        selector: HOST,
        fingerprints: FPS,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const updated = await updateGrant({
        ownerUserId: owner,
        grantId: created.value.grant.id,
        selector: "*.example.test",
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.grant.resolvedSelector).toBe("*.example.test");
      expect(updated.value.grant.fingerprints).toEqual(FPS); // selection is immutable through edit
      const audit = await latestAudit("node.ssh_grant.update");
      expect(audit.grantId).toBe(created.value.grant.id);
      expect(audit.fingerprintsCount).toBe(2);
    });

    it("revoke deletes the row, cuts every live relay through closeForGrant, and audits the count", async () => {
      const created = await createGrant({
        ownerUserId: owner,
        aNodeId: NODE_A,
        name: "revoke me",
        selector: HOST,
        fingerprints: FPS,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const revoked = await revokeGrant({ ownerUserId: owner, grantId: created.value.grant.id });
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(closeGrantCalls).toEqual([{ grantId: created.value.grant.id, reason: "grant-revoked" }]);
      expect(await repo.getGrant(owner, created.value.grant.id)).toBeUndefined();
      const audit = await latestAudit("node.ssh_grant.delete");
      expect(audit.grantId).toBe(created.value.grant.id);
      expect(audit.relaysClosed).toBe(1);
      // A foreign id is the same 404 as an absent one, and cuts nothing.
      closeGrantCalls = [];
      const foreign = await revokeGrant({ ownerUserId: stranger, grantId: created.value.grant.id });
      expect(foreign.ok).toBe(false);
      if (foreign.ok) return;
      expect(foreign.refusal.status).toBe(404);
      expect(closeGrantCalls).toHaveLength(0);
    });

    it("the queue read reports only the caller's rows", async () => {
      await requestFirstUse({
        ownerUserId: owner,
        aNodeId: NODE_A,
        bNodeId: NODE_B,
        resolvedSelector: HOST,
        paneId: "p",
      });
      expect((await listGrantRequests({ ownerUserId: owner })).length).toBe(1);
      expect((await listGrantRequests({ ownerUserId: stranger })).length).toBe(0);
    });
  });
});
