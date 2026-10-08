import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJWK } from "jose";
import { identityPath, loadOrCreateIdentity, signingIdentityPath } from "../identity.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "subshell-id-"));
}

test("first load creates a P-256 keypair at 0600 with a private-free public JWK", async () => {
  const dir = freshDir();
  const id = await loadOrCreateIdentity(dir);
  const pub = JSON.parse(id.publicJwk);
  expect(pub).toMatchObject({ kty: "EC", crv: "P-256" });
  expect(typeof pub.x).toBe("string");
  expect(typeof pub.y).toBe("string");
  expect("d" in pub).toBe(false);
  expect(typeof JSON.parse(id.privateJwk).d).toBe("string");
  expect(statSync(identityPath(dir)).mode & 0o777).toBe(0o600);
});

test("second load reuses the exact same key material (no silent rotation)", async () => {
  const dir = freshDir();
  const first = await loadOrCreateIdentity(dir);
  const second = await loadOrCreateIdentity(dir);
  expect(second.publicJwk).toBe(first.publicJwk);
  expect(second.privateJwk).toBe(first.privateJwk);
});

test("corrupt identity file throws and is quarantined — never regenerated in place", async () => {
  const dir = freshDir();
  const first = await loadOrCreateIdentity(dir);
  writeFileSync(identityPath(dir), "{ definitely not json");
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/refusing to overwrite/i);
  // The unreadable file was moved aside, and the old key material is preserved there.
  expect(existsSync(identityPath(dir))).toBe(false);
  const quarantined = readdirSync(dir).filter((f) => f.includes("corrupt"));
  expect(quarantined.length).toBe(1);
  expect(readFileSync(join(dir, quarantined[0]), "utf8")).toContain("definitely not json");
  // Only AFTER quarantine may a fresh key be minted (and it differs from the first).
  const next = await loadOrCreateIdentity(dir);
  expect(next.publicJwk).not.toBe(first.publicJwk);
});

test("a data dir WE create is 0700 (key material lives inside)", async () => {
  const created = join(freshDir(), "nested", "data"); // does not exist → we create it
  await loadOrCreateIdentity(created);
  expect(statSync(created).mode & 0o777).toBe(0o700);
});

test("an existing data dir keeps the mode its owner gave it (no silent re-mode)", async () => {
  const dir = join(freshDir(), "loose");
  mkdirSync(dir);
  chmodSync(dir, 0o755); // e.g. a pre-seeded/shared location the operator set up
  await loadOrCreateIdentity(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o755);
});

test("valid JSON that is not a usable identity object routes to quarantine too", async () => {
  const dir = freshDir();
  writeFileSync(identityPath(dir), "null");
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/refusing to overwrite/i);
  expect(readdirSync(dir).some((f) => f.endsWith(".corrupt-parse"))).toBe(true);
});

// ── The M2 relay signing keypair (spec 2026-10-08 §4.1): an ES256 sibling of
// the ECDH pair with the SAME persistence discipline - 0600 file, ENOENT-only
// regeneration, private half never leaves the machine.

test("first load also mints an ES256 signing keypair at 0600 in the sibling file", async () => {
  const dir = freshDir();
  const id = await loadOrCreateIdentity(dir);
  const pub = JSON.parse(id.signingPublicJwk);
  expect(pub).toMatchObject({ kty: "EC", crv: "P-256" });
  expect(typeof pub.x).toBe("string");
  expect(typeof pub.y).toBe("string");
  expect("d" in pub).toBe(false);
  expect(typeof JSON.parse(id.signingPrivateJwk).d).toBe("string");
  // A real curve point, importable for ES256 verification; not a curve point
  // is exactly what the enroll route will refuse on this string.
  expect(await importJWK(pub, "ES256")).toBeDefined();
  // Sibling file, not the same file, and a genuinely different key.
  expect(signingIdentityPath(dir)).not.toBe(identityPath(dir));
  expect(id.signingPublicJwk).not.toBe(id.publicJwk);
  expect(statSync(signingIdentityPath(dir)).mode & 0o777).toBe(0o600);
});

test("second load reuses the exact same signing key (persisted, no silent rotation)", async () => {
  const dir = freshDir();
  const first = await loadOrCreateIdentity(dir);
  const second = await loadOrCreateIdentity(dir);
  expect(second.signingPublicJwk).toBe(first.signingPublicJwk);
  expect(second.signingPrivateJwk).toBe(first.signingPrivateJwk);
});

test("corrupt signing file quarantines only itself; the ECDH identity survives", async () => {
  const dir = freshDir();
  const first = await loadOrCreateIdentity(dir);
  writeFileSync(signingIdentityPath(dir), "{ definitely not json");
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/refusing to overwrite/i);
  // The signing file moved aside; the encryption identity is untouched.
  expect(existsSync(signingIdentityPath(dir))).toBe(false);
  expect(existsSync(identityPath(dir))).toBe(true);
  const quarantined = readdirSync(dir).filter((f) => f.includes("corrupt"));
  expect(quarantined.length).toBe(1);
  expect(quarantined[0]).toInclude("node-signing-identity");
  // Only after quarantine may a fresh signing key be minted, and the ECDH
  // pair rides through unchanged - one file's corruption rotates one key.
  const next = await loadOrCreateIdentity(dir);
  expect(next.signingPublicJwk).not.toBe(first.signingPublicJwk);
  expect(next.publicJwk).toBe(first.publicJwk);
  expect(statSync(signingIdentityPath(dir)).mode & 0o777).toBe(0o600);
});
