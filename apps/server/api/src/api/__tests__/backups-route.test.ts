import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { backupRecoveryRoutes } from "@/api/backup-recovery.route.js";
import { backupsRoutes } from "@/api/backups.route.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { deleteRestoreStage, readRestoreStage, saveRestoreStage } from "@/services/backup-staging.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(backupsRoutes).use(backupRecoveryRoutes).use(authPlugin);
const users: string[] = [];
const stages: string[] = [];
let admin: { id: string; token: string };
let anotherAdmin: { id: string; token: string };
let member: { id: string; token: string };
async function makeUser(role: "admin" | "user") {
  const email = `backups-${crypto.randomUUID()}@example.test`;
  const id = await new UsersRepository(db).createUser({
    name: "Backup route test",
    email,
    passwordHash: await hashPassword("backup-route-password"),
    role,
  });
  users.push(id);
  return { id, token: await signIn(email, "backup-route-password") };
}
beforeAll(async () => {
  await setupAuthTables();
  admin = await makeUser("admin");
  anotherAdmin = await makeUser("admin");
  member = await makeUser("user");
});
afterAll(async () => {
  for (const id of stages) {
    try {
      deleteRestoreStage(id);
    } catch {
      /* already cancelled or expired */
    }
  }
  for (const id of users) await deleteUserByEmailOrId(id);
});

async function download(token: string, password?: string) {
  const created = await app.fetch(
    authedRequest("/api/admin/backups/create", token, {
      method: "POST",
      body: JSON.stringify(password ? { password } : {}),
    }),
  );
  if (!created.ok) return created;
  const { id } = (await created.json()) as { id: string };
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await app.fetch(authedRequest(`/api/admin/backups/jobs/${id}`, token));
    const body = (await status.json()) as { status: string; error?: string };
    if (body.status === "ready") return app.fetch(authedRequest(`/api/admin/backups/download/${id}`, token));
    if (body.status === "failed") throw new Error(body.error);
    await Bun.sleep(10);
  }
  throw new Error("Backup creation did not finish.");
}
async function upload(bytes: ArrayBuffer, token: string, password?: string) {
  const form = new FormData();
  form.set("archive", new File([bytes], "backup.subshell-backup", { type: "application/octet-stream" }));
  if (password !== undefined) form.set("password", password);
  return app.fetch(authedRequest("/api/admin/backups/inspect", token, { method: "POST", body: form }));
}

describe("admin archive endpoints", () => {
  it("requires a cookie administrator", async () => {
    expect(
      (
        await app.fetch(
          new Request("http://localhost:3080/api/admin/backups/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
    expect((await download(member.token)).status).toBe(403);
  });

  it("downloads an encrypted archive, refuses a bad password, and stages validated choices", async () => {
    const response = await download(admin.token, "archive-secret");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = await response.arrayBuffer();
    expect(Buffer.from(bytes).subarray(0, 8).toString()).toBe("SUBSHBAK");
    expect((await upload(bytes, admin.token, "wrong-secret")).status).toBe(400);
    const inspected = await upload(bytes, admin.token, "archive-secret");
    expect(inspected.status).toBe(200);
    const body = (await inspected.json()) as { id: string; admins: { id: string }[]; legacyDatabaseOnly: boolean };
    stages.push(body.id);
    expect(body.admins.some((user) => user.id === admin.id)).toBe(true);
    expect(body.legacyDatabaseOnly).toBe(false);
    const refused = await app.fetch(authedRequest(`/api/admin/backups/staged/${body.id}`, anotherAdmin.token));
    expect(refused.status).toBe(404);
    const invalid = await app.fetch(
      authedRequest(`/api/admin/backups/staged/${body.id}`, admin.token, {
        method: "POST",
        body: JSON.stringify({ mode: "migration", configOverrides: { baseUrl: "javascript:alert(1)" } }),
      }),
    );
    expect(invalid.status).toBe(400);
    const prepared = await app.fetch(
      authedRequest(`/api/admin/backups/staged/${body.id}`, admin.token, {
        method: "POST",
        body: JSON.stringify({
          mode: "migration",
          configOverrides: { baseUrl: "https://restored.example" },
          recoveryUserId: admin.id,
          temporaryPassword: "temporary-route-password",
        }),
      }),
    );
    expect(prepared.status).toBe(200);
    const result = (await prepared.json()) as { command: string };
    expect(result.command).toBe(`subshell-server restore --staged ${body.id}`);
    expect(JSON.stringify(readRestoreStage(body.id))).not.toContain("temporary-route-password");
    expect(JSON.stringify(readRestoreStage(body.id))).not.toContain("archive-secret");
    expect(readRestoreStage(body.id).prepared).toBe(true);
  });

  it("inspects browser uploads beneath an aliased OS temporary root and cleans private upload files", async () => {
    const response = await download(admin.token);
    expect(response.status).toBe(200);
    const bytes = await response.arrayBuffer();
    const root = mkdtempSync(join(realpathSync(tmpdir()), "subshell-upload-alias-"));
    const realTemp = join(root, "real-temp");
    mkdirSync(realTemp);
    const alias = join(root, "temp-alias");
    symlinkSync(realTemp, alias);
    const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const originalTmpdir = process.env[tempKey];
    process.env[tempKey] = alias;
    try {
      const inspected = await upload(bytes, admin.token);
      expect(inspected.status).toBe(200);
      const body = (await inspected.json()) as { id: string; admins: { id: string }[] };
      stages.push(body.id);
      expect(body.admins.some((user) => user.id === admin.id)).toBe(true);
      expect(readRestoreStage(body.id, admin.id).stage.legacyDatabaseOnly).toBe(false);
      expect(readdirSync(realTemp)).toEqual([]);
    } finally {
      if (originalTmpdir === undefined) delete process.env[tempKey];
      else process.env[tempKey] = originalTmpdir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expires and cancels uploaded state", async () => {
    const response = await download(admin.token);
    const inspected = await upload(await response.arrayBuffer(), admin.token);
    expect(inspected.status).toBe(200);
    const { id } = (await inspected.json()) as { id: string };
    stages.push(id);
    const record = readRestoreStage(id);
    record.expiresAt = Date.now() - 1;
    saveRestoreStage(record);
    expect((await app.fetch(authedRequest(`/api/admin/backups/staged/${id}`, admin.token))).status).toBe(404);
    expect(() => readRestoreStage(id)).toThrow();
  });
  it("restricts download jobs to their owner and cancels temporary output", async () => {
    const response = await app.fetch(
      authedRequest("/api/admin/backups/create", admin.token, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect((await app.fetch(authedRequest(`/api/admin/backups/jobs/${id}`, anotherAdmin.token))).status).toBe(404);
    expect(
      (await app.fetch(authedRequest(`/api/admin/backups/jobs/${id}`, admin.token, { method: "DELETE" }))).status,
    ).toBe(200);
    expect((await app.fetch(authedRequest(`/api/admin/backups/download/${id}`, admin.token))).status).toBe(409);
    let status = 200;
    for (let attempt = 0; attempt < 100 && status !== 404; attempt++) {
      status = (await app.fetch(authedRequest(`/api/admin/backups/jobs/${id}`, admin.token))).status;
      if (status !== 404) await Bun.sleep(10);
    }
    expect(status).toBe(404);
  });

  it("rejects a copied better-auth cookie cache after restored sessions are revoked", async () => {
    const email = `backup-cache-${crypto.randomUUID()}@example.test`;
    const id = await new UsersRepository(db).createUser({
      name: "Cache test",
      email,
      passwordHash: await hashPassword("backup-cache-password"),
      role: "user",
    });
    users.push(id);
    const signedIn = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password: "backup-cache-password" }),
      }),
    );
    expect(signedIn.status).toBe(200);
    const cookies = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookies).toContain("session_data=");
    const request = () => new Request("http://localhost:3080/api/auth/get-session", { headers: { cookie: cookies } });
    const liveSession = (await (await app.fetch(request())).json()) as { user: { id: string } };
    expect(liveSession.user.id).toBe(id);
    await sql`DELETE FROM session WHERE "userId"=${id}`.execute(db);
    expect(await (await app.fetch(request())).json()).toBeNull();
  });

  it("blocks ordinary administrator APIs while a temporary restore password is pending", async () => {
    await sql`CREATE TABLE IF NOT EXISTS backup_recovery (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE)`.execute(
      db,
    );
    await sql`INSERT OR REPLACE INTO backup_recovery (user_id) VALUES (${admin.id})`.execute(db);
    try {
      const ordinary = await app.fetch(
        authedRequest("/api/admin/backups/create", admin.token, { method: "POST", body: "{}" }),
      );
      expect(ordinary.status).toBe(403);
      expect(await ordinary.text()).toContain("PASSWORD_CHANGE_REQUIRED");
      await expect(resolveSetupActor(authedRequest("/api/setup/harnesses", admin.token))).rejects.toThrow(
        "PASSWORD_CHANGE_REQUIRED",
      );
      const recovery = await app.fetch(authedRequest("/api/account/recovery/", admin.token));
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toEqual({ passwordChangeRequired: true });
    } finally {
      await sql`DELETE FROM backup_recovery WHERE user_id=${admin.id}`.execute(db);
    }
  });
});
