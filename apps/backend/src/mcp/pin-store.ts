import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SealRecipient } from "@/mcp/crypto.js";
import { resolveMcpDataDir } from "@/mcp/env.js";

/**
 * Trust-on-first-use (TOFU) pin store for channel PEER keys.
 *
 * The channel roster (which inlines every member's public JWK) is served by
 * the relay — and the whole point of the E2EE boundary is that the relay is
 * NOT trusted (see `.claude/rules/security-context.md`, "Encrypted channels").
 * Sealing to whatever the roster says on every post would let a compromised
 * server swap its own keypair into a victim's roster slot and read every
 * message, undetectably by the sender. This module is the trust layer that
 * closes that hole: the first time a principal is sealed to, its exact public
 * JWK string is pinned under `<dataDir>/peers.json` (mode 0600); every later
 * post requires byte-equality, and a change throws instead of silently
 * resealing. Genuine rotations are rare and verifiable out-of-band, so
 * failing loudly is the correct default.
 *
 * Escape hatch: `MOTE_CHANNEL_PIN=trust` restores the unpinned
 * fetch-and-seal behaviour (no checks, no file touched). Anything else —
 * including unset or a typo — means strict pinning. Like the rest of the MCP
 * env contract (`mcp/env.ts`), the variable is read ONCE at module init; the
 * process never re-derives it.
 *
 * Deliberately NOT in `crypto.ts`: `seal` stays pure crypto; pinning is a
 * policy of the tool path (`postChannel`). Failures are loud by design —
 * a corrupt pin file is moved aside to `.corrupt-*` and throws (the pin set
 * is never silently reset), and the mismatch message names the exact file an
 * operator must edit to re-learn a rotated peer.
 */

/** How strictly peer keys are trusted (`MOTE_CHANNEL_PIN`). */
export type PinMode = "strict" | "trust";

/** Env-derived settings, snapshotted once at module init. */
interface PinSettings {
  /** Pinning strictness for this process. */
  mode: PinMode;
  /** Absolute path of the pin file (`<dataDir>/peers.json`). */
  file: string;
}

/** Reads the pin-related env, following the `readMcpEnv(env)` pattern. */
function readPinSettings(env: NodeJS.ProcessEnv): PinSettings {
  return {
    mode: env.MOTE_CHANNEL_PIN?.trim().toLowerCase() === "trust" ? "trust" : "strict",
    file: join(resolveMcpDataDir(env), "peers.json"),
  };
}

let settings = readPinSettings(process.env);

/** Thrown when a pinned peer's roster key differs from the pinned JWK. */
export class PinnedKeyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedKeyMismatchError";
  }
}

/**
 * Re-snapshots the env-derived settings. The real process never calls this
 * (env is read once at module init, per the mcp/env.ts contract); tests use
 * it to exercise alternate `MOTE_CHANNEL_PIN` / `MOTE_DATA_DIR` values
 * without respawning.
 * @internal
 */
export function reloadPinSettingsForTests(env: NodeJS.ProcessEnv = process.env): void {
  settings = readPinSettings(env);
}

/**
 * Verifies every recipient against the pin set and pins any first-seen
 * principal (trust on first use). In `trust` mode this is a complete no-op —
 * no read, no write, no check.
 *
 * @param recipients — exactly what `postChannel` is about to seal to
 * @throws PinnedKeyMismatchError when a pinned principal's key changed —
 *   peer rotation or a relay substitution; nothing is sealed or sent.
 * @throws Error when the pin file exists but cannot be read or parsed — the
 *   file is moved aside to `<file>.corrupt-*` and the post is refused
 *   (fail-closed: an unreadable pin set must not silently become "no pins").
 */
export function checkAndPinRecipients(recipients: SealRecipient[]): void {
  if (settings.mode === "trust") return;
  const file = settings.file;
  const pinned = loadPeers(file);
  const fresh: SealRecipient[] = [];
  for (const r of recipients) {
    if (!pinned.has(r.principalId)) {
      fresh.push(r);
      continue;
    }
    if (pinned.get(r.principalId) !== r.publicJwk) {
      throw new PinnedKeyMismatchError(
        `mote: pinned key for ${r.principalId} changed — peer key rotation or a relay substitution. ` +
          `Verify out-of-band, then delete the '${r.principalId}' entry from ${file} to re-learn.`,
      );
    }
  }
  if (fresh.length === 0) return;
  for (const r of fresh) pinned.set(r.principalId, r.publicJwk);
  savePeers(file, pinned);
}

/**
 * Reads the pin file. ENOENT (first run) means an EMPTY pin set; any other
 * read or parse failure is quarantined and thrown — never treated as empty.
 */
function loadPeers(file: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error(`mote: cannot read peer pin file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top level is not a JSON object");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [principalId, key] of entries) {
      if (typeof key !== "string") throw new Error(`entry '${principalId}' is not a JWK string`);
    }
    return new Map(entries as [string, string][]);
  } catch (err) {
    quarantineCorrupt(file, err);
  }
}

/** Moves an unparseable pin file aside and throws (fails the post closed). */
function quarantineCorrupt(file: string, cause: unknown): never {
  const aside = `${file}.corrupt-${Date.now()}`;
  renameSync(file, aside);
  throw new Error(
    `mote: peer pin file is corrupt (${cause instanceof Error ? cause.message : String(cause)}); ` +
      `moved ${file} aside to ${aside} and refusing to seal — the pin set was NOT reset. ` +
      `Restore the file by hand, or let the next post re-learn every peer after verifying them out-of-band.`,
  );
}

/** Writes the whole pin map back, mode 0600, keys sorted for stable diffs. */
function savePeers(file: string, pinned: Map<string, string>): void {
  mkdirSync(dirname(file), { recursive: true });
  const obj: Record<string, string> = {};
  for (const [principalId, key] of [...pinned].sort(([a], [b]) => a.localeCompare(b))) {
    obj[principalId] = key;
  }
  writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
