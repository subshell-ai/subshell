import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

/**
 * POST /api/subshells/:id/exit — the pane's own `pane-died` hook reporting
 * that its harness finished (spec 2026-09-19 §4.3), with the exit status when
 * tmux could read one.
 *
 * It retires a row, revokes that row's bearer key and pushes a notification,
 * so who may call it is the whole story — and it is the same self-only rule
 * /attention and /harness-session carry: a pane speaks for its own row and
 * never another's, and a browser has no business here at all.
 */
describe("POST /api/subshells/:id/exit (self-only)", () => {
  let userId: string;
  const email = `exit-${crypto.randomUUID()}@subshell.local`;
  const pw = "exit-route-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];
  let ownerCookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSubshells) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  async function subshellWithToken(): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "exit-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function report(id: string, key: string, body: unknown) {
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/exit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
    );
  }

  it("retires its OWN row and records the exit code", async () => {
    const a = await subshellWithToken();
    expect((await report(a.id, a.key, { exitCode: 7 })).status).toBe(200);
    const row = await new SubshellsRepository(db).findById(a.id);
    // `alive: 0`, not `status: "terminated"` — a pane that finished on its own
    // is a different fact from one a person stopped, and the dead-pane UI
    // reads the first.
    expect(row?.alive).toBe(0);
    expect(row?.exitCode).toBe(7);
    expect(row?.endedAt).not.toBeNull();
  });

  it("keeps 0 distinct from 'no status', which is what tmux gives on a SIGKILL", async () => {
    const zero = await subshellWithToken();
    await report(zero.id, zero.key, { exitCode: 0 });
    expect((await new SubshellsRepository(db).findById(zero.id))?.exitCode).toBe(0);

    const unknown = await subshellWithToken();
    await report(unknown.id, unknown.key, {});
    const row = await new SubshellsRepository(db).findById(unknown.id);
    expect(row?.alive).toBe(0);
    // Reported as unknown rather than as a clean exit — the difference
    // between "it finished" and "something killed it".
    expect(row?.exitCode).toBeNull();
  });

  it("never retires another subshell's row (403), and leaves it running", async () => {
    // The whole authorization story of a route that ends a subshell: a pane
    // holds a real credential, so scope-wide `subshells:write` is not enough.
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    expect((await report(b.id, a.key, { exitCode: 1 })).status).toBe(403);
    const bRow = await new SubshellsRepository(db).findById(b.id);
    expect(bRow?.alive).toBe(1);
    expect(bRow?.exitCode).toBeNull();
  });

  it("turns away a cookie actor, even the owner's", async () => {
    const a = await subshellWithToken();
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${a.id}/exit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await new SubshellsRepository(db).findById(a.id))?.alive).toBe(1);
  });

  it("turns away an unauthenticated caller", async () => {
    const a = await subshellWithToken();
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${a.id}/exit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await new SubshellsRepository(db).findById(a.id))?.alive).toBe(1);
  });

  it("revokes the pane's own key as it dies, so the hook cannot report twice", async () => {
    // The sweep and the hook converge on ONE death transition, and this is
    // what makes a duplicate harmless rather than merely idempotent: a
    // subshell that will never come back has its bearer revoked in the same
    // act, so the second call cannot even authenticate. The code recorded
    // stays the one the first report carried.
    const a = await subshellWithToken();
    expect((await report(a.id, a.key, { exitCode: 3 })).status).toBe(200);
    expect((await report(a.id, a.key, { exitCode: 9 })).status).toBe(401);
    expect((await new SubshellsRepository(db).findById(a.id))?.exitCode).toBe(3);
  });
});
