import { expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlNoPad } from "@internal/subshell-protocol";
import { identityPath, signingIdentityPath } from "../identity.js";
import { MachinePinStore, machinePinPath } from "../machine-pin-store.js";
import { buildSshFingerprintReport } from "../ssh-fingerprint-report.js";

/**
 * The §4.6 trust block the node reports from its OWN files (spec 2026-10-08).
 * The expected digests are derived through node:crypto here, independently of
 * `fingerprintJwk` (whose DER preimage is pinned byte-identical to node:crypto's
 * own encoder in the protocol package): the composition pins WHICH key lands
 * in WHICH slot, not the hash.
 */

/** node:crypto's independent digest of a public JWK string, unpadded base64url. */
function nodeFp(jwkJson: string): string {
  const key = createPublicKey({ key: JSON.parse(jwkJson), format: "jwk" });
  const spki = key.export({ type: "spki", format: "der" });
  return base64UrlNoPad(new Uint8Array(createHash("sha256").update(spki).digest()));
}

/** A fresh P-256 public key as its raw JWK string. */
function freshJwk(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return JSON.stringify(publicKey.export({ format: "jwk" }));
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "subshell-sshfp-"));
}

/** The public half stored in one keypair file. */
function publicJwkIn(file: string): string {
  return (JSON.parse(readFileSync(file, "utf8")) as { publicJwk: string }).publicJwk;
}

test("own comes from the identity files: signing from node-signing-identity.json, encryption from identity.json", async () => {
  const dir = freshDir();
  const report = await buildSshFingerprintReport(dir);
  // First run generates through the ordinary loadOrCreateIdentity path, and
  // the report then reads back exactly what the files hold.
  expect(report.own.encryption).toBe(`SHA256:${nodeFp(publicJwkIn(identityPath(dir)))}`);
  expect(report.own.signing).toBe(`SHA256:${nodeFp(publicJwkIn(signingIdentityPath(dir)))}`);
  expect(report.peers).toEqual([]);
  // The builder is a READ path: it never mints the pin file just to say "empty".
  expect(existsSync(machinePinPath(dir))).toBe(false);
});

test("peers come from the machine pin store, sorted by nodeId, both halves fingerprinted", async () => {
  const dir = freshDir();
  const a = freshJwk();
  const b = freshJwk();
  // Insertion order is deliberately reversed against the sorted output.
  new MachinePinStore(dir).pin("f0000000-0000-4000-8000-000000000002", { signing: b, encryption: a });
  new MachinePinStore(dir).pin("f0000000-0000-4000-8000-000000000001", { signing: a, encryption: b });
  const report = await buildSshFingerprintReport(dir);
  expect(report.peers).toEqual([
    {
      nodeId: "f0000000-0000-4000-8000-000000000001",
      signing: `SHA256:${nodeFp(a)}`,
      encryption: `SHA256:${nodeFp(b)}`,
    },
    {
      nodeId: "f0000000-0000-4000-8000-000000000002",
      signing: `SHA256:${nodeFp(b)}`,
      encryption: `SHA256:${nodeFp(a)}`,
    },
  ]);
});

test("a corrupt pin file throws (fail closed, the store's doctrine), and the report never invents a peer set", async () => {
  const dir = freshDir();
  writeFileSync(machinePinPath(dir), "}{ not json");
  await expect(buildSshFingerprintReport(dir)).rejects.toThrow();
});
