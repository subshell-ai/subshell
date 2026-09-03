import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ControlKeyPair, generateControlKeys } from "@internal/subshell-protocol";
import { SESSION_DATA_DIR } from "@/constants.js";

/**
 * Control-plane command-signing keypair store (spec 2026-08-31 §4). One ES256
 * keypair signs every command sent to every enrolled node.
 *
 * Generated lazily at first use and persisted as a JWK file at mode 0600 —
 * deliberately outside the DB (databases get dumped more casually than this
 * dir, which already holds 0600 secrets).
 *
 * Fail-closed, mirroring `mcp/identity-store.ts`: only a genuinely missing
 * file (first run) generates a fresh pair. A PRESENT file that cannot be
 * parsed or lacks the expected shape is key material we cannot read —
 * regenerating would silently orphan every enrolled node (their pinned public
 * half stops verifying our commands), so corruption throws, never rotates.
 */
const KEY_PATH = `${SESSION_DATA_DIR}/node-signing.json`;

let cached: Promise<ControlKeyPair> | undefined;

/**
 * Load (or generate-once-and-persist) the control keypair. Singleton per
 * process: concurrent callers share one in-flight load, so a cold start can
 * never generate two pairs. A failed load clears the cache so the next call
 * retries — the refusal itself never mutates the file.
 */
export function loadControlKeys(): Promise<ControlKeyPair> {
  if (!cached) {
    cached = loadOrGenerate().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

async function loadOrGenerate(): Promise<ControlKeyPair> {
  const file = Bun.file(KEY_PATH);
  if (await file.exists()) {
    let parsed: unknown;
    try {
      parsed = await file.json();
    } catch (err) {
      throw new Error(`refusing to start node signing: ${KEY_PATH} is corrupt (${String(err)})`);
    }
    if (!isControlKeyPair(parsed)) {
      throw new Error(`refusing to start node signing: ${KEY_PATH} has an unexpected shape`);
    }
    return parsed;
  }

  const fresh = await generateControlKeys();
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  // writeFileSync only applies the mode when CREATING; chmod pins it exactly
  // even if a leftover file was already sitting at the path.
  chmodSync(KEY_PATH, 0o600);
  return fresh;
}

/** Shape gate for a persisted pair: two JWK objects whose private half carries `d`. */
function isControlKeyPair(value: unknown): value is ControlKeyPair {
  if (typeof value !== "object" || value === null) return false;
  const { publicJwk, privateJwk } = value as Record<string, unknown>;
  if (typeof publicJwk !== "object" || publicJwk === null) return false;
  if (typeof privateJwk !== "object" || privateJwk === null) return false;
  return typeof (privateJwk as { d?: unknown }).d === "string";
}

/** The public half serialized for the enroll response (agents pin this). */
export async function controlPublicJwkJson(): Promise<string> {
  return JSON.stringify((await loadControlKeys()).publicJwk);
}

/**
 * Clears the in-process cache. Test seam only — production callers must not
 * call this; @internal.
 */
export function resetControlKeysForTests(): void {
  cached = undefined;
}
