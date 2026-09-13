import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
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
  const created: string[] = [];

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
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
    expect([...byId.keys()].sort()).toEqual(["s_all", "s_bob"]);
    expect(byId.get("s_bob")).toBe("edit");
    expect(byId.get("s_all")).toBe("view");
  });

  it("an unshared user sees only the Everyone subshell (access view) — private foreign subshells are absent", async () => {
    const rows = (await (await list(carolCookie)).json()) as { id: string; access: string }[];
    expect(rows.map((r) => r.id)).toEqual(["s_all"]);
    expect(rows[0]?.access).toBe("view");
  });

  it("summary counts the same visible set the list returns", async () => {
    expect(await (await summary(bobCookie)).json()).toEqual({ total: 2, running: 2, waiting: 0 });
    expect(await (await summary(carolCookie)).json()).toEqual({ total: 1, running: 1, waiting: 0 });
  });
});
