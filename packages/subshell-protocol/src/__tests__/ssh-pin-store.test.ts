import { expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { base64UrlNoPad, base64UrlToBytes, bytesOfJwk, fingerprintJwk } from "../ssh-pin-store.js";

/**
 * A fresh P-256 public JWK, exactly the shape the relay carries: the ES256
 * signing key and the ECDH-ES encryption key are both EC P-256, and only the
 * PUBLIC half is ever fingerprinted (spec 2026-10-08 §4.5). node:crypto
 * generates it because Bun's WebCrypto lacks EC key generation entirely (the
 * gap the pure module under test is built to sidestep); the module itself
 * imports no node builtin.
 */
function freshPublicJwk(): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  expect("d" in jwk).toBe(false);
  return jwk;
}

test("fingerprintJwk renders OpenSSH notation: SHA256: over 43 base64url chars, no padding", async () => {
  const jwk = freshPublicJwk();
  const fp = await fingerprintJwk(JSON.stringify(jwk));
  expect(fp.startsWith("SHA256:")).toBe(true);
  // SHA-256 is 32 bytes: 43 base64url characters with the '=' padding dropped,
  // and no '+' or '/' anywhere in the alphabet.
  expect(fp.slice("SHA256:".length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("two JWK serializations of the SAME key (different member order) share one fingerprint", async () => {
  // THE load-bearing property: the preimage is the DER SubjectPublicKeyInfo,
  // never a JSON serialization, so key order in the JWK text is irrelevant
  // (spec 2026-10-08 §4.5: "never a JSON-JWK serialization (which is not
  // canonical)").
  const jwk = freshPublicJwk();
  const a = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const b = JSON.stringify({ y: jwk.y, x: jwk.x, kty: jwk.kty, crv: jwk.crv, ext: true, key_ops: ["verify"] });
  expect(a).not.toBe(b);
  expect(await fingerprintJwk(a)).toBe(await fingerprintJwk(b));
});

test("two different keys get two different fingerprints", async () => {
  const one = freshPublicJwk();
  const two = freshPublicJwk();
  expect(await fingerprintJwk(JSON.stringify(one))).not.toBe(await fingerprintJwk(JSON.stringify(two)));
});

test("bytesOfJwk is the DER SPKI, byte-identical to node:crypto's independent encoder", () => {
  // The hand-built fixed-head encoding must match a real X.509 encoder
  // exactly, or the fingerprint is a private dialect, not the SubjectPublicKeyInfo.
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  expect(bytesOfJwk(jwk)).toEqual(new Uint8Array(der));
  expect(bytesOfJwk(JSON.stringify(jwk))).toEqual(new Uint8Array(der));
});

test("the fingerprint is SHA-256 over that DER, verified against an independent node:crypto path", async () => {
  // node:crypto is used HERE (a test file) only to double-check the module's
  // own path with a different encoder and hasher; the module stays node-free.
  const jwk = freshPublicJwk();
  const der = createPublicKey({ key: jwk as never, format: "jwk" }).export({ type: "spki", format: "der" });
  const expected = `SHA256:${createHash("sha256").update(der).digest("base64url")}`;
  expect(await fingerprintJwk(JSON.stringify(jwk))).toBe(expected);
});

test("fingerprintJwk accepts the JWK as an object as well as a string", async () => {
  const jwk = freshPublicJwk();
  expect(await fingerprintJwk(jwk)).toBe(await fingerprintJwk(JSON.stringify(jwk)));
});

test("private material and junk are refused, never fingerprinted", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  expect("d" in privateJwk).toBe(true);
  expect(() => bytesOfJwk(privateJwk)).toThrow(/private/i);
  await expect(fingerprintJwk(JSON.stringify(privateJwk))).rejects.toThrow(/private/i);
  expect(() => bytesOfJwk("{ not json")).toThrow();
  expect(() => bytesOfJwk(JSON.stringify({ kty: "oct", k: "aaa" }))).toThrow();
  expect(() => bytesOfJwk(JSON.stringify({ kty: "EC", crv: "P-384", x: "AAA", y: "BBB" }))).toThrow(/P-256/);
  expect(() => bytesOfJwk(JSON.stringify({ kty: "EC", crv: "P-256", x: "!!!" }))).toThrow();
});

test("base64url round trip is pure and padding-free", () => {
  const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0x23, 0x45]);
  const encoded = base64UrlNoPad(bytes);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(base64UrlToBytes(encoded)).toEqual(bytes);
  expect(() => base64UrlToBytes("====")).toThrow();
  // The alphabet is the URL-safe one: 0xFB 0xFF encodes as '-' '_' where
  // standard base64 would put '+' '/'.
  expect(base64UrlNoPad(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
  expect(base64UrlToBytes("-_8")).toEqual(Uint8Array.from([0xfb, 0xff]));
});

test("ssh-pin-store.ts is Metro-safe: no node: builtin import in CODE", () => {
  // This package's barrel reaches apps/client/mobile through Metro, which
  // cannot resolve `node:*` (see the NOTE in src/index.ts). Comments carry the
  // words "node:" and "Buffer" as PROSE, so the scanned text is the code with
  // comments stripped.
  const source = readFileSync(new URL("../ssh-pin-store.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  expect(source).not.toMatch(/from\s+["']node:/);
  expect(source).not.toMatch(/require\(\s*["']node:/);
  expect(source).not.toMatch(/\bBuffer\b/);
  expect(source).not.toMatch(/await\s+import\(/);
});
