import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ensureSodium,
  generateLinkKeyPair,
  type LinkKeyPair,
  type Sodium,
} from "@internal/subshell-protocol/node-link-crypto";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/**
 * The server's static key for /ws/node link encryption — spec 2026-09-24 §3.
 *
 * A SECOND keypair beside the signing one, deliberately NOT derived from it:
 * one key one job, so a bug in one construction cannot reach the other. Same
 * lifecycle and rotation semantics as `node-signing.json`: lazy at first use
 * (the first enroll that has to answer `controlEncryptPublicKey`, or the first
 * handshake), persisted at mode 0600 — deliberately outside the DB, for the
 * same reason the signing store gives: databases get dumped more casually than
 * this dir, which already holds 0600 secrets.
 *
 * The stored shape diverges from signing on purpose: an X25519 kx seed pair as
 * base64 inside `{ publicKey, privateKey }` JSON rather than a JWK — the
 * libsodium native encoding, and this key NEVER signs anything, so the JWK
 * machinery (kty/crv/d) would describe a key type WebCrypto cannot even use.
 *
 * Fail-closed, mirroring `control-keys.ts`: only a genuinely missing file
 * (first run) generates a fresh pair. A PRESENT file that cannot be parsed or
 * lacks the expected shape is key material we cannot read — regenerating would
 * silently orphan every enrolled node (their pinned `controlEncryptPublicKey`
 * stops matching), so corruption throws, never rotates. Rotation is manual:
 * delete the file, every node's pin breaks, machines re-provision — the
 * warning `docs/security.md` already carries for the signing key applies
 * verbatim.
 */
const KEY_PATH = `${SUBSHELL_SERVER_DATA_DIR}/node-encryption.json`;

let cached: Promise<LinkKeyPair> | undefined;

/**
 * Load (or generate-once-and-persist) the link keypair. Singleton per
 * process: concurrent callers share one in-flight load, so a cold start can
 * never generate two pairs. A failed load clears the cache so the next call
 * retries — the refusal itself never mutates the file.
 */
export function loadNodeEncryptionKeys(): Promise<LinkKeyPair> {
  if (!cached) {
    cached = loadOrGenerate().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

async function loadOrGenerate(): Promise<LinkKeyPair> {
  const file = Bun.file(KEY_PATH);
  if (await file.exists()) {
    let parsed: unknown;
    try {
      parsed = await file.json();
    } catch (err) {
      throw new Error(`refusing to start node link encryption: ${KEY_PATH} is corrupt (${String(err)})`);
    }
    const pair = await asLinkKeyPair(parsed);
    if (!pair) {
      throw new Error(`refusing to start node link encryption: ${KEY_PATH} has an unexpected shape`);
    }
    return pair;
  }

  const fresh = await generateLinkKeyPair();
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  // writeFileSync only applies the mode when CREATING; chmod pins it exactly
  // even if a leftover file was already sitting at the path.
  chmodSync(KEY_PATH, 0o600);
  return fresh;
}

/**
 * Shape gate for a persisted pair: two base64 strings whose halves each decode
 * to 32 bytes. `from_base64` throws on non-canonical base64 — that is a wrong
 * shape, not a crash, so the throw is caught and answered `undefined` here.
 * The gate is async because decoding is the libsodium handle's job.
 */
async function asLinkKeyPair(value: unknown): Promise<LinkKeyPair | undefined> {
  if (typeof value !== "object" || value === null) return undefined;
  const { publicKey, privateKey } = value as Record<string, unknown>;
  if (typeof publicKey !== "string" || typeof privateKey !== "string") return undefined;
  const sodium = await ensureSodium();
  if (!decodesTo32(sodium, publicKey) || !decodesTo32(sodium, privateKey)) return undefined;
  return { publicKey, privateKey };
}

function decodesTo32(sodium: Sodium, value: string): boolean {
  try {
    return sodium.from_base64(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * The server's public half for the enroll response (agents pin it as
 * `controlEncryptPublicKey`). Returns the base64 public key string itself —
 * the link's on-text-frame encoding — not a JSON document; unlike signing's
 * `controlPublicJwkJson` there is nothing left to serialize.
 */
export async function nodeEncryptionPublicKey(): Promise<string> {
  return (await loadNodeEncryptionKeys()).publicKey;
}

/**
 * Clears the in-process cache. Test seam only — production callers must not
 * call this; @internal.
 */
export function resetNodeEncryptionKeysForTests(): void {
  cached = undefined;
}
