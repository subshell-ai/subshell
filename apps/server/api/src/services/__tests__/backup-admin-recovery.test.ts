import { Database as Sqlite } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { authGuard } from "@/api/auth-guard.js";
import { backupRecoveryRoutes } from "@/api/backup-recovery.route.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import {
  backupPasswordChangeRequired,
  completeBackupPasswordRecovery,
  prepareBackupAdminRecovery,
} from "@/services/backup-admin-recovery.js";
import { backupDatabase } from "@/services/db-backup.js";

const dir = mkdtempSync(join(tmpdir(), "subshell-recovery-test-"));
const repo = new UsersRepository(db);
const users: string[] = [];
async function createUser(role: "admin" | "user" = "admin") {
  const email = `restore-${crypto.randomUUID()}@example.test`;
  const id = await repo.createUser({
    name: "Restore admin",
    email,
    role,
    passwordHash: await hashPassword("original-password"),
  });
  users.push(id);
  return { id, email };
}

beforeAll(ensureMigratedTestDb);
afterAll(async () => {
  for (const id of users) await sql`DELETE FROM user WHERE id=${id}`.execute(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("backup administrator recovery", () => {
  it("changes only the staged administrator, enables login, and stores a hash", async () => {
    const admin = await createUser();
    const backup = await backupDatabase({ reason: "manual", dir, keep: 0 });
    expect(backup).not.toBeNull();
    if (!backup) throw new Error("Expected database backup");
    await prepareBackupAdminRecovery(backup.path, admin.id, "temporary-password");
    const staged = new Sqlite(backup.path, { readonly: true });
    try {
      const credential = staged
        .query<{ password: string }, [string]>(
          "SELECT password FROM account WHERE userId=? AND providerId='credential'",
        )
        .get(admin.id);
      if (!credential) throw new Error("Expected staged credential");
      expect(credential.password).not.toContain("temporary-password");
      expect(await verifyPassword({ hash: credential.password, password: "temporary-password" })).toBe(true);
      expect(staged.query("SELECT user_id FROM backup_recovery WHERE user_id=?").get(admin.id)).not.toBeNull();
      expect(
        staged
          .query<{ enabled: number; sign_in_enabled: number }, []>(
            "SELECT enabled,sign_in_enabled FROM auth_providers WHERE id='email'",
          )
          .get(),
      ).toMatchObject({ enabled: 1, sign_in_enabled: 1 });
    } finally {
      staged.close();
    }
    expect(await backupPasswordChangeRequired(db, admin.id)).toBe(false);
  });

  it("refuses a non-admin and short temporary passwords", async () => {
    const member = await createUser("user");
    const backup = await backupDatabase({ reason: "manual", dir, keep: 0 });
    if (!backup) throw new Error("Expected database backup");
    await expect(prepareBackupAdminRecovery(backup.path, member.id, "temporary-password")).rejects.toThrow(
      "human administrator",
    );
    await expect(prepareBackupAdminRecovery(backup.path, member.id, "short")).rejects.toThrow("8–4096");
  });

  it("blocks ordinary APIs and auth changes until a verified password change, then revokes sessions", async () => {
    const admin = await createUser();
    await sql`INSERT INTO backup_recovery (user_id) VALUES (${admin.id})`.execute(db);
    const auth = getAuth();
    const response = await auth.api.signInEmail({
      body: { email: admin.email, password: "original-password" },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Expected sign-in cookie");
    const app = new Elysia()
      .use(authPlugin)
      .use(backupRecoveryRoutes)
      .use(new Elysia().use(authGuard).get("/private", () => ({ ok: true })));
    const request = (path: string, body?: object) =>
      new Request(`http://localhost:3080${path}`, {
        method: body ? "POST" : "GET",
        headers: { cookie, "content-type": "application/json", origin: "http://localhost:5173" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await app.fetch(request("/private"))).status).toBe(403);
    expect((await app.fetch(request("/api/account/recovery/"))).status).toBe(200);
    expect(
      (
        await app.fetch(
          request("/api/auth/change-password", {
            currentPassword: "original-password",
            newPassword: "another-password",
          }),
        )
      ).status,
    ).toBe(403);
    await expect(completeBackupPasswordRecovery(db, admin.id, "wrong-password", "another-password")).rejects.toThrow(
      "incorrect",
    );
    expect(await backupPasswordChangeRequired(db, admin.id)).toBe(true);
    const changed = await app.fetch(
      request("/api/account/recovery/password", {
        currentPassword: "original-password",
        newPassword: "another-password",
      }),
    );
    expect(changed.status).toBe(200);
    expect(await backupPasswordChangeRequired(db, admin.id)).toBe(false);
    expect((await app.fetch(request("/private"))).status).toBe(401);
    const newLogin = await auth.api.signInEmail({
      body: { email: admin.email, password: "another-password" },
      asResponse: true,
    });
    expect(newLogin.status).toBe(200);
  });
});
