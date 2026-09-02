import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES } from "@internal/session-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Route-level tests for session file uploads. The heavy sanitization and
 * containment logic is covered in uploads.service.test.ts; these assert the
 * HTTP contract: ownership, working-directory state, and the success shape.
 */

const password = "upload-route-pass-1";
const workDirs: string[] = [];

/** Creates a throwaway working directory for a session row to point at. */
function tempWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mote-upload-route-"));
  workDirs.push(dir);
  return dir;
}

/** Builds a multipart request carrying one file. */
function uploadRequest(sessionId: string, token: string, file: File): Request {
  const body = new FormData();
  body.set("file", file);
  return authedRequest(`/api/sessions/${sessionId}/uploads`, token, { method: "POST", body });
}

describe("session uploads route", () => {
  let ownerId: string;
  let otherId: string;
  let ownerEmail: string;
  let otherEmail: string;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    ownerEmail = `upowner-${crypto.randomUUID()}@mote.local`;
    otherEmail = `upother-${crypto.randomUUID()}@mote.local`;
    ownerId = await users.createUser({ email: ownerEmail, passwordHash: await hashPassword(password), role: "user" });
    otherId = await users.createUser({ email: otherEmail, passwordHash: await hashPassword(password), role: "user" });
    ownerToken = await signIn(ownerEmail, password);
    otherToken = await signIn(otherEmail, password);
  });

  afterAll(async () => {
    await db.deleteFrom("userMeta").where("userId", "=", ownerId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", otherId).execute();
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(otherEmail);
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Inserts a session row owned by `userId` pointing at a real directory. */
  async function makeSession(userId: string, workingDir: string): Promise<string> {
    const id = crypto.randomUUID();
    await new SessionsRepository(db).create({
      id,
      userId,
      name: "upload-test",
      workingDir,
      harnessId: "claude-code",
      // No foreign key on sessions.profile_id (see migration 0001-init.ts),
      // so a random id is sufficient without creating a profile row.
      profileId: crypto.randomUUID(),
      status: "running",
      tmuxSocket: `mote-upload-${id.slice(0, 8)}`,
    });
    return id;
  }

  it("anonymous -> 401", async () => {
    const id = await makeSession(ownerId, tempWorkDir());
    const body = new FormData();
    body.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await uploadsRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/uploads`, { method: "POST", body }),
    );
    expect(res.status).toBe(401);
  });

  it("stores the file in the working directory and returns its path", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File(["hello"], "notes.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; name: string; size: number; contentType: string };
    expect(json.path.startsWith(join(ws, ".mote/uploads/"))).toBe(true);
    expect(json.name).toMatch(/^\d{8}-\d{6}-notes\.txt$/);
    expect(json.size).toBe(5);
    expect(readFileSync(json.path, "utf8")).toBe("hello");
  });

  it("git-excludes .mote so the working directory stays clean", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);
    await Bun.$`git init -q`.cwd(ws).quiet();
    await uploadsRoutes.fetch(uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })));
    const status = await Bun.$`git status --porcelain`.cwd(ws).text();
    expect(status.trim()).toBe("");
  });

  it("unknown session -> 404", async () => {
    const res = await uploadsRoutes.fetch(
      uploadRequest(crypto.randomUUID(), ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(404);
  });

  it("another user's session -> 404 (does not leak existence)", async () => {
    const id = await makeSession(ownerId, tempWorkDir());
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, otherToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(404);
  });

  it("missing working directory -> 409", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);
    rmSync(ws, { recursive: true, force: true });
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(409);
  });

  it("read-only working directory -> 409", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);
    chmodSync(ws, 0o500);
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
      );
      expect(res.status).toBe(409);
      expect(existsSync(join(ws, ".mote"))).toBe(false);
    } finally {
      chmodSync(ws, 0o700);
    }
  });

  it("enforces the shared upload cap in bytes, not some other unit", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);

    // Over the cap must be refused, and THIS is the assertion that pins the
    // unit: the schema passes MAX_UPLOAD_BYTES (a plain byte count) where it
    // once passed the string "25m". If a bare number were read as anything
    // larger than bytes, this file would be accepted and the assertion fails.
    // It also catches a regression to a string, since MAX_UPLOAD_BYTES + 1024
    // against "25m" would concatenate to "25m1024" -> new Uint8Array(NaN) ->
    // a 0-byte file that sails through.
    //
    // 400 INPUT_VALIDATION_ERROR, not just any 4xx: an over-cap file fails
    // Elysia's body validation before the handler runs, and the server's global
    // error handler rewrites Elysia's native 422 into the shared structured
    // 400 body (the one intentional status change). Asserting the exact status
    // and code documents that contract — `>= 400` was also satisfiable by a
    // 401 or 404.
    const over = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1024)], "over.bin", {
      type: "application/octet-stream",
    });
    const app = new Elysia().use(errorHandlerPlugin).use(uploadsRoutes);
    const rejected = await app.fetch(uploadRequest(id, ownerToken, over));
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
    expect(existsSync(join(ws, ".mote"))).toBe(false);

    // Under the cap must still be accepted. This does NOT pin a unit of its own
    // — no plausible misreading makes the cap smaller than bytes — it is a
    // control so the assertion above cannot pass merely because uploads broke.
    const under = new File([new Uint8Array(1024)], "under.bin", { type: "application/octet-stream" });
    const accepted = await uploadsRoutes.fetch(uploadRequest(id, ownerToken, under));
    expect(accepted.status).toBe(200);
  });

  // F4 (security audit 2026-08): uploads write into the session's working
  // directory and are browser-only — the `mote mcp` binary never calls this
  // endpoint (see the endpoint census in packages/mcp-core/src/tools.ts), and the frontend
  // posts with `credentials: "include"`. A bearer key must not act as owner.
  it("bearer session key -> 403 and nothing written", async () => {
    const ws = tempWorkDir();
    const id = await makeSession(ownerId, ws);
    const key = await issueSessionToken(id, ownerId);

    const body = new FormData();
    body.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await uploadsRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body,
      }),
    );
    expect(res.status).toBe(403);
    expect(existsSync(join(ws, ".mote"))).toBe(false);

    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [row.apiKeyId]);
    await db.deleteFrom("sessions").where("id", "=", id).execute();
  });
});
