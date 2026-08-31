import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sessionRoutes } from "@/api/sessions/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { __setSenderForTests, __setVapidDirForTests, type PushSender } from "@/services/notify.service.js";
import { issueSessionToken } from "@/services/session-tokens.js";

// errorHandlerPlugin mounted like createApp() so thrown status errors and
// validation failures serialize like production (400, not Elysia's raw 422).
// The REAL aggregator is mounted, so this suite also pins the `.use()` lines.
const app = new Elysia().use(errorHandlerPlugin).use(sessionRoutes);

/**
 * `POST /api/sessions/:id/attention` (harness hook self-report, session-key
 * only) and `PATCH /api/sessions/:id/notify` (the ⋯-menu bell toggle, owner
 * cookie or the session's own key). SessionsService.recordAttention stamps
 * `waiting_since` and rings through the app-wide notify singleton, so the
 * suite swaps in a fake push sender + temp VAPID dir before anything can
 * build the singleton against the real data dir.
 */
describe("sessions attention + notify routes", () => {
  const ownerEmail = `notify-owner-${crypto.randomUUID()}@mote.local`;
  const foreignEmail = `notify-foreign-${crypto.randomUUID()}@mote.local`;
  const password = "notify-pass-1234";
  let ownerId: string;
  let ownerCookie: string;
  let foreignCookie: string;
  const vapidDir = mkdtempSync(join(tmpdir(), "mote-vapid-attention-"));
  const createdSessionIds: string[] = [];
  const createdKeyIds: string[] = [];
  /** Every push the app-wide singleton attempted, captured by the fake sender. */
  const sends: { endpoint: string; payload: string }[] = [];

  // A and B are both the owner's sessions — the self-scope guard is per-row,
  // so B's key is "foreign" for A's endpoints and vice versa.
  let idA = "";
  let keyA = "";
  let idB = "";
  let keyB = "";

  beforeAll(async () => {
    // BEFORE any getNotifyService(): the fake sender must be captured when
    // the singleton is first built, and VAPID generation (if ever reached)
    // must land in a temp dir, never the real data dir.
    __setVapidDirForTests(vapidDir);
    const sender: PushSender = async (sub, payload) => {
      sends.push({ endpoint: sub.endpoint, payload });
      return { statusCode: 201 };
    };
    __setSenderForTests(sender);

    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, password);
    await new UsersRepository(db).createUser({
      email: foreignEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    foreignCookie = await signIn(foreignEmail, password);

    idA = await mintSession("notify-A");
    keyA = await issueSessionToken(idA, ownerId);
    await trackKey(idA);
    idB = await mintSession("notify-B");
    keyB = await issueSessionToken(idB, ownerId);
    await trackKey(idB);
  });

  afterAll(async () => {
    await db.deleteFrom("notificationsSubscriptions").execute();
    for (const sid of createdSessionIds) await db.deleteFrom("sessions").where("id", "=", sid).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(foreignEmail);
    __setSenderForTests(null);
    __setVapidDirForTests(null);
    rmSync(vapidDir, { recursive: true, force: true });
  });

  /** Creates an owned session row (bell ON, nothing pending) and tracks it. */
  async function mintSession(name: string, over: { alive?: number } = {}): Promise<string> {
    const id = crypto.randomUUID();
    createdSessionIds.push(id);
    await new SessionsRepository(db).create({
      id,
      userId: ownerId,
      profileId: "p",
      harnessId: "claude-code",
      name,
      workingDir: "/tmp",
      tmuxSocket: null,
      notify: 1,
      ...over,
    });
    return id;
  }

  /** Tracks the key issued by issueSessionToken for later apikey cleanup. */
  async function trackKey(sessionId: string): Promise<void> {
    const row = await new SessionsRepository(db).findById(sessionId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
  }

  async function req(
    path: string,
    opts: { cookie?: string; bearer?: string; method?: string; body?: unknown },
  ): Promise<Response> {
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    return app.fetch(
      new Request(`http://localhost:3080/api/sessions${path}`, {
        method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  async function row(id: string) {
    const found = await new SessionsRepository(db).findById(id);
    if (!found) throw new Error(`test session row missing: ${id}`);
    return found;
  }

  it("attention from the session's own key sets waiting_since and rings", async () => {
    await new NotificationsRepository(db).upsertForUser(
      ownerId,
      `https://push/attention-${idA}`,
      "BFakeP256dhKeyForTests0123456789abcdef",
      "fakeAuthSecret01",
    );
    const res = await req(`/${idA}/attention`, { bearer: keyA, body: { kind: "turn_complete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = await row(idA);
    expect(after.waitingSince).not.toBeNull();
    expect(Number.isNaN(Date.parse(after.waitingSince ?? ""))).toBe(false);

    // "Rings" must be real: the owner's subscription got exactly one push
    // with the payload the service worker turns into an OS notification.
    expect(sends).toHaveLength(1);
    const payload = JSON.parse(sends[0].payload) as { title: string; body: string; url: string; tag: string };
    expect(sends[0].endpoint).toBe(`https://push/attention-${idA}`);
    expect(payload).toEqual({
      title: "notify-A",
      body: "Done — waiting for you",
      url: `/sessions/${idA}`,
      tag: idA,
    });
  });

  it("attention from a foreign session key → 403 (per-row self-scope)", async () => {
    // Target A with B's key — A's stamp was set by test 1; a refused foreign
    // write must leave it EXACTLY where it was (same guard direction either
    // way, and this keeps the tests order-independent on shared rows).
    const before = await row(idA);
    const res = await req(`/${idA}/attention`, { bearer: keyB, body: { kind: "needs_attention" } });
    expect(res.status).toBe(403);
    const after = await row(idA);
    expect(after.waitingSince).toBe(before.waitingSince);
  });

  it("attention from a cookie actor (even the owner) → 403 — harness-only endpoint", async () => {
    const res = await req(`/${idB}/attention`, { cookie: ownerCookie, body: { kind: "turn_complete" } });
    expect(res.status).toBe(403);
    expect((await row(idB)).waitingSince).toBeNull();
  });

  it("attention with an unknown kind → 400 (schema union, not a free string)", async () => {
    const res = await req(`/${idA}/attention`, { bearer: keyA, body: { kind: "pizza_time" } });
    expect(res.status).toBe(400);
  });

  it("attention on a DEAD row is a silent 200 — no stamp resurrection, no push", async () => {
    // A hook POST in flight while the pane dies lands AFTER the reconcile
    // sweep cleared `waiting_since`. Stamping now would resurrect a false
    // chip on a dead (possibly auto-restarting, same-id) row — the guard
    // must drop the event while keeping the response 200 (hooks are
    // fire-and-forget; a 4xx there only teaches the harness to stop trying).
    const deadId = await mintSession("notify-dead", { alive: 0 });
    const deadKey = await issueSessionToken(deadId, ownerId);
    await trackKey(deadId);
    await new NotificationsRepository(db).upsertForUser(
      ownerId,
      `https://push/dead-${deadId}`,
      "BFakeP256dhKeyForTests0123456789abcdef",
      "fakeAuthSecret01",
    );

    const sendsBefore = sends.length;
    const res = await req(`/${deadId}/attention`, { bearer: deadKey, body: { kind: "turn_complete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await row(deadId)).waitingSince).toBeNull();
    expect(sends).toHaveLength(sendsBefore);
  });

  it("PATCH notify toggles the bell both ways and never clears waiting_since; foreign cookie user → 404", async () => {
    // A pending state to protect: muting stops pushes, not the state.
    const stamp = "2026-01-01T00:00:00.000Z";
    await new SessionsRepository(db).update(idB, { waitingSince: stamp });

    expect(
      (await req(`/${idB}/notify`, { cookie: ownerCookie, method: "PATCH", body: { notify: false } })).status,
    ).toBe(200);
    let after = await row(idB);
    expect(after.notify).toBe(0);
    expect(after.waitingSince).toBe(stamp);

    expect((await req(`/${idB}/notify`, { cookie: ownerCookie, method: "PATCH", body: { notify: true } })).status).toBe(
      200,
    );
    after = await row(idB);
    expect(after.notify).toBe(1);
    expect(after.waitingSince).toBe(stamp);

    // Foreign cookie user: not found, not forbidden — no existence leak.
    const foreign = await req(`/${idB}/notify`, { cookie: foreignCookie, method: "PATCH", body: { notify: false } });
    expect(foreign.status).toBe(404);
    expect((await row(idB)).notify).toBe(1);
  });

  it("PATCH notify from the session's own key is allowed for itself, not others", async () => {
    const own = await req(`/${idA}/notify`, { bearer: keyA, method: "PATCH", body: { notify: false } });
    expect(own.status).toBe(200);
    expect((await row(idA)).notify).toBe(0);
    // Restore the bell so suite state stays tidy for anything reading A later.
    await new SessionsRepository(db).update(idA, { notify: 1 });

    // B's own key works the same way (self-scope is per-row, both rows pass).
    expect((await req(`/${idB}/notify`, { bearer: keyB, method: "PATCH", body: { notify: false } })).status).toBe(200);
    expect((await row(idB)).notify).toBe(0);
    await new SessionsRepository(db).update(idB, { notify: 1 });

    const other = await req(`/${idB}/notify`, { bearer: keyA, method: "PATCH", body: { notify: false } });
    expect(other.status).toBe(403);
    expect((await row(idB)).notify).toBe(1);
  });

  it("unauthenticated → 401 on both endpoints", async () => {
    expect((await req(`/${idA}/attention`, { method: "POST", body: { kind: "turn_complete" } })).status).toBe(401);
    expect((await req(`/${idA}/notify`, { method: "PATCH", body: { notify: true } })).status).toBe(401);
  });
});
