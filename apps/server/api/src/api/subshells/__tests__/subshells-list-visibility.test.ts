import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * End-to-end wiring of the sharing read path (spec 2026-08-31 §4.3): the list
 * route must return each caller's VISIBLE set (own + Everyone + named) with the
 * correct viewer-relative `access` on every row, and the summary must count the
 * same visible set. Private foreign subshells stay invisible to a stranger.
 */
describe("GET /api/subshells visibility + access", () => {
  const pw = "sharing-pass-1";
  const aliceEmail = `sh-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `sh-bob-${crypto.randomUUID()}@subshell.local`;
  const carolEmail = `sh-carol-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let bobId: string;
  let bobCookie: string;
  let carolCookie: string;
  /** A REAL subshell bearer key — Bob's pane's MCP token, the machine credential under test. */
  let bobSubshellKey: string;
  const created: string[] = [];

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  }

  async function ownSubshell(id: string, userId: string): Promise<void> {
    created.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: id,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await mkUser(aliceEmail);
    bobId = await mkUser(bobEmail);
    await mkUser(carolEmail);
    bobCookie = await signIn(bobEmail, pw);
    carolCookie = await signIn(carolEmail, pw);

    await ownSubshell("s_priv", aliceId); // Alice only
    await ownSubshell("s_bob", aliceId); // Bob: edit
    await ownSubshell("s_all", aliceId); // Everyone: view
    const shares = new SubshellSharesRepository(db);
    await shares.replaceForSubshell("s_bob", [{ granteeUserId: bobId, permission: "edit" }], aliceId);
    await shares.replaceForSubshell("s_all", [{ granteeUserId: null, permission: "view" }], aliceId);

    // Bob's OWN running subshell + its real MCP bearer key, for the bearer
    // boundary tests below. `issueSubshellToken` records apiKeyId on the row,
    // which is what proves to auth-guard the key is the one minted for THIS
    // subshell and not a self-forged one.
    await ownSubshell("s_bobown", bobId);
    bobSubshellKey = await issueSubshellToken("s_bobown", bobId);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
    // better-auth owns the `user` table — remove via the helper, not a raw delete.
    for (const email of [aliceEmail, bobEmail, carolEmail]) await deleteUserByEmailOrId(email);
  });

  function list(cookie: string) {
    return subshellRoutes.fetch(
      new Request("http://localhost:3080/api/subshells", {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }
  function summary(cookie: string) {
    return subshellRoutes.fetch(
      new Request("http://localhost:3080/api/subshells/summary", {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }

  it("Bob sees his named-edit subshell + the Everyone-view one, each with the right access, never Alice's private one", async () => {
    const rows = (await (await list(bobCookie)).json()) as { id: string; access: string }[];
    const byId = new Map(rows.map((r) => [r.id, r.access]));
    // `s_bobown` is Bob's own (the bearer-boundary fixture); the shares under
    // test are the two granted-in rows.
    expect([...byId.keys()].sort()).toEqual(["s_all", "s_bob", "s_bobown"]);
    expect(byId.get("s_bob")).toBe("edit");
    expect(byId.get("s_all")).toBe("view");
    expect(byId.get("s_bobown")).toBe("owner");
  });

  it("an unshared user sees only the Everyone subshell (access view) — private foreign subshells are absent", async () => {
    const rows = (await (await list(carolCookie)).json()) as { id: string; access: string }[];
    expect(rows.map((r) => r.id)).toEqual(["s_all"]);
    expect(rows[0]?.access).toBe("view");
  });

  it("summary counts the same visible set the list returns", async () => {
    // Bob's visible set is his OWN s_bobown (the bearer-boundary fixture) plus
    // the two shared-in rows — three, all running.
    expect(await (await summary(bobCookie)).json()).toEqual({ total: 3, running: 3, waiting: 0 });
    expect(await (await summary(carolCookie)).json()).toEqual({ total: 1, running: 1, waiting: 0 });
  });

  /**
   * THE BEARER BOUNDARY, declared and pinned (operator ruling 2026-09-23,
   * security-actionable item 2: "keep + pin"). The list route resolves shares
   * for a bearer token like for its owner — a pane CAN enumerate what its
   * owner can see, which is what the MCP coordination posture
   * (`list_subshells`/`get_subshell` on siblings) wants — while every
   * per-subshell route runs machine credentials with shares switched OFF
   * (the service's `#gate`, `allowAdminAndShares: actor !== "subshell-key"`).
   * The asymmetry is the product: enumeration is disclosure-bounded
   * (names/status of owner-visible rows, no pane content), acting is not.
   * Tightening the list half is a `docs/security.md` §3 change, not a
   * drive-by — these two tests are where that decision lives.
   */
  describe("bearer boundary (enumerate-ok / act-denied)", () => {
    function bearerList(key: string) {
      return subshellRoutes.fetch(
        new Request("http://localhost:3080/api/subshells", { headers: { authorization: `Bearer ${key}` } }),
      );
    }
    function bearerGet(key: string, id: string) {
      return subshellRoutes.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}`, { headers: { authorization: `Bearer ${key}` } }),
      );
    }

    it("enumerate-ok: a subshell's own token lists what its owner may see — explicit grant AND the Everyone grant", async () => {
      expect(bobSubshellKey.startsWith("subshell_")).toBe(true);
      const res = await bearerList(bobSubshellKey);
      expect(res.status).toBe(200);
      const byId = new Map(((await res.json()) as { id: string; access: string }[]).map((r) => [r.id, r.access]));
      // Own row, the named `edit` grant, the Everyone `view` grant — the same
      // visible set Bob's cookie gets above, plus his own subshell (the
      // cookie list has it too; this is one read of both halves at once).
      expect([...byId.keys()].sort()).toEqual(["s_all", "s_bob", "s_bobown"]);
      expect(byId.get("s_bob")).toBe("edit");
      expect(byId.get("s_all")).toBe("view");
      expect(byId.get("s_bobown")).toBe("owner");
      // Alice's private row is absent for the token exactly as for the human.
      expect(byId.has("s_priv")).toBe(false);
    });

    it("act-denied: the same token 404s a merely-SHARED subshell — and 200s its owner's own", async () => {
      // The pair that makes this a boundary and not an outage: the 404 is the
      // sharing rule (grants switched off for bearer actors), never a broken
      // credential — the owner's own row still answers through the same key.
      expect((await bearerGet(bobSubshellKey, "s_bobown")).status).toBe(200);
      // 404, not 403: to a bearer credential a foreign row is INVISIBLE, the
      // same no-existence-leak rule §3 gives every stranger. A grant Bob's
      // human holds buys his machine nothing.
      expect((await bearerGet(bobSubshellKey, "s_bob")).status).toBe(404); // even the `edit` grant
      expect((await bearerGet(bobSubshellKey, "s_all")).status).toBe(404);
    });
  });
});
