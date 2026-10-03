import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { isIssuedCredential } from "@/api/auth-guard.js";
import { backupRecoveryRoutes } from "@/api/backup-recovery.route.js";
import { backupsRoutes } from "@/api/backups.route.js";
import { wsTokenRoutes } from "@/api/ws-token.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { resolveAttach } from "@/ws/attach-resolve.js";
import { issueWsToken } from "@/ws/ws-token.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(wsTokenRoutes).use(backupsRoutes).use(backupRecoveryRoutes);
const email = `backup-recovery-credentials-${crypto.randomUUID()}@example.test`;
const temporaryPassword = "temporary-credentials-password";
let userId: string;
let cookie: string;
let paneId: string;
let siblingId: string;
let paneKey: string;
let paneKeyId: string;

function bearerRequest(pane: string) {
  return new Request("http://localhost:3080/api/auth/ws-token", {
    method: "POST",
    headers: { authorization: `Bearer ${paneKey}`, "content-type": "application/json" },
    body: JSON.stringify({ subshellId: pane }),
  });
}
function attach(pane: string, sessionCookie = "", token?: string) {
  const url = new URL(`ws://localhost/ws?subshell=${pane}`);
  if (token) url.searchParams.set("token", token);
  return resolveAttach({
    url,
    cookieHeader: sessionCookie ? `better-auth.session_token=${sessionCookie}` : "",
    attachUa: "recovery-test",
  });
}

beforeAll(async () => {
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: "Recovered administrator",
    passwordHash: await hashPassword(temporaryPassword),
    role: "admin",
  });
  cookie = await signIn(email, temporaryPassword);
  const panes = new SubshellsRepository(db);
  paneId = crypto.randomUUID();
  siblingId = crypto.randomUUID();
  for (const id of [paneId, siblingId])
    await panes.create({
      id,
      userId,
      presetId: "p",
      harnessId: "terminal",
      name: "recovered-pane",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  paneKey = await issueSubshellToken(paneId, userId);
  const pane = await panes.findById(paneId);
  if (!pane?.apiKeyId) throw new Error("Pane credential fixture was not linked.");
  paneKeyId = pane.apiKeyId;
  await sql`INSERT INTO backup_recovery (user_id) VALUES (${userId})`.execute(db);
});
afterAll(async () => {
  await db.deleteFrom("subshells").where("userId", "=", userId).execute();
  authDatabase().run("DELETE FROM apikey WHERE id = ?", [paneKeyId]);
  await deleteUserByEmailOrId(userId);
});

describe("restored administrator credentials", () => {
  it("gates human terminal admission until password change", async () => {
    expect((await app.fetch(authedRequest("/api/auth/ws-token", cookie, { method: "POST" }))).status).toBe(403);
    expect(await attach(paneId, cookie)).toEqual({ ok: false, code: 4001, reason: "unauthorized" });
    expect(await attach(paneId, "", issueWsToken(userId))).toEqual({ ok: false, code: 4001, reason: "unauthorized" });
  });

  it("preserves scoped pane access for the recovering owner", async () => {
    expect(await isIssuedCredential(paneKey)).toBe(true);
    const minted = await app.fetch(bearerRequest(paneId));
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    expect((await attach(paneId, "", token)).ok).toBe(true);
    expect((await app.fetch(bearerRequest(siblingId))).status).toBe(403);
    expect(
      (
        await app.fetch(
          new Request("http://localhost:3080/api/admin/backups/create", {
            method: "POST",
            headers: { authorization: `Bearer ${paneKey}`, "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("restores human access only after password change and rejects the previous session", async () => {
    const newPassword = "new-credentials-password";
    const changed = await app.fetch(
      authedRequest("/api/account/recovery/password", cookie, {
        method: "POST",
        body: JSON.stringify({ currentPassword: temporaryPassword, newPassword }),
      }),
    );
    expect(changed.status).toBe(200);
    expect((await attach(paneId, cookie)).ok).toBe(false);
    const newCookie = await signIn(email, newPassword);
    expect((await attach(paneId, newCookie)).ok).toBe(true);
    expect(await isIssuedCredential(paneKey)).toBe(true);
    expect((await new SubshellsRepository(db).findById(paneId))?.apiKeyId).toBe(paneKeyId);
  });
});
