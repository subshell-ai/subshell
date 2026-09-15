import { type APIRequestContext, expect, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { BASE_URL } from "../ports";
import { generateKeypair, open, seal } from "../seal";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** A signed-in user with its own request context and registered ECDH identity. */
interface Person {
  /** Server-assigned principal label (`user:<id>` — identities upsert per principal). */
  principalId: string;
  publicJwk: string;
  privateJwk: string;
  ctx: APIRequestContext;
}

/**
 * Creates one user (via the admin fixture), signs in through a cookie-only
 * request context, and registers its identity — the order the channel routes
 * require (create/join 409 `identity_required` without a registration).
 */
async function makePerson(
  playwright: PlaywrightWorkerArgs["playwright"],
  request: APIRequestContext,
  email: string,
): Promise<Person> {
  const password = "e2e-channel-pass-1";
  const created = await request.post("/api/users", { data: { email, name: email, password, role: "user" } });
  expect(created.ok(), `create user ${email}`).toBeTruthy();

  // Empty storageState on purpose: playwright.request.newContext INHERITS the
  // test's storageState (admin cookie!), and a request that carries any cookie
  // makes better-auth's CSRF guard demand an Origin header (403
  // MISSING_OR_NULL_ORIGIN — Chromium strips a manually set one). A cookieless
  // first sign-in passes the guard and seeds this context's own jar, so each
  // user acts as its own principal.
  const ctx = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const signIn = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(signIn.ok(), `sign in ${email}`).toBeTruthy();

  const keys = await generateKeypair();
  const reg = await ctx.post("/api/identities", { data: { publicKey: keys.publicJwk, displayName: email } });
  expect(reg.ok(), `register identity ${email}`).toBeTruthy();
  const { principalId } = (await reg.json()) as { principalId: string };
  expect(principalId).toMatch(/^user:/);

  return { principalId, ctx, ...keys };
}

interface PostView {
  posts: { id: string; seq: number; author: string; envelope: string; createdAt: string }[];
  nextSince: number;
}

/**
 * API-level E2EE round-trip (channels have no browser UI): Alice seals a post
 * to Bob (+self), the server relays the opaque General JWE, Bob reads it back
 * and actually decrypts "hello bob", and Carol — neither member nor recipient
 * — sees an empty log. Sealing uses the real crypto from ../seal.ts (a thin
 * re-export of @internal/mcp-core — the same module the backend and agent run).
 */
test("sealed channel posts reach the recipient only", async ({ playwright, request }) => {
  // Three users + three sign-ins + the crypto round-trip; all HTTP, no browser.
  test.setTimeout(60_000);

  // Unique per attempt so a CI retry (config sets retries: 1) can't collide
  // with a prior attempt's leftover users/channel on 409 and mask the real
  // failure. Local runs use attempt 0 and share a fresh temp DB anyway.
  const nonce = test.info().retry;
  const room = `e2e-room-${nonce}`;

  const alice = await makePerson(playwright, request, `alice${nonce}@subshell.test`);
  const bob = await makePerson(playwright, request, `bob${nonce}@subshell.test`);
  const carol = await makePerson(playwright, request, `carol${nonce}@subshell.test`);

  try {
    // Creating a channel auto-enrolls the creator (channels.route.ts), so
    // Alice's membership is implicit; joining is self-service (the endpoint
    // adds c.principal), so Bob joins himself. Carol starts fully outside.
    const ch = await alice.ctx.post("/api/channels", { data: { name: room } });
    expect(ch.ok()).toBeTruthy();
    const bobJoin = await bob.ctx.post(`/api/channels/${room}/members`);
    expect(bobJoin.ok()).toBeTruthy();

    // Real senders seal to themselves too, and EVERY recipient must already
    // be a member (the posts handler 400s otherwise) — hence [bob, alice].
    const sealed = await seal("hello bob", [
      { principalId: bob.principalId, publicJwk: bob.publicJwk },
      { principalId: alice.principalId, publicJwk: alice.publicJwk },
    ]);
    const post = await alice.ctx.post(`/api/channels/${room}/posts`, { data: sealed });
    expect(post.ok()).toBeTruthy();

    // Bob reads the recipient-filtered log and opens the real envelope.
    const bobView = (await (await bob.ctx.get(`/api/channels/${room}/posts?since=0`)).json()) as PostView;
    expect(bobView.posts).toHaveLength(1);
    expect(bobView.posts[0].author).toBe(alice.principalId);
    expect(bobView.nextSince).toBe(bobView.posts[0].seq);
    const plaintext = await open(bobView.posts[0].envelope, {
      principalId: bob.principalId,
      publicJwk: bob.publicJwk,
      privateJwk: bob.privateJwk,
    });
    expect(plaintext).toBe("hello bob");

    // The author keeps a decryptable copy (sealed to self)…
    const aliceView = (await (await alice.ctx.get(`/api/channels/${room}/posts?since=0`)).json()) as PostView;
    expect(aliceView.posts).toHaveLength(1);

    // …while a non-recipient sees nothing. Assert 200 first so an error body
    // (missing `posts`) can't masquerade as the empty list we want.
    const carolRes = await carol.ctx.get(`/api/channels/${room}/posts?since=0`);
    expect(carolRes.status()).toBe(200);
    expect(((await carolRes.json()) as PostView).posts).toHaveLength(0);

    // Then Carol JOINS and re-reads: still empty. The join MUST succeed or the
    // re-read proves nothing; this pins filtering to the recipient list, not a
    // membership gate.
    const carolJoin = await carol.ctx.post(`/api/channels/${room}/members`);
    expect(carolJoin.ok(), "carol join").toBeTruthy();
    const carolJoined = (await (await carol.ctx.get(`/api/channels/${room}/posts?since=0`)).json()) as PostView;
    expect(carolJoined.posts).toHaveLength(0);
  } finally {
    for (const p of [alice, bob, carol]) await p.ctx.dispose();
  }
});
