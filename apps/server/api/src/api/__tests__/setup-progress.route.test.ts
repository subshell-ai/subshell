import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { setupRoutes } from "@/api/setup.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `GET`/`PATCH /api/setup/progress` — the wizard's own bookmark (spec
 * 2026-09-16 § 2.3).
 *
 * It is the caller's OWN row and nobody else's, which is the shape
 * `/api/notifications/settings` already has: the gate is a browser session and
 * the id comes from the session rather than from the request. Two things this
 * suite exists to pin are therefore about who may ask rather than about the
 * value — a machine credential is refused (a bookmark is a person's place in a
 * wizard, and no machine consumer exists), and there is NO no-users carve-out
 * like the harness routes have, because a bookmark presupposes a user.
 */
const app = new Elysia().use(errorHandlerPlugin).use(setupRoutes);

const PROGRESS = "/api/setup/progress";

describe("/api/setup/progress", () => {
  const password = "progress-pass-1234";
  const email = `progress-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `progress-other-${crypto.randomUUID()}@subshell.local`;
  let userId = "";
  let otherUserId = "";
  let cookie = "";
  let otherCookie = "";
  let subshellKey = "";
  let subshellId = "";
  let apiKeyId: string | undefined;

  function patch(step: string | null, token: string): Request {
    return authedRequest(PROGRESS, token, { method: "PATCH", body: JSON.stringify({ step }) });
  }

  /** GETs the caller's bookmark as the parsed `{ step }` body. */
  async function readStep(token: string): Promise<unknown> {
    return await (await app.fetch(authedRequest(PROGRESS, token))).json();
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    userId = await users.createUser({ email, name: email, passwordHash: await hashPassword(password), role: "user" });
    otherUserId = await users.createUser({
      email: otherEmail,
      name: otherEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    otherCookie = await signIn(otherEmail, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "progress-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
  });

  it("reads null for a caller who has no bookmark", async () => {
    const res = await app.fetch(authedRequest(PROGRESS, cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: null });
  });

  it("writes the caller's bookmark and answers with what was stored", async () => {
    const res = await app.fetch(patch("agent", cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: "agent" });
    expect(await readStep(cookie)).toEqual({ step: "agent" });
  });

  it("clears the bookmark on a null step", async () => {
    await app.fetch(patch("launch", cookie));
    const res = await app.fetch(patch(null, cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: null });
    expect(await new UserMetaRepository(db).getSetupStep(userId)).toBeNull();
  });

  it("is the caller's OWN row — one user's bookmark never reaches another", async () => {
    await app.fetch(patch("network", cookie));
    await app.fetch(patch("launch", otherCookie));
    expect(await readStep(cookie)).toEqual({ step: "network" });
    expect(await readStep(otherCookie)).toEqual({ step: "launch" });
  });

  it("refuses a step outside the enum with a 400 from the schema", async () => {
    const res = await app.fetch(patch("atlantis", cookie));
    expect(res.status).toBe(400);
    // The stored value is untouched by a refused write.
    expect(await readStep(cookie)).toEqual({ step: "network" });
  });

  it("401s an anonymous caller on both verbs — there is no no-users carve-out here", async () => {
    // The harness routes are public while the instance has no users, because
    // the wizard runs before an admin exists. A bookmark cannot be: it names a
    // user, so with no credential there is nobody to read or write.
    const get = await app.fetch(new Request(`http://localhost:3080${PROGRESS}`));
    expect(get.status).toBe(401);
    const patched = await app.fetch(
      new Request(`http://localhost:3080${PROGRESS}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "agent" }),
      }),
    );
    expect(patched.status).toBe(401);
  });

  it("403s a subshell bearer key on both verbs — a bookmark is a browser act", async () => {
    function bearer(init?: RequestInit): Request {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${subshellKey}`);
      if (init?.body) headers.set("content-type", "application/json");
      return new Request(`http://localhost:3080${PROGRESS}`, { ...init, headers });
    }
    expect((await app.fetch(bearer())).status).toBe(403);
    expect((await app.fetch(bearer({ method: "PATCH", body: JSON.stringify({ step: "agent" }) }))).status).toBe(403);
  });

  afterAll(async () => {
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    for (const id of [userId, otherUserId]) {
      if (id) await db.deleteFrom("userMeta").where("userId", "=", id).execute();
    }
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });
});
