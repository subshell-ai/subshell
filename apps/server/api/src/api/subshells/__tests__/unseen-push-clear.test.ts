import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

/**
 * The unseen gate's clearing side (spec 2026-09-23): opening the pane AS
 * ITS OWNER over a cookie session answers the push. Not a share viewer,
 * not the pane's own token (which resolves as the owner — the one path a
 * prompt-injected agent could use to re-arm its own notifications), not the
 * list route the sidebar polls.
 */
describe("owner-cookie pane reads clear the unseen urgency", () => {
  const owner = { email: `unseen-o-${crypto.randomUUID()}@subshell.local`, pw: "unseen-pass-1" };
  const viewer = { email: `unseen-v-${crypto.randomUUID()}@subshell.local`, pw: "unseen-pass-1" };
  let ownerId: string;
  let viewerId: string;
  let ownerCookie: string;
  let viewerCookie: string;
  const created: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: owner.email,
      name: owner.email,
      passwordHash: await hashPassword(owner.pw),
      role: "user",
    });
    viewerId = await new UsersRepository(db).createUser({
      email: viewer.email,
      name: viewer.email,
      passwordHash: await hashPassword(viewer.pw),
      role: "user",
    });
    ownerCookie = await signIn(owner.email, owner.pw);
    viewerCookie = await signIn(viewer.email, viewer.pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await deleteUserByEmailOrId(owner.email);
    await deleteUserByEmailOrId(viewer.email);
  });

  /** A row owned by `ownerId`, unseen urgency 2, with a `view` share to viewer. */
  async function unseen(share = false): Promise<{ id: string; key?: string }> {
    const id = crypto.randomUUID();
    created.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      presetId: "p",
      harnessId: "shell",
      name: "unseen-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    await new SubshellsRepository(db).update(id, { lastPushUrgency: 2 });
    if (share) {
      await new SubshellSharesRepository(db).replaceForSubshell(
        id,
        [{ granteeUserId: viewerId, permission: "view" }],
        ownerId,
      );
    }
    return { id };
  }

  const get = (path: string, cookie?: string, bearer?: string) =>
    app.fetch(
      new Request(`http://localhost:3080/api/subshells/${path}`, {
        headers: {
          ...(cookie ? { cookie: `better-auth.session_token=${cookie}` } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      }),
    );

  const urgencyOf = async (id: string) => (await new SubshellsRepository(db).findById(id))?.lastPushUrgency;

  it("the owner's cookie GET /:id answers the unseen push", async () => {
    const { id } = await unseen();
    expect((await get(id, ownerCookie)).status).toBe(200);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("the owner's cookie GET /:id/log answers it too", async () => {
    const { id } = await unseen();
    await get(`${id}/log`, ownerCookie); // status is not the contract — the clear happens after the access gate, before the log read
    expect(await urgencyOf(id)).toBeNull();
  });

  it("the pane's OWN token does not clear, although it resolves as the owner", async () => {
    const { id } = await unseen();
    const key = await issueSubshellToken(id, ownerId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    expect((await get(id, undefined, key)).status).toBe(200);
    expect(await urgencyOf(id)).toBe(2);
  });

  it("a shared viewer's cookie does not clear the owner's state", async () => {
    const { id } = await unseen(true);
    expect((await get(id, viewerCookie)).status).toBe(200);
    expect(await urgencyOf(id)).toBe(2);
  });

  it("the list route the sidebar polls never clears, and carries the flag", async () => {
    const { id } = await unseen();
    const res = await app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        headers: { cookie: `better-auth.session_token=${ownerCookie}` },
      }),
    );
    expect(res.status).toBe(200);
    // Shape-agnostic: the list body's exact form is another suite's claim.
    expect(JSON.stringify(await res.json())).toContain('"unseenPush":true');
    expect(await urgencyOf(id)).toBe(2);
  });
});
