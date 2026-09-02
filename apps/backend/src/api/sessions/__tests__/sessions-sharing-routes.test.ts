import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The §4.1 capability matrix, exercised through the real routes:
 *   view  → read (get/log)
 *   edit  → + rename/notes
 *   owner → + the notify bell, delete
 * A private/foreign session is a 404 (invisible, no existence leak); a visible
 * session the caller lacks the level for is a 403.
 */
describe("session sharing — access matrix over routes", () => {
  const pw = "share-matrix-1";
  const aliceEmail = `sm-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `sm-bob-${crypto.randomUUID()}@subshell.local`;
  const carolEmail = `sm-carol-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;
  const created: string[] = [];

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
  }
  async function ownSession(id: string): Promise<void> {
    created.push(id);
    await new SessionsRepository(db).create({
      id,
      userId: aliceId,
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
    carolId = await mkUser(carolEmail);
    aliceCookie = await signIn(aliceEmail, pw);
    bobCookie = await signIn(bobEmail, pw);
    carolCookie = await signIn(carolEmail, pw);

    await ownSession("s_edit"); // bob: edit
    await ownSession("s_view"); // carol: view
    await ownSession("s_own"); // nobody but alice
    const shares = new SessionSharesRepository(db);
    await shares.replaceForSession("s_edit", [{ granteeUserId: bobId, permission: "edit" }], aliceId);
    await shares.replaceForSession("s_view", [{ granteeUserId: carolId, permission: "view" }], aliceId);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("sessions").where("id", "=", id).execute();
    for (const email of [aliceEmail, bobEmail, carolEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, cookie: string, body?: unknown) {
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions${path}`, {
        method,
        headers: {
          cookie: `better-auth.session_token=${cookie}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  it("a view grantee reads (get + log) but cannot rename, note, toggle the bell, or delete", async () => {
    expect((await req("GET", "/s_view", carolCookie)).status).toBe(200);
    const got = (await (await req("GET", "/s_view", carolCookie)).json()) as { access: string };
    expect(got.access).toBe("view");
    expect((await req("GET", "/s_view/log", carolCookie)).status).toBe(200);
    expect((await req("PATCH", "/s_view/name", carolCookie, { name: "hijack" })).status).toBe(403);
    expect((await req("PATCH", "/s_view/notes", carolCookie, { notes: "x" })).status).toBe(403);
    expect((await req("PATCH", "/s_view/notify", carolCookie, { notify: false })).status).toBe(403);
    expect((await req("DELETE", "/s_view", carolCookie)).status).toBe(403);
  });

  it("an edit grantee renames and notes, but cannot touch the bell or delete", async () => {
    const got = (await (await req("GET", "/s_edit", bobCookie)).json()) as { access: string };
    expect(got.access).toBe("edit");
    expect((await req("PATCH", "/s_edit/name", bobCookie, { name: "renamed by bob" })).status).toBe(200);
    expect((await req("PATCH", "/s_edit/notes", bobCookie, { notes: "bob was here" })).status).toBe(200);
    expect((await req("PATCH", "/s_edit/notify", bobCookie, { notify: false })).status).toBe(403);
    expect((await req("DELETE", "/s_edit", bobCookie)).status).toBe(403);
    // The rename actually landed.
    expect((await new SessionsRepository(db).findById("s_edit"))?.name).toBe("renamed by bob");
  });

  it("the owner has full control (access 'owner'; the bell is theirs)", async () => {
    const got = (await (await req("GET", "/s_edit", aliceCookie)).json()) as { access: string };
    expect(got.access).toBe("owner");
    expect((await req("PATCH", "/s_edit/notify", aliceCookie, { notify: false })).status).toBe(200);
    expect((await new SessionsRepository(db).findById("s_edit"))?.notify).toBe(0);
  });

  it("a session not shared to a viewer is invisible: 404, not 403", async () => {
    // carol was granted s_view only; s_edit and s_own are foreign+unshared to her.
    expect((await req("GET", "/s_edit", carolCookie)).status).toBe(404);
    expect((await req("GET", "/s_own", carolCookie)).status).toBe(404);
  });

  it("an admin (not owner, not shared to) gets effective edit — read + rename — but not owner-only acts", async () => {
    const adminEmail = `sm-admin-${crypto.randomUUID()}@subshell.local`;
    await new UsersRepository(db).createUser({
      email: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    const cookie = await signIn(adminEmail, pw);
    try {
      const got = (await (await req("GET", "/s_own", cookie)).json()) as { access: string };
      expect(got.access).toBe("edit"); // admin effective access (spec), not owner
      expect((await req("PATCH", "/s_own/name", cookie, { name: "admin edited" })).status).toBe(200);
      // Owner-only acts stay with the real owner.
      expect((await req("DELETE", "/s_own", cookie)).status).toBe(403);
      expect((await req("PATCH", "/s_own/notify", cookie, { notify: false })).status).toBe(403);
    } finally {
      await deleteUserByEmailOrId(adminEmail);
    }
  });
});
