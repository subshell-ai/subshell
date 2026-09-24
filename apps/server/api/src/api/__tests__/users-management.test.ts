import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { usersRoutes } from "@/api/users.route.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { setAuthPolicyDb } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { subscribeLive } from "@/services/live-bus.js";
import {
  attachConnection,
  getLive,
  type NodeSocket,
  OWNER_DISABLED_CLOSE_CODE,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { registerLiveSocket, resetLiveRegistryForTests } from "@/ws/live-registry.js";
import { registerViewer, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";
import { clearWsTokensForTests, consumeWsToken, issueWsToken } from "@/ws/ws-token.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Admin user management: role assignment and password reset.
 *
 * Both are credential-grade surfaces, so the guards get more attention here
 * than the happy paths:
 *
 * - the LAST admin cannot be demoted, or the instance is left with nobody who
 *   can administer it and only `SUBSHELL_EMERGENCY_PASSWORD` to recover;
 * - a reset REVOKES the target's sessions, because a reset is usually an
 *   answer to "this account may be compromised" and live cookies would make
 *   it useless;
 * - an admin cannot reset their OWN password here, which would turn an
 *   unlocked laptop into a takeover with no knowledge of the current password;
 * - the `system` service account is untouchable;
 * - machine credentials never reach any of it.
 */
describe("admin user management", () => {
  const pw = "user-mgmt-pass-1";
  const adminEmail = `um-admin-${crypto.randomUUID()}@subshell.local`;
  const admin2Email = `um-admin2-${crypto.randomUUID()}@subshell.local`;
  const memberEmail = `um-member-${crypto.randomUUID()}@subshell.local`;
  let adminId: string;
  let admin2Id: string;
  let memberId: string;
  let adminCookie: string;
  let memberCookie: string;
  let systemId: string;
  /** A REAL, valid bearer key owned by the admin — see the bearer test. */
  let adminBearerKey: string;
  /** The same, owned by the MEMBER — the credential a disable has to kill. */
  let memberBearerKey: string;
  const subshellId = `um-sub-${crypto.randomUUID()}`;
  const memberSubshellId = `um-sub-member-${crypto.randomUUID()}`;

  const users = new UsersRepository(db);
  const meta = new UserMetaRepository(db);
  const nodes = new NodesRepository(db);

  async function mkUser(email: string, role: "admin" | "user"): Promise<string> {
    return await users.createUser({ email, name: email, passwordHash: await hashPassword(pw), role });
  }

  beforeAll(async () => {
    await setupAuthTables();
    // The disabled gate lives in a better-auth `session.create.before` hook,
    // which reads the app database through this injection. Production wires
    // it at boot (`index.ts`); only one other suite does, so a file that
    // depends on the gate must not depend on that file having run first.
    setAuthPolicyDb(db);
    systemId = await ensureSystemUser();
    adminId = await mkUser(adminEmail, "admin");
    admin2Id = await mkUser(admin2Email, "admin");
    memberId = await mkUser(memberEmail, "user");
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);

    // A VALID key, owned by an admin. A bogus string would be 401'd by
    // authGuard before requireAdmin's cookie-only check ever ran, so it would
    // assert nothing about the rule that actually matters here: a machine
    // credential is refused even when its owner IS an admin.
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "user-mgmt-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminBearerKey = await issueSubshellToken(subshellId, adminId);
    await new SubshellsRepository(db).create({
      id: memberSubshellId,
      userId: memberId,
      presetId: "p",
      harnessId: "claude-code",
      name: "user-mgmt-test-member",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    memberBearerKey = await issueSubshellToken(memberSubshellId, memberId);
  });

  beforeEach(async () => {
    // Every case starts from two admins and one member, so a test that changes
    // roles cannot decide the next one's outcome.
    await meta.upsert({ userId: adminId, role: "admin" });
    await meta.upsert({ userId: admin2Id, role: "admin" });
    await meta.upsert({ userId: memberId, role: "user" });
    // ...and from an ENABLED member. A disable refuses the very sign-in two
    // lines down, so leaving one set would turn every later case in the file
    // into a failure of this helper rather than of what it tests.
    await meta.setDisabled(memberId, false);
    await meta.setDisabled(admin2Id, false);
    // ...and from a known password with live sessions. A reset REVOKES the
    // target's sessions by design, so without this the first reset test
    // silently 401s every later case that signs in as the member — the
    // feature working correctly would look like a broken test suite.
    await users.setPassword(memberId, await hashPassword(pw));
    // A refused sign-in is a 401 to the rate-limit wrapper, which records a
    // failure and makes the NEXT attempt for that email sleep. Clearing the
    // counter keeps the disabled-sign-in cases from paying each other's
    // backoff.
    await db.deleteFrom("authAttempts").where("email", "=", memberEmail).execute();
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    await db.deleteFrom("subshells").where("id", "=", memberSubshellId).execute();
    for (const email of [adminEmail, admin2Email, memberEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, cookie: string | null, body?: unknown, bearer?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return usersRoutes.fetch(
      new Request(`http://localhost:3080/api/users${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  describe("role assignment", () => {
    it("drops that user's live sockets, so their next connect re-derives its topics", async () => {
      // A live socket chooses its topics ONCE, at connect, and a WebSocket is
      // never re-authenticated — so a demoted admin with a dashboard tab open
      // would go on receiving every subshell on the instance for as long as
      // that tab lived. The registry is tested in isolation; what nothing
      // asserted is that this ROUTE calls it, which is the seam that drifts
      // while both halves stay green.
      resetLiveRegistryForTests();
      const closes: number[] = [];
      registerLiveSocket(admin2Id, {
        data: {},
        send: () => 1,
        close: (code?: number) => {
          closes.push(code ?? 0);
        },
      });

      const res = await req("PATCH", `/${admin2Id}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(200);
      // Closed, and BELOW 4000 — the client reads the 4xxx range as a refusal
      // to report and anything under it as a connection to retry, so this
      // reconnects silently instead of surfacing as an error.
      expect(closes).toHaveLength(1);
      expect(closes[0]).toBeLessThan(4000);
      resetLiveRegistryForTests();
    });

    it("promotes a member to admin", async () => {
      const res = await req("PATCH", `/${memberId}/role`, adminCookie, { role: "admin" });
      expect(res.status).toBe(200);
      expect(await meta.getRole(memberId)).toBe("admin");
    });

    it("demotes an admin while another remains", async () => {
      const res = await req("PATCH", `/${admin2Id}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(200);
      expect(await meta.getRole(admin2Id)).toBe("user");
    });

    it("refuses an admin changing their OWN role, even with another admin around", async () => {
      // The rule changed: self-demotion used to be allowed while another
      // admin remained. An admin who removes their own administration by
      // accident cannot undo it — there is no self-service path here the way
      // Account is one for passwords — and on a single-admin instance nobody
      // else can either. So it is refused outright and another admin does it.
      const res = await req("PATCH", `/${adminId}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Another admin");
      expect(await meta.getRole(adminId)).toBe("admin");
    });

    it("refuses to demote the LAST admin", async () => {
      // Asserted against the REPOSITORY rather than the route, and that is a
      // consequence of the self-refusal above rather than a weaker test. The
      // route can no longer reach this branch at all: the caller is always an
      // admin, and a target who is a DIFFERENT admin means there are at least
      // two — so the only way to aim at the last one is to aim at yourself,
      // which is now a 400 before this guard is consulted. The guard still
      // matters, and the concurrency case below is what can still reach it.
      //
      // Every test file in this invocation shares one database, so other
      // suites' admins are present and `countAdmins()` is not this test's to
      // assume. Stand every OTHER admin down for the duration and put them
      // back afterwards, so the case is about the rule rather than about what
      // else happens to be in the table.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await countAdmins()).toBe(1);
        expect(await meta.setRole(adminId, "user")).toBe(false);
        // ...and the role is untouched, so the refusal is not partial.
        expect(await meta.getRole(adminId)).toBe("admin");
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("refuses a SELF write that would change nothing, before the no-op path", async () => {
      // Same rule-change as above, and the ordering is the point: the refusal
      // sits BEFORE the no-op early return, so writing "admin" over "admin"
      // on yourself is refused rather than quietly reported as a success. A
      // self write that appears to work is how someone learns the control is
      // theirs to use.
      const res = await req("PATCH", `/${adminId}/role`, adminCookie, { role: "admin" });
      expect(res.status).toBe(400);
      expect(await meta.getRole(adminId)).toBe("admin");
    });

    it("still allows re-asserting the last admin's own role", async () => {
      // Only a DEMOTION can strand the instance; writing "admin" over "admin"
      // must not trip the guard. At the repository, for the same reason the
      // last-admin case above is: the route refuses a self write first.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await meta.setRole(adminId, "admin")).toBe(true);
        expect(await meta.getRole(adminId)).toBe("admin");
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("survives concurrent demotions with exactly one admin left standing", async () => {
      // The guard's reason for existing. Two admins demoting each other must
      // not both read "2 admins" and both succeed.
      //
      // It holds for a reason worth writing down: `bun:sqlite` is SYNCHRONOUS
      // and the dialect hands out one shared connection, so the awaits inside
      // `setRole`'s transaction never actually yield between its SELECT and
      // its write — the transactions serialize in practice. Measured here
      // rather than assumed: eight concurrent demotions, repeated, always
      // leave exactly one admin and never throw. If the dialect ever becomes
      // truly async or pooled, this test is what will notice.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      const ids = [adminId, admin2Id, memberId];
      try {
        for (const id of ids) await meta.upsert({ userId: id, role: "admin" });
        const results = await Promise.allSettled(ids.map((id) => meta.setRole(id, "user")));

        // No throws: a loser must get an orderly refusal, not a 500.
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
        const refused = results.filter((r) => r.status === "fulfilled" && r.value === false);
        expect(refused).toHaveLength(1);
        expect(await countAdmins()).toBe(1);
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("refuses to touch the system service account", async () => {
      // 403, not 400: the body is valid, the caller simply may not.
      const res = await req("PATCH", `/${systemId}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(403);
    });

    it("upserts a role over a user with no user_meta row at all", async () => {
      // `listWithRoles` returns role: null for such a user, so the state is
      // reachable — and a bare UPDATE would silently no-op, leaving the admin
      // believing they had granted something.
      const orphanEmail = `um-orphan-${crypto.randomUUID()}@subshell.local`;
      const orphanId = await mkUser(orphanEmail, "user");
      await db.deleteFrom("userMeta").where("userId", "=", orphanId).execute();
      expect(await meta.getRole(orphanId)).toBeNull();
      try {
        const res = await req("PATCH", `/${orphanId}/role`, adminCookie, { role: "admin" });
        expect(res.status).toBe(200);
        expect(await meta.getRole(orphanId)).toBe("admin");
      } finally {
        await deleteUserByEmailOrId(orphanEmail);
      }
    });

    it("404s an unknown user", async () => {
      expect((await req("PATCH", `/${crypto.randomUUID()}/role`, adminCookie, { role: "user" })).status).toBe(404);
    });

    it("refuses a non-admin (403) and an anonymous caller (401)", async () => {
      expect((await req("PATCH", `/${memberId}/role`, memberCookie, { role: "admin" })).status).toBe(403);
      expect((await req("PATCH", `/${memberId}/role`, null, { role: "admin" })).status).toBe(401);
    });

    it("refuses an ADMIN'S OWN valid bearer key with 403", async () => {
      // The invariant: machine credentials cannot manage the instance even
      // when the human behind them is an admin. Exactly 403 — a 401 would mean
      // the key was merely unrecognised and the rule went untested.
      const res = await req("PATCH", `/${memberId}/role`, null, { role: "admin" }, adminBearerKey);
      expect(res.status).toBe(403);
      expect(await meta.getRole(memberId)).toBe("user");
    });
  });

  describe("create", () => {
    it("rejects a short password without quoting it back", async () => {
      // The pre-existing create route carried the same schema-level bound and
      // therefore the same echo; fixed with it.
      const rejected = "tiny";
      const res = await req("POST", "/", adminCookie, {
        name: "Um New",
        email: `um-new-${crypto.randomUUID()}@subshell.local`,
        password: rejected,
        role: "user",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(rejected);
    });

    it("normalizes the display name before storing it", async () => {
      // A display name is not the admin's private label: it is rendered to
      // every user a subshell is shared with (`granteeName`) and it reaches
      // log lines, so it goes through the same `normalizeLabel` node names
      // and the instance name do. CR/LF is the pair that matters — untouched,
      // it forges a second line in a log record.
      const email = `um-norm-${crypto.randomUUID()}@subshell.local`;
      try {
        const res = await req("POST", "/", adminCookie, {
          name: "  Um\r\n Norm\u0007alized  ",
          email,
          password: "um-normalize-pass-1",
          role: "user",
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { name: string }).name).toBe("Um Norm alized");
        // ...and what was STORED is the cleaned value, not just what the
        // response reported.
        const row = (await users.listWithRoles()).find((u) => u.email === email);
        expect(row?.name).toBe("Um Norm alized");
      } finally {
        await deleteUserByEmailOrId(email);
      }
    });

    it("refuses a name with nothing printable in it, and creates nobody", async () => {
      const email = `um-blank-${crypto.randomUUID()}@subshell.local`;
      const res = await req("POST", "/", adminCookie, {
        name: "\r\n\t \u0007",
        email,
        password: "um-normalize-pass-1",
        role: "user",
      });
      expect(res.status).toBe(400);
      // Same refusal a name of pure spaces gets (pinned in users-admin.test.ts):
      // control characters are not content either.
      expect(await res.text()).toContain("Name is required.");
      expect((await users.listWithRoles()).some((u) => u.email === email)).toBe(false);
    });

    it("refuses an over-long name without quoting it back", async () => {
      // Refused rather than silently truncated: an admin who typed it can fix
      // it, and a name shortened behind their back is the kind of surprise
      // that shows up later as "why does this share say that". The 400 says
      // the bound and never the value — the same rule the password case above
      // pins, for the same reason.
      const rejected = "Q".repeat(200);
      const email = `um-long-${crypto.randomUUID()}@subshell.local`;
      const res = await req("POST", "/", adminCookie, {
        name: rejected,
        email,
        password: "um-normalize-pass-1",
        role: "user",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(rejected);
      expect((await users.listWithRoles()).some((u) => u.email === email)).toBe(false);
    });
  });

  describe("disable", () => {
    it("disables a user and reports how many sessions it cut", async () => {
      const before = await sessionCount(memberId);
      expect(before).toBeGreaterThan(0);

      const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; email: string; disabled: boolean; sessionsRevoked: number };
      expect(body).toEqual({ id: memberId, email: memberEmail, disabled: true, sessionsRevoked: before });
      // A disable that leaves live cookies behind does nothing: the account is
      // supposed to stop authenticating, not to stop authenticating LATER.
      expect(await sessionCount(memberId)).toBe(0);
      expect(await meta.isDisabled(memberId)).toBe(true);
    });

    it("drops the user's live sockets, so a disabled account stops streaming", async () => {
      // The gap the demotion test above closes, on the STRONGER act: a live
      // socket authenticates at connect and is never re-checked, so revoking
      // the session rows left an open dashboard tab streaming its whole feed.
      // The registry mechanism is tested in isolation; this pins that the
      // DISABLE route reaches it — the seam that drifts while both halves
      // stay green.
      resetLiveRegistryForTests();
      const closes: number[] = [];
      registerLiveSocket(memberId, {
        data: {},
        send: () => 1,
        close: (code?: number) => {
          closes.push(code ?? 0);
        },
      });

      const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      expect(res.status).toBe(200);
      expect(closes).toHaveLength(1);
      // BELOW 4000, like the demotion drop: the client reads the 4xxx range
      // as a refusal to report and anything under it as a connection to
      // retry. The retry cannot get far while the flag is set — minting a
      // ws-token runs through authGuard, which 401s a disabled account — so
      // this drop plus that gate is the whole closure.
      expect(closes[0]).toBeLessThan(4000);
      resetLiveRegistryForTests();
    });

    /**
     * A fake open terminal attach, registered the way both attach paths do
     * it: `registerViewer` with a `viewerId`, and the `attachUserId` the
     * attach resolved (see `ws/attach-resolve.ts`). The close records instead
     * of tearing down — the walk under test only needs to reach the socket.
     */
    function terminalViewer(userId: string, viewerId: string) {
      const closed: { code?: number; reason?: string }[] = [];
      const ws = {
        data: { viewerId, attachUserId: userId },
        send: () => 1,
        close: (code?: number, reason?: string) => {
          closed.push({ code, reason });
        },
      } as unknown as WsSocket;
      return { ws, closed };
    }

    it("closes the user's open TERMINAL attaches too, shared panes included", async () => {
      // The live-feed drop above left a gap: a browser terminal authenticates
      // at connect and is never re-checked either, and it lives in
      // `liveViewers`, not the feed registry. A disabled member with a pane
      // open kept streaming it. The walk is keyed by WHO attached, so it
      // finds the socket on a pane the member does not own (the shared one
      // below) and leaves the OTHER viewer of the member's own pane attached
      // — the disable is the member's, not the bystander's.
      resetLiveViewersForTests();
      const ownPane = terminalViewer(memberId, "um-tv-own");
      const sharedPane = terminalViewer(memberId, "um-tv-shared");
      const bystander = terminalViewer(adminId, "um-tv-bystander");
      registerViewer(ownPane.ws, "um-sub-member-x");
      registerViewer(bystander.ws, "um-sub-member-x");
      registerViewer(sharedPane.ws, "um-sub-admin-x");
      try {
        const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
        expect(res.status).toBe(200);
        expect(ownPane.closed).toEqual([{ code: 1012, reason: "account disabled" }]);
        expect(sharedPane.closed).toEqual([{ code: 1012, reason: "account disabled" }]);
        expect(bystander.closed).toEqual([]);

        const rows = await db
          .selectFrom("auditEvents")
          .select(["metadataJson"])
          .where("action", "=", "user.disabled_change")
          .where("targetId", "=", memberId)
          .execute();
        expect(rows.at(-1)?.metadataJson ?? "").toContain('"terminalSocketsClosed":2');
      } finally {
        resetLiveViewersForTests();
        await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      }
    });

    it("revokes ws-tokens minted before the disable, so a redemption cannot rebuild the socket", async () => {
      // The second half of the same gap: the sweep closes what is open, but a
      // token minted inside its 30 s life and redeemed AFTER the sweep would
      // re-create exactly the attach the disable ended. Redemption must fail
      // like any unknown token's — and a token naming a DIFFERENT account
      // (here the admin's) stays good.
      const memberToken = issueWsToken(memberId);
      const memberScoped = issueWsToken(memberId, "um-sub-member-x");
      const adminToken = issueWsToken(adminId);
      try {
        const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
        expect(res.status).toBe(200);
        expect(consumeWsToken(memberToken)).toBeNull();
        expect(consumeWsToken(memberScoped)).toBeNull();
        expect(consumeWsToken(adminToken)).not.toBeNull();

        const rows = await db
          .selectFrom("auditEvents")
          .select(["metadataJson"])
          .where("action", "=", "user.disabled_change")
          .where("targetId", "=", memberId)
          .execute();
        expect(rows.at(-1)?.metadataJson ?? "").toContain('"tokensRevoked":2');
      } finally {
        clearWsTokensForTests();
        await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      }
    });

    it("drops no terminal sockets and no tokens on RE-ENABLING — parity with the feed rule", async () => {
      // The re-enable edge drops live sockets (the test above pins it) and
      // the same reasoning covers the new two: while the flag stood the
      // account could not mint a ws-token, so nothing is open or outstanding
      // that a re-enable could invalidate. Pinning WHICH edge drops keeps the
      // rule deliberate on all three stores.
      resetLiveViewersForTests();
      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      const open = terminalViewer(memberId, "um-tv-back");
      registerViewer(open.ws, "um-sub-member-x");
      const minted = issueWsToken(memberId);
      try {
        const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
        expect(res.status).toBe(200);
        expect(open.closed).toEqual([]);
        expect(consumeWsToken(minted)).not.toBeNull();

        const rows = await db
          .selectFrom("auditEvents")
          .select(["metadataJson"])
          .where("action", "=", "user.disabled_change")
          .where("targetId", "=", memberId)
          .execute();
        const meta = rows.at(-1)?.metadataJson ?? "";
        // The disable-edge counts are ABSENT from the re-enable row, exactly
        // as `nodesDisconnected` is — the keys belong to the act that cuts.
        expect(meta).not.toContain("terminalSocketsClosed");
        expect(meta).not.toContain("tokensRevoked");
      } finally {
        clearWsTokensForTests();
        resetLiveViewersForTests();
      }
    });

    it("disconnects the user's enrolled nodes with the named close, and nobody else's", async () => {
      // Operator ruling 2026-09-24: disabling an account takes its enrolled
      // nodes offline too. This is the LIVE half — `authenticateNodeUpgrade`
      // (pinned in `node-ws-handler.test.ts` and the integration wire test)
      // keeps them out until re-enable, and the agent's own backoff loop
      // reconnects within one interval (≤ 60 s) once the flag clears. Here the
      // seam that could drift while both halves stay green is the ROUTE
      // reaching the registry: the close code, the reason, the eviction, and
      // the refusal to touch another owner's node.
      resetNodeRegistryForTests();
      const mine = `um-node-${crypto.randomUUID()}`;
      const theirs = `um-node-${crypto.randomUUID()}`;
      await nodes.create({ id: mine, ownerUserId: memberId, name: "um-mine", kind: "agent", status: "online" });
      await nodes.create({ id: theirs, ownerUserId: adminId, name: "um-theirs", kind: "agent", status: "online" });
      const closes: { code?: number; reason?: string }[] = [];
      const mineSocket: NodeSocket = {
        send: () => 1,
        close: (code?: number, reason?: string) => {
          closes.push({ code, reason });
        },
      };
      const theirsSocket: NodeSocket = { send: () => 1, close: () => {} };
      attachConnection(mine, mineSocket);
      attachConnection(theirs, theirsSocket);
      try {
        const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
        expect(res.status).toBe(200);
        // The close reason the agent relays to its own log — the machine says
        // WHY it is sitting outside.
        expect(closes).toEqual([{ code: OWNER_DISABLED_CLOSE_CODE, reason: "the node's owner account is disabled" }]);
        expect(getLive(mine)).toBeUndefined();
        // The other owner's socket is not the disable's business.
        expect(getLive(theirs)).toBeDefined();
      } finally {
        await db.deleteFrom("nodes").where("id", "in", [mine, theirs]).execute();
        resetNodeRegistryForTests();
      }
    });

    it("projects the disconnected node offline at once, and re-announces its running panes", async () => {
      // The close + eviction is only HALF of "takes its nodes offline": the
      // registry entry dies BEFORE the socket's close event lands, so the
      // close handler's identity guard skips and the projection it owns —
      // the `nodes.status` write and the presence announce — never happened.
      // The Nodes page stayed green and the live feed kept claiming healthy
      // panes until the stale sweep (~105 s), contradicting this dialog's
      // own copy. The fix is at the shared seam (`disconnectNode` projects);
      // this pins that the disable route gets it: the row flips offline by
      // the RESPONSE — no timer waiting — and the running pane is announced.
      resetNodeRegistryForTests();
      const mine = `um-node-${crypto.randomUUID()}`;
      await nodes.create({ id: mine, ownerUserId: memberId, name: "um-mine", kind: "agent", status: "online" });
      const pane = await new SubshellsRepository(db).create({
        id: `um-pane-${crypto.randomUUID()}`,
        userId: memberId,
        presetId: "p",
        harnessId: "claude-code",
        name: "um-pane",
        workingDir: "/tmp",
        tmuxSocket: null,
        nodeId: mine,
        status: "running",
      });
      const changed: string[] = [];
      const off = subscribeLive((e) => {
        if (e.kind === "subshell.changed") changed.push(e.id);
      });
      attachConnection(mine, { send: () => 1, close: () => {} });
      try {
        const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
        expect(res.status).toBe(200);
        // The projection is awaited inside `disconnectNode`, which the route
        // awaits: by the time the answer is 200, the row says offline.
        expect((await nodes.findById(mine))?.status).toBe("offline");
        // The announce is best-effort and never awaited by the eviction —
        // the same rule the socket paths keep — so a tick is its whole delay.
        await new Promise((r) => setTimeout(r, 20));
        expect(changed).toContain(pane.id);
      } finally {
        off();
        await db.deleteFrom("subshells").where("id", "=", pane.id).execute();
        await db.deleteFrom("nodes").where("id", "=", mine).execute();
        resetNodeRegistryForTests();
        await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      }
    });

    it("drops no sockets on RE-ENABLING — the drop belongs to the disable edge", async () => {
      // Re-enabling re-grants nothing a socket could hold wrongly: while the
      // flag was set the account could not mint a ws-token, so no live socket
      // survives to invalidate. Pinning WHICH edge drops keeps the rule
      // deliberate rather than a blind both-ways call.
      resetLiveRegistryForTests();
      const closes: number[] = [];
      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      registerLiveSocket(memberId, {
        data: {},
        send: () => 1,
        close: (code?: number) => {
          closes.push(code ?? 0);
        },
      });

      const res = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      expect(res.status).toBe(200);
      expect(closes).toEqual([]);
      resetLiveRegistryForTests();
    });

    it("stops the user signing in, and re-enabling brings them back", async () => {
      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });

      const refused = await attemptSignIn(memberEmail, pw);
      // 401: better-auth refuses to mint the session at all. The hook sits on
      // session creation, so passkey sign-in is refused by the same rule.
      expect(refused.status).toBe(401);
      expect(await sessionCount(memberId)).toBe(0);

      const back = await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      expect(back.status).toBe(200);
      expect(((await back.json()) as { sessionsRevoked: number }).sessionsRevoked).toBe(0);
      // Re-enabling restores sign-in — otherwise a disable is one-way.
      await db.deleteFrom("authAttempts").where("email", "=", memberEmail).execute();
      const allowed = await attemptSignIn(memberEmail, pw);
      expect(allowed.status).toBe(200);
    });

    it("refuses a disabled user's BEARER key, not just their cookie", async () => {
      // The half that is not redundant with session revocation: a subshell
      // running when its owner was disabled still holds a valid key, and
      // without the guard's check it would keep working — which would make
      // "disabled" untrue of the account.
      const listAsMember = () =>
        usersRoutes.fetch(
          new Request("http://localhost:3080/api/users", {
            headers: { authorization: `Bearer ${memberBearerKey}` },
          }),
        );
      expect((await listAsMember()).status).toBe(200);

      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      // 401, not 403: the credential is not one this instance honours any
      // more, rather than one that lacks a permission.
      expect((await listAsMember()).status).toBe(401);

      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: false });
      expect((await listAsMember()).status).toBe(200);
    });

    it("refuses the caller disabling their OWN account", async () => {
      const res = await req("PATCH", `/${adminId}/disabled`, adminCookie, { disabled: true });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Another admin");
      expect(await meta.isDisabled(adminId)).toBe(false);
    });

    it("refuses the system service account", async () => {
      expect((await req("PATCH", `/${systemId}/disabled`, adminCookie, { disabled: true })).status).toBe(403);
    });

    it("refuses to disable the LAST admin who can still sign in", async () => {
      // At the repository, for the same reason the last-admin ROLE case is:
      // the route cannot reach this branch. Its caller is always an enabled
      // admin, so a target who is a different enabled admin means there are
      // at least two — and aiming at yourself is a 400 first. The guard is
      // still what stands between two concurrent disables and an instance
      // nobody can administer.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await countAdmins()).toBe(1);
        expect(await meta.setDisabled(adminId, true)).toEqual({ ok: false, reason: "last_admin" });
        expect(await meta.isDisabled(adminId)).toBe(false);
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("counts only ENABLED admins, since a disabled one cannot administer", async () => {
      // Two admins, one of them already disabled: the other is the last one
      // who can actually sign in, so disabling them is refused even though a
      // naive count of `role = 'admin'` rows would read two.
      const others = await otherAdminIds(adminId).then((ids) => ids.filter((id) => id !== admin2Id));
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await meta.setDisabled(admin2Id, true)).toEqual({ ok: true, sessionsRevoked: 0 });
        expect(await meta.setDisabled(adminId, true)).toEqual({ ok: false, reason: "last_admin" });
      } finally {
        await meta.setDisabled(admin2Id, false);
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("never refuses re-enabling, even for the last admin", async () => {
      // Undoing a disable has to stay possible unconditionally: it can only
      // widen access, and a disable nobody can reverse is a locked instance.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await meta.setDisabled(adminId, false)).toEqual({ ok: true, sessionsRevoked: 0 });
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("survives concurrent disables with one enabled admin left standing", async () => {
      // The guard's reason for existing, and the one path the route CAN
      // reach: two admins disabling each other at the same moment must not
      // both read "2 enabled admins" and both succeed.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      const ids = [adminId, admin2Id, memberId];
      try {
        for (const id of ids) await meta.upsert({ userId: id, role: "admin" });
        const results = await Promise.allSettled(ids.map((id) => meta.setDisabled(id, true)));

        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
        const refused = results.filter((r) => r.status === "fulfilled" && r.value.ok === false);
        expect(refused).toHaveLength(1);
        expect(await enabledAdminCount()).toBe(1);
      } finally {
        for (const id of ids) await meta.setDisabled(id, false);
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("audits the change naming the subject — the management family's convention", async () => {
      await req("PATCH", `/${memberId}/disabled`, adminCookie, { disabled: true });
      const rows = await db
        .selectFrom("auditEvents")
        .select(["action", "metadataJson"])
        .where("action", "=", "user.disabled_change")
        .where("targetId", "=", memberId)
        .execute();
      expect(rows.length).toBeGreaterThan(0);
      // The user-management family (create/role/reset/disable) names its
      // subject by email — admins already see every email via
      // `GET /api/users`, so the trail's audience gains nothing new and
      // answers "who" without a join. The never-values rule belongs to the
      // credential family: key text and auth-event values, never metadata.
      expect(rows.at(-1)?.metadataJson ?? "").toContain(memberEmail);
      expect(rows.at(-1)?.metadataJson ?? "").toContain('"disabled":true');
      // The socket drop is counted in the audit row, exactly as the
      // demotion's is — "an operator can reconstruct what was cut" is the
      // whole reason these rows exist.
      expect(rows.at(-1)?.metadataJson ?? "").toContain('"droppedSockets"');
    });

    it("404s an unknown user", async () => {
      expect((await req("PATCH", `/${crypto.randomUUID()}/disabled`, adminCookie, { disabled: true })).status).toBe(
        404,
      );
    });

    it("refuses a non-admin, an anonymous caller, and a bearer key", async () => {
      expect((await req("PATCH", `/${adminId}/disabled`, memberCookie, { disabled: true })).status).toBe(403);
      expect((await req("PATCH", `/${memberId}/disabled`, null, { disabled: true })).status).toBe(401);
      const bearer = await req("PATCH", `/${memberId}/disabled`, null, { disabled: true }, adminBearerKey);
      expect(bearer.status).toBe(403);
      expect(await meta.isDisabled(memberId)).toBe(false);
    });
  });

  describe("roster", () => {
    it("marks the system account unmanageable so the UI offers no doomed control", async () => {
      const res = await usersRoutes.fetch(
        new Request("http://localhost:3080/api/users", {
          headers: { cookie: `better-auth.session_token=${adminCookie}` },
        }),
      );
      const body = (await res.json()) as { users: { id: string; manageable: boolean; disabled: boolean }[] };
      expect(body.users.find((u) => u.id === systemId)?.manageable).toBe(false);
      expect(body.users.find((u) => u.id === memberId)?.manageable).toBe(true);
      // The roster carries the flag, so the UI never has to ask per user.
      expect(body.users.find((u) => u.id === memberId)?.disabled).toBe(false);
      await meta.setDisabled(memberId, true);
      const after = (await (
        await usersRoutes.fetch(
          new Request("http://localhost:3080/api/users", {
            headers: { cookie: `better-auth.session_token=${adminCookie}` },
          }),
        )
      ).json()) as { users: { id: string; disabled: boolean }[] };
      expect(after.users.find((u) => u.id === memberId)?.disabled).toBe(true);
    });
  });

  describe("password reset", () => {
    it("sets a password the user can actually sign in with", async () => {
      const next = "brand-new-pass-9";
      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: next });
      expect(res.status).toBe(200);

      const stored = await storedHash(memberId);
      expect(stored).not.toBeNull();
      // The real check: better-auth's own verifier accepts the new password
      // and rejects the old one. Comparing hashes would only prove we wrote
      // *something*.
      expect(await verifyPassword({ hash: stored as string, password: next })).toBe(true);
      expect(await verifyPassword({ hash: stored as string, password: pw })).toBe(false);
    });

    it("revokes every session the target holds, and says how many", async () => {
      // The point of the feature: a reset must evict someone already holding a
      // cookie, or it accomplishes nothing against a compromised account.
      await signIn(memberEmail, pw);
      const before = await sessionCount(memberId);
      expect(before).toBeGreaterThan(0);

      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: "another-new-pass-1" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessionsRevoked: number }).sessionsRevoked).toBe(before);
      expect(await sessionCount(memberId)).toBe(0);
    });

    it("leaves the ADMIN's own sessions alone", async () => {
      const mine = await sessionCount(adminId);
      await req("PATCH", `/${memberId}/password`, adminCookie, { password: "yet-another-pass-1" });
      expect(await sessionCount(adminId)).toBe(mine);
    });

    it("refuses self — Account is the path that requires the current password", async () => {
      const res = await req("PATCH", `/${adminId}/password`, adminCookie, { password: "self-service-pass-1" });
      expect(res.status).toBe(400);
      // Points at the path that DOES work, rather than just refusing.
      expect(await res.text()).toContain("Account");
    });

    it("refuses the system service account", async () => {
      expect((await req("PATCH", `/${systemId}/password`, adminCookie, { password: "nope-nope-nope" })).status).toBe(
        403,
      );
    });

    it("refuses a user who has no password login, rather than inventing one", async () => {
      // Reaching this branch takes a user with a `user` row and no
      // `account` row. Only `system` is like that in practice, and it is
      // refused earlier — so without constructing the state deliberately the
      // guard is unreachable, and an unreachable guard is one that rots.
      // Inventing a credential here would give a password login to an account
      // that deliberately had none.
      const noPwEmail = `um-nopw-${crypto.randomUUID()}@subshell.local`;
      const noPwId = await mkUser(noPwEmail, "user");
      await sql`DELETE FROM account WHERE userId = ${noPwId}`.execute(db);
      try {
        const res = await req("PATCH", `/${noPwId}/password`, adminCookie, { password: "brand-new-pass-2" });
        expect(res.status).toBe(409);
        expect(await res.text()).toContain("no password login");
        // ...and nothing was created behind it.
        expect(await storedHash(noPwId)).toBeNull();
      } finally {
        await deleteUserByEmailOrId(noPwEmail);
      }
    });

    it("keeps the password out of the AUDIT row, not just the response", async () => {
      // The response is the obvious place to check; the audit table is the one
      // that persists and gets read back by an admin months later.
      const secret = "audit-should-not-hold-this-1";
      await req("PATCH", `/${memberId}/password`, adminCookie, { password: secret });
      const rows = await db
        .selectFrom("auditEvents")
        .select(["action", "metadataJson"])
        .where("action", "=", "user.password_reset")
        .where("targetId", "=", memberId)
        .execute();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.metadataJson ?? "").not.toContain(secret);
      // It records what it should: who, and how much was cut.
      expect(rows.at(-1)?.metadataJson ?? "").toContain("sessionsRevoked");
    });

    it("rejects a password under 8 characters WITHOUT quoting it back", async () => {
      // The bound is checked in the handler, not by the schema, for exactly
      // this reason: Elysia renders a schema failure by putting the offending
      // VALUE in the message, and the error handler copies that message into
      // the response body — so a `minLength` here would echo the rejected
      // password into every proxy log and devtools panel on the way back.
      const rejected = "sekrit";
      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: rejected });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(rejected);
      expect(body).toContain("at least 8");
    });

    it("never puts the password in the response, on success or refusal", async () => {
      const secret = "do-not-echo-this-1";
      const ok = await req("PATCH", `/${memberId}/password`, adminCookie, { password: secret });
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain(secret);

      // ...and on the paths that REFUSE, which is where it leaked: a refusal
      // is exactly when something is inclined to quote the input back.
      const onSelf = await req("PATCH", `/${adminId}/password`, adminCookie, { password: secret });
      expect(await onSelf.text()).not.toContain(secret);
      const onSystem = await req("PATCH", `/${systemId}/password`, adminCookie, { password: secret });
      expect(await onSystem.text()).not.toContain(secret);
    });

    it("refuses a non-admin, an anonymous caller, and a bearer key", async () => {
      expect((await req("PATCH", `/${memberId}/password`, memberCookie, { password: "member-tried-1" })).status).toBe(
        403,
      );
      expect((await req("PATCH", `/${memberId}/password`, null, { password: "anon-tried-11" })).status).toBe(401);
      const bearer = await req("PATCH", `/${memberId}/password`, null, { password: "bearer-tried-1" }, adminBearerKey);
      expect(bearer.status).toBe(403);
    });
  });
});

/**
 * Signs in WITHOUT asserting success — the disable cases are about the
 * attempt being refused, which the shared `signIn` helper treats as a broken
 * test rather than as the thing under test.
 */
async function attemptSignIn(email: string, password: string): Promise<Response> {
  return await authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** How many admins can still sign in — the count the disable guard makes. */
async function enabledAdminCount(): Promise<number> {
  const rows = await db
    .selectFrom("userMeta")
    .select("userId")
    .where("role", "=", "admin")
    .where("disabled", "=", 0)
    .execute();
  return rows.length;
}

/**
 * How many admins exist right now.
 *
 * Local to the test rather than a repository method: production has no need
 * for it (`instance-stats.repository.ts` already reports the count for the
 * admin status page), and a repository method that only tests call is a second
 * definition of the same fact waiting to disagree with the first.
 */
async function countAdmins(): Promise<number> {
  const rows = await db.selectFrom("userMeta").select("userId").where("role", "=", "admin").execute();
  return rows.length;
}

/** Every admin except `keep` — the shared test database holds other suites' admins too. */
async function otherAdminIds(keep: string): Promise<string[]> {
  const rows = await db.selectFrom("userMeta").select("userId").where("role", "=", "admin").execute();
  return rows.map((r) => r.userId).filter((id) => id !== keep);
}

/** The credential row's stored hash, or null when the user has no password login. */
async function storedHash(userId: string): Promise<string | null> {
  const { rows } = await sql<{ password: string | null }>`
    SELECT password FROM account WHERE userId = ${userId} AND providerId = ${"credential"}
  `.execute(db);
  return rows[0]?.password ?? null;
}

/** How many live sessions a user holds (better-auth's table, outside the Kysely schema). */
async function sessionCount(userId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}
