import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeypair } from "@internal/mcp-core";
import { hashPassword } from "better-auth/crypto";
import { identityRoutes } from "@/api/identities.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/** Identity registration is self-only by principal derivation; rotation works. */
describe("identities route", () => {
  let userId: string;
  let token: string;
  const email = `idn-${crypto.randomUUID()}@subshell.local`;
  const pw = "identity-pass-1";

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    token = await signIn(email, pw);
  });

  afterAll(async () => {
    await db.deleteFrom("identities").execute();
    await deleteUserByEmailOrId(email);
  });

  /** A real importable P-256 public JWK (what a legitimate registrant sends). */
  const realJwk = async () => (await generateKeypair()).publicJwk;

  async function register(body: unknown) {
    const res = await identityRoutes.fetch(
      authedRequest("/api/identities", token, { method: "POST", body: JSON.stringify(body) }),
    );
    return {
      status: res.status,
      data: res.ok ? await res.json() : null,
      text: res.ok ? "" : await res.text(),
    };
  }

  it("registers under the caller's derived principal", async () => {
    const r = await register({ publicKey: await realJwk(), displayName: "me" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ principalId: `user:${userId}`, displayName: "me" });
  });

  it("re-registration rotates the key", async () => {
    await register({ publicKey: await realJwk() });
    const k2 = await realJwk();
    const r = await register({ publicKey: k2 });
    expect(r.status).toBe(200);
    const res = await identityRoutes.fetch(authedRequest(`/api/identities/user:${userId}`, token));
    const got = (await res.json()) as { publicKey: string };
    expect(got.publicKey).toBe(k2);
  });

  it("rejects non-JSON publicKey with 400", async () => {
    const r = await register({ publicKey: "not-a-jwk-but-long-enough-padding" });
    expect(r.status).toBe(400);
  });

  // A key that parses but cannot be IMPORTED bricks seal() for every member
  // of every channel the registrant joins, so registration must prove it.
  it.each([
    ["an object with no key material", JSON.stringify({ kty: "EC", kid: "alice" })],
    ["a wrong kty", JSON.stringify({ kty: "oct", crv: "P-256", x: "aa", y: "bb" })],
    ["a wrong curve", JSON.stringify({ kty: "EC", crv: "P-384", x: "aa", y: "bb" })],
    ["non-base64url coordinates", JSON.stringify({ kty: "EC", crv: "P-256", x: "!!", y: "bb" })],
    [
      "an EC key with valid-looking but non-importable coordinates",
      JSON.stringify({ kty: "EC", crv: "P-256", x: "AAAA", y: "BBBB" }),
    ],
  ])("rejects %s as publicKey with 400", async (_label, publicKey) => {
    const r = await register({ publicKey });
    expect(r.status).toBe(400);
    expect(r.text).toContain("valid P-256 public JWK");
  });

  it("rejects a PRIVATE JWK (d component) with 400", async () => {
    const { privateJwk } = await generateKeypair();
    const r = await register({ publicKey: privateJwk });
    expect(r.status).toBe(400);
    expect(r.text).toContain("valid P-256 public JWK");
  });

  it("unknown principal -> 404", async () => {
    const res = await identityRoutes.fetch(authedRequest("/api/identities/user:ghost", token));
    expect(res.status).toBe(404);
  });

  it("anonymous -> 401", async () => {
    const res = await identityRoutes.fetch(new Request("http://localhost:3080/api/identities/user:anyone"));
    expect(res.status).toBe(401);
  });
});
