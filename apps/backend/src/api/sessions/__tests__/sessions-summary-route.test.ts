import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * GET /api/sessions/summary — the badge source (spec §Backend diff).
 * Count arithmetic: waiting = status='running' AND alive=1 AND
 * waiting_since IS NOT NULL; `running` counts alive rows only.
 */
describe("GET /api/sessions/summary", () => {
  const email = `summary-${crypto.randomUUID()}@mote.local`;
  const pw = "summary-pass-1";
  let userId: string;
  let cookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("sessions").where("id", "=", id).execute();
    await deleteUserByEmailOrId(email);
  });

  async function seed(kind: "waiting" | "running" | "paused" | "terminated"): Promise<void> {
    const id = crypto.randomUUID();
    created.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: `sum-${kind}`,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const repo = new SessionsRepository(db);
    if (kind === "waiting") await repo.update(id, { waitingSince: new Date().toISOString() });
    if (kind === "paused") await repo.update(id, { alive: 0 });
    if (kind === "terminated") await repo.update(id, { status: "terminated", alive: 0 });
  }

  function get(path: string, session = cookie) {
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions${path}`, {
        headers: session ? { cookie: `better-auth.session_token=${session}` } : {},
      }),
    );
  }

  it("counts total/running/waiting across every state", async () => {
    await seed("waiting");
    await seed("waiting");
    await seed("running");
    await seed("paused"); // alive=0 → counted in total, not in running
    await seed("terminated");
    const res = await get("/summary");
    expect(res.status).toBe(200);
    // running = every alive row (the two waiting ones are running too).
    expect(await res.json()).toEqual({ total: 5, running: 3, waiting: 2 });
  });

  it("anonymous is 401 and a foreign user sees only their own zero counts", async () => {
    const anon = await get("/summary", "");
    expect(anon.status).toBe(401);
    const otherEmail = `summary-other-${crypto.randomUUID()}@mote.local`;
    const otherId = await new UsersRepository(db).createUser({
      email: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    const otherCookie = await signIn(otherEmail, pw);
    const res = await get("/summary", otherCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 0, running: 0, waiting: 0 });
    await deleteUserByEmailOrId(otherEmail);
    await db.deleteFrom("sessions").where("userId", "=", otherId).execute();
  });
});
