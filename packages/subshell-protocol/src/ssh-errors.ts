/**
 * The named SSH refusal/limit codes, frozen (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md):
 * a refused connection names its limitation rather than silently changing
 * connection semantics. One set for the whole feature: the node answers a refused
 * command with the BARE code as its `result{error}` string when the plane must
 * map it (the exact posture of the `NODE_RESULT_*` constants - the plane
 * compares `NodeRpcError.detail` by EQUALITY, never a substring, so a refusal
 * that wants a typed remedy is this string and nothing else); the resolution
 * and test result envelopes carry the same codes in their `code` fields; and
 * the server's policy refusals and API error metadata surface them verbatim.
 *
 * The set was FROZEN after Gate A and is carried verbatim from the reference
 * lineage (design 2026-10-05 §7); that lineage's retirement of the destination
 * execution product pruned the three quota/storage codes only ITS runtimes
 * emitted (`quota_runs`, `quota_terminals`, `storage_full`), a deletion that
 * was legal precisely because that lineage's protocol bump never released.
 * What this product line answers with today is resolution refusals; the
 * session-runtime sentences ride along because the set is carried frozen, not
 * because anything on this branch maps them. Adding a code is a coordinated
 * change; renaming or deleting one is a wire change like any other.
 *
 * Imports no `node:` builtin; this module is in the Metro-safe barrel.
 */

/** The refusal set as a runtime list. Exported beside the type because the parsers, the routes and the SPA all iterate it. */
export const SSH_ERROR_CODES = [
  /** Resolution found a setting the approved normalization cannot represent (`ProxyCommand`, forwards, tunnels, local commands, `RemoteCommand`, `SendEnv`, `SetEnv`, escapes, …). The resolve answer's `settings` list names which. */
  "unsupported_setting",
  /** The alias does not appear in the account's config (or an include) the discovery parsed. */
  "config_missing",
  /** The alias matches conflicting `Host` blocks the normalizer cannot uniquely order; a human edits the config or enters the destination differently. */
  "config_ambiguous",
  /** Strict host checking found no trust entry for the destination (or a hop). There is no accept endpoint in v1: the human trusts the key on the connecting account outside Subshell. */
  "host_key_unknown",
  /** The destination's key does not match the trusted entry. Fail closed; never an automatic re-trust. */
  "host_key_changed",
  /** The trusted entry is a revocation marker (`@revoked`) or the certificate chains to a revoked CA. */
  "host_key_revoked",
  /** A named identity file is unreadable or needs a passphrase no in-band path can answer (key unlocking lives outside Subshell). */
  "key_unavailable",
  /** The destination demands password, MFA or keyboard-interactive auth. v1 is key/certificate auth only. */
  "auth_mode_unsupported",
  /** The resolved `ProxyJump` chain exceeds {@link SSH_MAX_PROXY_HOPS}. */
  "proxy_chain_too_long",
  /**
   * A signed command arrived past its freshness window after a reconnect.
   * Rejecting it is the no-automatic-replay rule; the caller re-decides, the
   * node never does. RESERVED, emitted nowhere (review M8): the freshness
   * window the JWS signature carries is what actually refuses a stale start
   * (the signing layer rejects the expired command before any handler runs),
   * so no dispatch site names this code. It stays in the frozen set on purpose
   * - the wire grammar and every reader's equality table are protocol-frozen
   * and a bump cannot reclaim a removed name; the note is what keeps a future
   * reader from "fixing" the apparent dead code by emitting it.
   */
  "stale_command",
  /** A start carried an ID the node already accepted for a DIFFERENT request digest. Durable dedup refused it; nothing was spawned twice. The session-open dedup kept the spelling (design §3). */
  "run_conflict",
  /** The node never accepted this ID (or its record expired). A surviving equality code: the session arms answer it for an unknown session ref. */
  "run_unknown",
  /** The pre-spawn connect probe failed for no more specific reason - the session open's reachability probe kept this spelling too. The one code that must never be dressed up as a diagnosis. */
  "connection_failed",
  /**
   * The session-runtime probe found no runtime binary on the destination
   * (design 2026-10-05 §3: the `command -v` probe before the child spawns;
   * the design names this refusal `SSH_RUNTIME_MISSING`). The remedy is the
   * binary install ONLY - never enrollment, never `subshell setup` - and
   * `SSH_ERROR_DESCRIPTIONS` keeps it to exactly that sentence.
   */
  "runtime_missing",
  /** Opening a session was refused at the per-node active-session quota (design §3, sibling of `quota_terminals`). */
  "session_quota",
  /** The brokered child spoke something whose first frame is not a runtime hello (design §2: malformed leading bytes fail the open; the broker names it, the plane relays it). */
  "session_protocol",
  /**
   * The destination already carries a LIVE session: the second serve died at
   * its callback-door bind (review m2 - the door refuses a live listener, and
   * the bind site is the ONE enforcement point, since a plane-side
   * second-session gate would break §6's reopen-and-adopt journey). The
   * remedy is the other session - close it, do not touch the binary.
   */
  "session_in_use",
] as const;

/** One named refusal from {@link SSH_ERROR_CODES}. */
export type SshErrorCode = (typeof SSH_ERROR_CODES)[number];

/** Whether `value` is one of the frozen codes. */
export function isSshErrorCode(value: unknown): value is SshErrorCode {
  return typeof value === "string" && (SSH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * One honest sentence per code, for any surface that must explain a refusal
 * it cannot elaborate (MCP prose, SPA detail rows). Shipped strings: plain
 * words, no markup, no secrets, and each one names the remedy's LOCATION
 * (this account, this config, retry-later) because a code the human cannot
 * act on is a bug report waiting to be filed.
 */
export const SSH_ERROR_DESCRIPTIONS: Record<SshErrorCode, string> = {
  unsupported_setting:
    "The resolved SSH config needs a setting Subshell will not run (proxy commands, forwarding, tunnels, local commands, remote commands, or environment injection). Edit the config or choose another alias.",
  config_missing: "That alias is not in the connecting account's SSH config. Check the spelling or add it there.",
  config_ambiguous:
    "The alias matches conflicting config blocks that cannot be reduced to one destination. Simplify the config or enter the alias differently.",
  host_key_unknown:
    "The destination has no trusted host key on the connecting account. Trust it there first; Subshell never accepts keys on your behalf.",
  host_key_changed:
    "The destination's host key no longer matches the trusted entry. Verify out of band and update the entry on the connecting account.",
  host_key_revoked:
    "The trusted host key or certificate chain is revoked. Restore a valid trust entry on the connecting account.",
  key_unavailable:
    "A referenced identity key cannot be used as-is (unreadable, or passphrase-protected). Unlock or reconfigure it on the connecting account.",
  auth_mode_unsupported:
    "The destination requires password or interactive authentication. Subshell supports key and certificate auth only.",
  proxy_chain_too_long: "The jump-host chain is longer than Subshell will review and run. Shorten the ProxyJump path.",
  stale_command: "The request expired before it reached the node. Nothing ran; send it again if it should.",
  run_conflict:
    "A run with this ID already exists with different contents. The earlier request stands; this one was refused.",
  run_unknown:
    "This node has no record of that run. Its result may never have existed or its history expired; never assume it completed.",
  connection_failed:
    "The connection test failed. Check the destination, the network, and the connecting account's SSH setup.",
  runtime_missing:
    "The destination has no Subshell binary. Install the `subshell` binary there (the same install as any node's agent, without enrollment); no account setup or daemon is needed.",
  session_quota: "This machine already carries its share of open SSH sessions. Close one first.",
  session_protocol:
    "The destination answered the session open with something that is not the Subshell runtime's handshake. Check that the named program is the `subshell` binary.",
  session_in_use: "This destination already has a live session. Close that session there first, then connect again.",
};

/**
 * `result.error` from an input or prompt-delivery the node refused because its
 * per-pane generation had moved on: a takeover or a revocation fenced it.
 *
 * THE single frozen wire spelling for a generation refusal. There is
 * deliberately no matching member of `SSH_ERROR_CODES` (the Gate A review
 * ruled one event, one name): the plane matches `NodeRpcError.detail` against
 * THIS constant by equality, exactly like every other bare `NODE_RESULT_*`.
 * Relocated here from the retired run-facts module (design 2026-10-05 §7).
 * What keeps the spelling alive is the fence's SEAM, not its use: with the
 * destination product retired, nothing records a generation, so every pane
 * is an ordinary pane under the agent's deny-by-construction rule and this
 * refusal cannot fire today. The wire field, the monotonic mirror, and this
 * frozen answer are what the next control-transition feature adopts instead
 * of reinventing (the honest header: apps/node/agent/src/input-generation.ts).
 */
export const NODE_RESULT_SSH_GENERATION_STALE = "stale input generation";
