import type { NodeTarget } from "@internal/subshell-protocol";

/**
 * Single-use download credentials for the `update` command (spec 2026-09-15 §5.3).
 *
 * The problem they solve is narrow and structural: **a node key can do nothing
 * on REST** (security §5.5), so an agent has no credential with which to fetch
 * `GET /api/downloads/node/<target>` — which is the exact reason the
 * 2026-09-12 spec deferred plane-driven node updates. The alternatives were
 * both worse. Widening the node key to REST would give every enrolled machine
 * a credential on the control plane's HTTP surface to buy one download.
 * Streaming ~70 MB down the WebSocket would put a binary through a frame
 * channel capped at 1 MiB with no resumption, competing with live pane output.
 *
 * So the plane mints a token that is not a credential in any general sense:
 * it names ONE node and ONE platform triple, lives ten minutes, works once,
 * and grants exactly one download of a file the release source publishes
 * publicly anyway. "A node key can do nothing on REST" stays true as written —
 * the agent presents this, not its key.
 *
 * **In memory, never in the database.** A restart forgets every outstanding
 * token, and that is the correct behaviour rather than a gap: the agent's
 * download then 401s, it answers `NODE_RESULT_DOWNLOAD_FAILED`, and the route
 * reports it. An operator presses Update again and gets a fresh token. Storing
 * them would mean a table, a sweep and a migration to make a ten-minute value
 * survive an event that invalidates the command it belongs to anyway.
 *
 * **Only the HASH is held.** Same discipline as every other credential here:
 * the plaintext exists in the command frame and in the agent's memory, and a
 * heap dump or a log line of this map yields nothing usable.
 */

/** How long a minted token stays usable. */
export const UPDATE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Prefix every update token carries, so a stray one is identifiable at a glance. */
export const UPDATE_TOKEN_PREFIX = "nut_";

/** What the plane remembers about one outstanding token. */
interface TokenRecord {
  /** The node this token was minted for; a different node's download is refused. */
  nodeId: string;
  /** The platform triple it may fetch; any other target is refused. */
  target: NodeTarget;
  /** Epoch ms after which it is dead. */
  expiresAt: number;
  /** Set on first use; a second presentation is refused. */
  used: boolean;
}

const tokens = new Map<string, TokenRecord>();

/** Lowercase-hex sha256 of a token, which is all this module ever stores. */
function digest(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * Drop expired and used records.
 *
 * Called on every mint rather than on a timer: the map is bounded by how often
 * an operator presses Update, so a sweep here costs nothing, and a timer would
 * be one more thing holding a process open for a feature used a handful of
 * times a day.
 */
function sweep(now: number): void {
  for (const [key, record] of tokens) {
    if (record.used || record.expiresAt <= now) tokens.delete(key);
  }
}

/**
 * Mint a token for one node and one target.
 *
 * @returns the PLAINTEXT token — the only time it exists outside the command
 *   frame. The caller bakes it into the URL it sends and keeps no copy.
 */
export function mintUpdateToken(nodeId: string, target: NodeTarget): string {
  const now = Date.now();
  sweep(now);
  // 24 random bytes → 32 url-safe base64 characters, no padding: it travels in
  // a query string, so anything needing percent-encoding would be a trap for
  // whichever of the three consumers forgot.
  const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const token = `${UPDATE_TOKEN_PREFIX}${raw}`;
  tokens.set(digest(token), { nodeId, target, expiresAt: now + UPDATE_TOKEN_TTL_MS, used: false });
  return token;
}

/**
 * Spend a token for `target`, if it is valid, unused, unexpired and was minted
 * for this target.
 *
 * The target is checked rather than merely recorded: a token minted for a
 * linux-x64 node must not fetch the darwin binary, because the whole point of
 * the narrowing is that this credential buys ONE file.
 *
 * The node is NOT checked here, and cannot be: the download request carries no
 * node identity — that is what having no REST credential means. The token IS
 * the identity, which is why it is single-use and short-lived.
 *
 * @returns the node the token was minted for, or null when it may not be spent
 */
export function consumeUpdateToken(token: string, target: NodeTarget): string | null {
  const key = digest(token);
  const record = tokens.get(key);
  if (!record) return null;
  if (record.used || record.expiresAt <= Date.now()) {
    tokens.delete(key);
    return null;
  }
  if (record.target !== target) return null;
  // Marked AND deleted: `used` exists so a concurrent second read in the same
  // tick sees it, and the delete is what keeps the map from growing.
  record.used = true;
  tokens.delete(key);
  return record.nodeId;
}

/**
 * How many tokens are outstanding. Tests, and nothing else — the count is not
 * a fact any surface should render.
 * @internal
 */
export function outstandingUpdateTokens(): number {
  sweep(Date.now());
  return tokens.size;
}

/** Forget every token. Tests only. @internal */
export function resetUpdateTokensForTests(): void {
  tokens.clear();
}
