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
import { identityPath, loadOrCreateIdentity } from "../identity.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "mote-agent-id-"));
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
