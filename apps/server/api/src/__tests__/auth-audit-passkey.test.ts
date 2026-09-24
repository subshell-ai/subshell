import { beforeAll, describe, expect, it } from "bun:test";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * The passkey sign-in audit path (security audit 2026-09 item R1) exercised
 * for real: passkey sign-in runs through `/passkey/verify-authentication`,
 * whose handler ends in `verifyAuthenticationResponse` (@simplewebauthn/server
 * 13), so the test forges a complete authenticator assertion — a P-256 key,
 * its COSE encoding as the stored `publicKey`, and a signature over
 * `authenticatorData || sha256(clientDataJSON)` — rather than mocking the
 * verifier. The `passkey` row is inserted directly, standing in for the
 * registration ceremony (which this audit does not touch).
 *
 * The contract under test is one line in `@/auth/audit-hooks`: that endpoint
 * SUCCEEDING writes `auth.sign_in` with `{ method: "passkey" }` — and the
 * session token the same response carries appears nowhere in the row.
 */

const b64url = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64url");

/** COSE EC2 public key (P-256 / ES256), hand-encoded CBOR: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function coseEc2PublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  const byteString = (b: Uint8Array): number[] => [0x58, b.length, ...b];
  return new Uint8Array([
    0xa5, // map(5)
    0x01,
    0x02, // kty: EC2
    0x03,
    0x26, // alg: -7 (ES256)
    0x20,
    0x01, // crv: 1 (P-256)
    0x21,
    ...byteString(x), // x-coordinate
    0x22,
    ...byteString(y), // y-coordinate
  ]);
}

describe("passkey sign-in audit (auth.sign_in method=passkey)", () => {
  beforeAll(async () => {
    await setupAuthTables();
  });

  it("a successful passkey verification writes exactly one auth.sign_in with method=passkey", async () => {
    const email = `auth-audit-pk-${crypto.randomUUID()}@subshell.local`;
    const userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      // Any hash: the password is never exercised here, the row only needs
      // to exist for the passkey's foreign key.
      passwordHash: "not-a-real-hash",
      role: "user",
    });

    // Authenticator: a fresh P-256 keypair, its COSE encoding stored exactly
    // as verify-registration would store it (standard base64, padded).
    const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pub.export({ format: "jwk" });
    if (!jwk.x || !jwk.y) throw new Error("P-256 JWK export missing coordinates");
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    const credentialId = randomBytes(16);
    const credentialIdB64 = b64url(credentialId);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO passkey
        (id, "userId", "credentialID", "publicKey", counter, "deviceType", "backedUp", transports, "createdAt")
      VALUES
        (${crypto.randomUUID()}, ${userId}, ${credentialIdB64}, ${Buffer.from(coseEc2PublicKey(x, y)).toString("base64")},
         ${0}, ${"platform"}, ${0}, ${""}, ${now})
    `.execute(db);

    // Challenge ceremony, through the real endpoint: it writes the
    // verification row and the signed challenge cookie the verify needs.
    const genRes = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/passkey/generate-authenticate-options", {
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect(genRes.status).toBe(200);
    const options = (await genRes.json()) as { challenge: string };
    expect(typeof options.challenge).toBe("string");
    const challengeCookie = (genRes.headers.get("set-cookie") ?? "").split(";")[0];
    expect(challengeCookie).toContain("=");

    // Forge the assertion: rpID "localhost" is better-auth's own derivation
    // from the configured baseURL (host localhost:3080); flags UP|UV; counter 1.
    const origin = "http://localhost:5173";
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }),
    );
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, 1]),
    ]);
    const signature = createSign("sha256")
      .end(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
      .sign(priv);

    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: challengeCookie },
        body: JSON.stringify({
          response: {
            id: credentialIdB64,
            rawId: credentialIdB64,
            type: "public-key",
            response: {
              clientDataJSON: b64url(clientData),
              authenticatorData: b64url(authData),
              signature: b64url(signature),
              userHandle: "",
            },
          },
        }),
      }),
    );
    const body = await res.text();
    expect(res.status, `verify failed: ${body}`).toBe(200);
    // The proof it was a real sign-in: better-auth minted and set a session.
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");

    const rows = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("action", "=", "auth.sign_in")
      .where("actorUserId", "=", userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadataJson).toBe(JSON.stringify({ method: "passkey" }));
    expect(rows[0]?.targetId).toBe(userId);

    // No token anywhere in the row — the 200 body carries one.
    const setCookie = res.headers.get("set-cookie") ?? "";
    const token = setCookie.match(/better-auth\.session_token=([^;]+)/)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(JSON.stringify(rows[0])).not.toContain(token);

    await deleteUserByEmailOrIdLocal(email);
  });

  async function deleteUserByEmailOrIdLocal(email: string): Promise<void> {
    await sql`DELETE FROM user WHERE email = ${email}`.execute(db);
  }
});
