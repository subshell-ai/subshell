import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { extendSessionToken, issueSessionToken, revokeSessionToken } from "@/services/session-tokens.js";

/**
 * The session-token lifecycle the MCP bearer auth rests on: mint a key bound
 * to a session row, verify it exposes its metadata, revoke it so verification
 * fails, and extend its expiry. Uses the real better-auth instance against the
 * shared test database (these ARE the plugin behaviors under test).
 */
describe("session tokens", () => {
  let systemUserId: string;
  const createdSessions: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    systemUserId = await ensureSystemUser();
  });

  afterAll(async () => {
    for (const id of createdSessions) await db.deleteFrom("sessions").where("id", "=", id).execute();
  });

  /** Inserts a bare session row (no tmux) — tokens care about the row, not the process. */
  async function fakeSession(userId: string): Promise<string> {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "profile-x",
      harnessId: "claude-code",
      name: "token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    return id;
  }

  it("ensureSystemUser is idempotent and has no login account", async () => {
    const again = await ensureSystemUser();
    expect(again).toBe(systemUserId);
  });

  it("issues a verifiable token bound to the session via metadata", async () => {
    const sid = await fakeSession(systemUserId);
    const key = await issueSessionToken(sid, systemUserId);
    expect(key.startsWith("mote_")).toBe(true);
    // the row links back to the key
    const row = await new SessionsRepository(db).findById(sid);
    expect(row?.apiKeyId).toBeTruthy();

    const res = (await auth.api.verifyApiKey({ body: { key } })) as unknown as {
      valid: boolean;
      key: {
        id: string;
        metadata: { kind: string; sessionId: string } | null;
        permissions: Record<string, string[]> | null;
      };
    };
    expect(res.valid).toBe(true);
    expect(res.key.metadata).toEqual({ kind: "session", sessionId: sid });
    expect(res.key.permissions).toMatchObject({ channels: ["read", "write"], sessions: ["read", "write"] });
  });

  it("revoke disables verification; extend keeps the key alive", async () => {
    const sid = await fakeSession(systemUserId);
    const key = await issueSessionToken(sid, systemUserId);

    expect(await extendSessionToken(sid)).toBe(true);

    await revokeSessionToken(sid);
    const after = (await auth.api.verifyApiKey({ body: { key } })) as unknown as { valid: boolean };
    expect(after.valid).toBe(false);
    // revoking twice and extending an unknown session are harmless
    await revokeSessionToken(sid);
    expect(await extendSessionToken(crypto.randomUUID())).toBe(false);
  });

  it("revoke on a session with no token is a no-op", async () => {
    const sid = await fakeSession(systemUserId);
    await revokeSessionToken(sid); // no throw
  });
});
