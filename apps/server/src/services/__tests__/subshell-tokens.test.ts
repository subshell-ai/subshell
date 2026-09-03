import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { extendSubshellToken, issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";

/**
 * The subshell-token lifecycle the MCP bearer auth rests on: mint a key bound
 * to a subshell row, verify it exposes its metadata, revoke it so verification
 * fails, and extend its expiry. Uses the real better-auth instance against the
 * shared test database (these ARE the plugin behaviors under test).
 */
describe("subshell tokens", () => {
  let systemUserId: string;
  const createdSubshells: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    systemUserId = await ensureSystemUser();
  });

  afterAll(async () => {
    for (const id of createdSubshells) await db.deleteFrom("subshells").where("id", "=", id).execute();
  });

  /** Inserts a bare subshell row (no tmux) — tokens care about the row, not the process. */
  async function fakeSubshell(userId: string): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
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

  it("issues a verifiable token bound to the subshell via metadata", async () => {
    const sid = await fakeSubshell(systemUserId);
    const key = await issueSubshellToken(sid, systemUserId);
    expect(key.startsWith("subshell_")).toBe(true);
    // the row links back to the key
    const row = await new SubshellsRepository(db).findById(sid);
    expect(row?.apiKeyId).toBeTruthy();

    const res = (await getAuth().api.verifyApiKey({ body: { key } })) as unknown as {
      valid: boolean;
      key: {
        id: string;
        metadata: { kind: string; subshellId: string } | null;
        permissions: Record<string, string[]> | null;
      };
    };
    expect(res.valid).toBe(true);
    expect(res.key.metadata).toEqual({ kind: "subshell", subshellId: sid });
    expect(res.key.permissions).toMatchObject({ channels: ["read", "write"], subshells: ["read", "write"] });
  });

  it("revoke disables verification; extend keeps the key alive", async () => {
    const sid = await fakeSubshell(systemUserId);
    const key = await issueSubshellToken(sid, systemUserId);

    expect(await extendSubshellToken(sid)).toBe(true);

    await revokeSubshellToken(sid);
    const after = (await getAuth().api.verifyApiKey({ body: { key } })) as unknown as { valid: boolean };
    expect(after.valid).toBe(false);
    // revoking twice and extending an unknown subshell are harmless
    await revokeSubshellToken(sid);
    expect(await extendSubshellToken(crypto.randomUUID())).toBe(false);
  });

  it("revoke on a subshell with no token is a no-op", async () => {
    const sid = await fakeSubshell(systemUserId);
    await revokeSubshellToken(sid); // no throw
  });
});
