import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { TmuxRunner } from "@internal/harnesses";
import { generateKeypair } from "@internal/mcp-core";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { channelRoutes } from "@/api/channels/index.js";
import { identityRoutes } from "@/api/identities.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { setNudgeTransportForTests } from "@/services/channels/nudge.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * A structurally-valid fake General JWE envelope (server never decrypts it).
 * `kids` become the plaintext recipient `header.kid`s — the server pins them
 * to the declared `recipientIds`, so fakes must mirror a real seal().
 */
function envelope(body: string, kids: string[]): string {
  return JSON.stringify({
    protected: "p",
    iv: "i",
    tag: "t",
    ciphertext: body,
    recipients: kids.map((kid) => ({ header: { kid }, encrypted_key: "k" })),
  });
}

/** POST helper: returns status + parsed JSON (only on 2xx). */
async function call(
  app: { fetch: (req: Request, ...rest: never[]) => Response | Promise<Response> },
  path: string,
  token: string,
  init?: RequestInit,
) {
  const res = await app.fetch(authedRequest(path, token, init));
  const body = res.status < 300 ? await res.json().catch(() => null) : null;
  // `any` body by design: route tests assert on loose JSON shapes (test idiom).
  return { status: res.status, body: body as any, text: res.status >= 400 ? await res.text().catch(() => "") : "" };
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("channels route", () => {
  let alice: string;
  let bob: string;
  let aliceToken: string;
  let bobToken: string;
  const aliceEmail = `ch-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `ch-bob-${crypto.randomUUID()}@subshell.local`;
  const pw = "channe1-pass!";
  const createdSessions: string[] = [];
  const nudges: { socket: string; name: string; text: string }[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    alice = await users.createUser({ email: aliceEmail, passwordHash: await hashPassword(pw), role: "user" });
    bob = await users.createUser({ email: bobEmail, passwordHash: await hashPassword(pw), role: "user" });
    aliceToken = await signIn(aliceEmail, pw);
    bobToken = await signIn(bobEmail, pw);
  });

  afterAll(async () => {
    for (const id of createdSessions) await db.deleteFrom("sessions").where("id", "=", id).execute();
    await deleteUserByEmailOrId(aliceEmail);
    await deleteUserByEmailOrId(bobEmail);
  });

  beforeEach(async () => {
    await db.deleteFrom("channelCursors").execute();
    await db.deleteFrom("channelPostRecipients").execute();
    await db.deleteFrom("channelPosts").execute();
    await db.deleteFrom("channelMembers").execute();
    await db.deleteFrom("channels").execute();
    await db.deleteFrom("identities").execute();
  });

  /** Registers a REAL P-256 public key for a cookie user so they can create/join. */
  async function registerIdentity(token: string): Promise<void> {
    const { publicJwk } = await generateKeypair();
    const r = await call(identityRoutes, "/api/identities", token, postJson({ publicKey: publicJwk }));
    if (r.status !== 200) throw new Error(`identity register failed: ${r.status} ${r.text}`);
  }

  it("anonymous -> 401 on list", async () => {
    const res = await channelRoutes.fetch(new Request("http://localhost:3080/api/channels"));
    expect(res.status).toBe(401);
  });

  it("creating a channel without an identity -> 409 identity_required", async () => {
    const r = await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "build" }));
    expect(r.status).toBe(409);
    expect(r.text).toContain("identity_required");
  });

  it("creator is auto-joined and channel lists with count", async () => {
    await registerIdentity(aliceToken);
    const created = await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "build" }));
    expect(created.status).toBe(200);
    const list = await call(channelRoutes, "/api/channels", aliceToken);
    expect(list.body.channels[0]).toMatchObject({ name: "build", memberCount: 1, createdBy: `user:${alice}` });
  });

  it("duplicate channel name -> 409", async () => {
    await registerIdentity(aliceToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "dupe" }));
    expect((await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "dupe" }))).status).toBe(409);
  });

  it("joining a nonexistent channel -> 404", async () => {
    await registerIdentity(aliceToken);
    expect((await call(channelRoutes, "/api/channels/ghost/members", aliceToken, { method: "POST" })).status).toBe(404);
  });

  it("bad slug -> 400 INPUT_VALIDATION_ERROR through the mounted error handler", async () => {
    await registerIdentity(aliceToken);
    // The real server mounts the global error handler, which rewrites Elysia's
    // native 422 schema rejection into the shared structured body.
    const app = new Elysia().use(errorHandlerPlugin).use(channelRoutes);
    const res = await app.fetch(authedRequest("/api/channels", aliceToken, postJson({ name: "Bad Name" })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errId: string; statusCode: number };
    expect(body.code).toBe("INPUT_VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    expect(typeof body.errId).toBe("string");
  });

  it("post to a non-member recipient -> 400; to members -> 200", async () => {
    await registerIdentity(aliceToken);
    await registerIdentity(bobToken);
    expect((await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "chat" }))).status).toBe(200);
    const aliceP = `user:${alice}`;
    const bobP = `user:${bob}`;
    // bob not yet joined
    const bad = await call(
      channelRoutes,
      "/api/channels/chat/posts",
      aliceToken,
      postJson({ envelope: envelope("c", [bobP]), recipientIds: [bobP] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("not a member");
    // bob joins, then alice can address them
    expect((await call(channelRoutes, "/api/channels/chat/members", bobToken, { method: "POST" })).status).toBe(200);
    const ok = await call(
      channelRoutes,
      "/api/channels/chat/posts",
      aliceToken,
      postJson({ envelope: envelope("hello", [aliceP, bobP]), recipientIds: [aliceP, bobP] }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.seq).toBe(1);
  });

  it("post whose envelope kids don't match recipientIds -> 400", async () => {
    await registerIdentity(aliceToken);
    await registerIdentity(bobToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "pin" }));
    await call(channelRoutes, "/api/channels/pin/members", bobToken, { method: "POST" });
    const aliceP = `user:${alice}`;
    const bobP = `user:${bob}`;
    // Addresses [bob] in recipientIds but sealed ONLY to alice: bob would be
    // handed an undecryptable row that cursor-advancing reads silently skip.
    const bad = await call(
      channelRoutes,
      "/api/channels/pin/posts",
      aliceToken,
      postJson({ envelope: envelope("sneaky", [aliceP]), recipientIds: [bobP] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("recipientIds");
  });

  it("post by a non-member -> 403", async () => {
    await registerIdentity(aliceToken);
    await registerIdentity(bobToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "private-room" }));
    const bobP = `user:${bob}`; // registered, but never joined
    const bad = await call(
      channelRoutes,
      "/api/channels/private-room/posts",
      bobToken,
      postJson({ envelope: envelope("hi", [bobP]), recipientIds: [bobP] }),
    );
    expect(bad.status).toBe(403);
    expect(bad.text).toContain("not a member");
  });

  it("reads are recipient-filtered: bob never sees a post not addressed to him", async () => {
    await registerIdentity(aliceToken);
    await registerIdentity(bobToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "room" }));
    await call(channelRoutes, "/api/channels/room/members", bobToken, { method: "POST" });
    const aliceP = `user:${alice}`;
    const bobP = `user:${bob}`;
    // alice->alice only
    await call(
      channelRoutes,
      "/api/channels/room/posts",
      aliceToken,
      postJson({ envelope: envelope("private", [aliceP]), recipientIds: [aliceP] }),
    );
    // alice->bob
    await call(
      channelRoutes,
      "/api/channels/room/posts",
      aliceToken,
      postJson({ envelope: envelope("forbob", [bobP]), recipientIds: [bobP] }),
    );
    const bobRead = await call(channelRoutes, "/api/channels/room/posts?since=0", bobToken);
    expect(bobRead.body.posts.length).toBe(1);
    expect(bobRead.body.posts[0].author).toBe(aliceP);
    // The author is filtered too: alice addressed the second post to bob ONLY,
    // so even she does not receive it back (the server never leaks beyond the
    // recipient list — real senders include themselves, as subshell mcp does).
    const aliceRead = await call(channelRoutes, "/api/channels/room/posts?since=0", aliceToken);
    expect(aliceRead.body.posts.length).toBe(1);
    expect(aliceRead.body.posts[0].envelope).toContain("private");
  });

  it("mark=1 advances the cursor and `since` defaults to it", async () => {
    await registerIdentity(aliceToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "cur" }));
    const aliceP = `user:${alice}`;
    await call(
      channelRoutes,
      "/api/channels/cur/posts",
      aliceToken,
      postJson({ envelope: envelope("a", [aliceP]), recipientIds: [aliceP] }),
    );
    // read + mark
    const first = await call(channelRoutes, "/api/channels/cur/posts?mark=1", aliceToken);
    expect(first.body.nextSince).toBe(1);
    // default `since` is now the cursor=1, so nothing newer
    const second = await call(channelRoutes, "/api/channels/cur/posts?mark=1", aliceToken);
    expect(second.body.posts.length).toBe(0);
    // but explicit since=0 returns it again
    const backdated = await call(channelRoutes, "/api/channels/cur/posts?since=0", aliceToken);
    expect(backdated.body.posts.length).toBe(1);
  });

  it("long-poll with wait returns empty (not an error) after the timeout", async () => {
    await registerIdentity(aliceToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "idle" }));
    const t0 = Date.now();
    const r = await call(channelRoutes, "/api/channels/idle/posts?wait=1&since=0", aliceToken);
    expect(r.status).toBe(200);
    expect(r.body.posts.length).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("envelope shape is validated structurally", async () => {
    await registerIdentity(aliceToken);
    await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "env" }));
    const bad = await call(
      channelRoutes,
      "/api/channels/env/posts",
      aliceToken,
      postJson({ envelope: "x".repeat(40), recipientIds: [`user:${alice}`] }),
    );
    expect(bad.status).toBe(400);
    // A recipient slot without a plaintext kid is rejected too — the server
    // (and this pinning check) relies on kids being present (spec §3).
    const noKid = await call(
      channelRoutes,
      "/api/channels/env/posts",
      aliceToken,
      postJson({
        envelope: JSON.stringify({ iv: "i", tag: "t", ciphertext: "c", recipients: [{ encrypted_key: "k" }] }),
        recipientIds: [`user:${alice}`],
      }),
    );
    expect(noKid.status).toBe(400);
  });

  it("nudge types into running recipient sessions only, skipping the author", async () => {
    nudges.length = 0;
    class FakeTmux extends TmuxRunner {
      override sendInput(socket: string, sessionName: string, input: string): void {
        nudges.push({ socket, name: sessionName, text: input });
      }
    }
    setNudgeTransportForTests(new FakeTmux());
    try {
      await registerIdentity(aliceToken);
      await call(channelRoutes, "/api/channels", aliceToken, postJson({ name: "ping" }));
      // a running recipient session for bob
      const bobSess = crypto.randomUUID();
      createdSessions.push(bobSess);
      await new SessionsRepository(db).create({
        id: bobSess,
        userId: bob,
        profileId: "p",
        harnessId: "claude-code",
        name: "b",
        workingDir: "/tmp",
        tmuxSocket: "sock-b",
        alive: 1,
      });
      // Alice is already a member (creator). First post: no session recipients
      // addressed → nothing to nudge.
      await call(
        channelRoutes,
        "/api/channels/ping/posts",
        aliceToken,
        postJson({ envelope: envelope("x", [`user:${alice}`]), recipientIds: [`user:${alice}`], nudge: true }),
      );
      expect(nudges.length).toBe(0); // no sess recipients
      // Now add the bob session as a member via a session bearer token and nudge it.
      const key = await issueSessionToken(bobSess, bob);
      const { publicJwk } = await generateKeypair();
      const idres = await identityRoutes.fetch(
        new Request("http://localhost:3080/api/identities", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ publicKey: publicJwk }),
        }),
      );
      expect(idres.status).toBe(200);
      const res = await channelRoutes.fetch(
        new Request("http://localhost:3080/api/channels/ping/members", {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
        }),
      );
      expect(res.status).toBe(200);
      await call(
        channelRoutes,
        "/api/channels/ping/posts",
        aliceToken,
        postJson({ envelope: envelope("y", [`sess:${bobSess}`]), recipientIds: [`sess:${bobSess}`], nudge: true }),
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]).toMatchObject({ socket: "sock-b", name: bobSess });
      expect(nudges[0].text).toContain("#ping");
      // token hygiene
      const row = await new SessionsRepository(db).findById(bobSess);
      if (row?.apiKeyId) authDatabase().run("DELETE FROM apikey WHERE id = ?", [row.apiKeyId]);
    } finally {
      setNudgeTransportForTests(null);
    }
  });
});
