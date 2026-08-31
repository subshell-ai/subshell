import { describe, expect, it } from "bun:test";
import { generateKeypair, open, seal } from "@/mcp/crypto.js";

/**
 * Sealed delivery per the spike-verified jose recipe: one shared ciphertext,
 * one wrapped key per recipient, recipients located by plaintext `kid`.
 */
describe("mcp crypto (sealed delivery)", () => {
  const kpA = () => generateKeypair();
  const kpB = () => generateKeypair();

  it("round-trips text to multiple recipients, each opening their own slot", async () => {
    const a = await kpA();
    const b = await kpB();
    const { envelope, recipientIds } = await seal("hello both", [
      { principalId: "sess:a", publicJwk: a.publicJwk },
      { principalId: "sess:b", publicJwk: b.publicJwk },
    ]);
    expect(recipientIds.sort()).toEqual(["sess:a", "sess:b"]);
    expect(await open(envelope, { principalId: "sess:a", ...a })).toBe("hello both");
    expect(await open(envelope, { principalId: "sess:b", ...b })).toBe("hello both");
  });

  it("unicode and empty strings survive the round-trip", async () => {
    const a = await kpA();
    for (const text of ["", "héllo 🌍 中文", "a".repeat(10_000)]) {
      const { envelope } = await seal(text, [{ principalId: "p", publicJwk: a.publicJwk }]);
      expect(await open(envelope, { principalId: "p", ...a })).toBe(text);
    }
  });

  it("a non-recipient cannot open the envelope", async () => {
    const sender = await kpA();
    const stranger = await kpB();
    const { envelope } = await seal("secret", [{ principalId: "sess:sender", publicJwk: sender.publicJwk }]);
    await expect(open(envelope, { principalId: "sess:stranger", ...stranger })).rejects.toThrow(
      /no recipient slot|not a recipient/i,
    );
  });

  it("tampering with ciphertext fails authentication", async () => {
    const a = await kpA();
    const { envelope } = await seal("integrity", [{ principalId: "p", publicJwk: a.publicJwk }]);
    const env = JSON.parse(envelope) as { ciphertext: string };
    env.ciphertext = env.ciphertext.slice(0, -4) + (env.ciphertext.endsWith("A") ? "BBBB" : "AAAA");
    await expect(open(JSON.stringify(env), { principalId: "p", ...a })).rejects.toThrow();
  });

  it("envelope carries no plaintext and is modest in size", async () => {
    const a = await kpA();
    const b = await kpB();
    const { envelope } = await seal("plaintext-canary-value", [
      { principalId: "sess:a", publicJwk: a.publicJwk },
      { principalId: "sess:b", publicJwk: b.publicJwk },
    ]);
    expect(envelope).not.toContain("plaintext-canary-value");
    expect(envelope.length).toBeLessThan(2500);
  });

  it("generated keypairs are P-256 ECDH JWKs", async () => {
    const kp = await kpA();
    const jwk = JSON.parse(kp.publicJwk) as Record<string, unknown>;
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.d).toBeUndefined(); // public half has no private scalar
    const priv = JSON.parse(kp.privateJwk) as Record<string, unknown>;
    expect(priv.d).toBeTruthy();
  });
});
