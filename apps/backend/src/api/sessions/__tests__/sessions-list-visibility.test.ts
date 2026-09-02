import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * End-to-end wiring of the sharing read path (spec 2026-08-31 §4.3): the list
 * route must return each caller's VISIBLE set (own + Everyone + named) with the
 * correct viewer-relative `access` on every row, and the summary must count the
 * same visible set. Private foreign sessions stay invisible to a stranger.
 */
describe("GET /api/sessions visibility + access", () => {
  const pw = "sharing-pass-1";
  const aliceEmail = `sh-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `sh-bob-${crypto.randomUUID()}@subshell.local`;
  const carolEmail = `sh-carol-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let bobId: string;
  let bobCookie: string;
  let carolCookie: string;
  const created: string[] = [];

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
  }

  async function ownSession(id: string, userId: string): Promise<void> {
    created.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
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

    await ownSession("s_priv", aliceId); // Alice only
    await ownSession("s_bob", aliceId); // Bob: edit
    await ownSession("s_all", aliceId); // Everyone: view
    const shares = new SessionSharesRepository(db);
    await shares.replaceForSession("s_bob", [{ granteeUserId: bobId, permission: "edit" }], aliceId);
    await shares.replaceForSession("s_all", [{ granteeUserId: null, permission: "view" }], aliceId);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("sessions").where("id", "=", id).execute();
    // better-auth owns the `user` table — remove via the helper, not a raw delete.
    for (const email of [aliceEmail, bobEmail, carolEmail]) await deleteUserByEmailOrId(email);
  });

  function list(cookie: string) {
    return sessionRoutes.fetch(
      new Request("http://localhost:3080/api/sessions", {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }
  function summary(cookie: string) {
    return sessionRoutes.fetch(
      new Request("http://localhost:3080/api/sessions/summary", {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }

  it("Bob sees his named-edit session + the Everyone-view one, each with the right access, never Alice's private one", async () => {
    const rows = (await (await list(bobCookie)).json()) as { id: string; access: string }[];
    const byId = new Map(rows.map((r) => [r.id, r.access]));
    expect([...byId.keys()].sort()).toEqual(["s_all", "s_bob"]);
    expect(byId.get("s_bob")).toBe("edit");
    expect(byId.get("s_all")).toBe("view");
  });

  it("an unshared user sees only the Everyone session (access view) — private foreign sessions are absent", async () => {
    const rows = (await (await list(carolCookie)).json()) as { id: string; access: string }[];
    expect(rows.map((r) => r.id)).toEqual(["s_all"]);
    expect(rows[0]?.access).toBe("view");
  });

  it("summary counts the same visible set the list returns", async () => {
    expect(await (await summary(bobCookie)).json()).toEqual({ total: 2, running: 2, waiting: 0 });
    expect(await (await summary(carolCookie)).json()).toEqual({ total: 1, running: 1, waiting: 0 });
  });
});
