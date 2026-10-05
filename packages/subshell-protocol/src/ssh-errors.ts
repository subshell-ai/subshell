/**
 * The named SSH refusal/limit codes, frozen (SSH-SUPPORT.md §2/§3: "refuse
 * with a named limitation rather than silently changing connection
 * semantics"). One set for the whole feature: the node answers a refused
 * command with the BARE code as its `result{error}` string when the plane must
 * map it (the exact posture of the `NODE_RESULT_*` constants - the plane
 * compares `NodeRpcError.detail` by EQUALITY, never a substring, so a refusal
 * that wants a typed remedy is this string and nothing else); the resolution
 * and test result envelopes carry the same codes in their `code` fields; and
 * the server's policy refusals and API error metadata surface them verbatim.
 *
 * The set is FROZEN after Gate A: four workstreams are writing matchers
 * against these spellings. Adding a code is a coordinated change; renaming or
 * deleting one is a wire change like any other.
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
  /** Starting a run was refused at the per-owner or per-node active-run quota. */
  "quota_runs",
  /** Opening a managed terminal was refused at the per-owner per-node terminal quota. */
  "quota_terminals",
  /** The node's aggregate SSH output store is full; completed output was already evicted (SSH-SUPPORT.md §3's pressure rule), so this is the "still full" refusal. */
  "storage_full",
  /** A signed command arrived past its freshness window after a reconnect. Rejecting it is the no-automatic-replay rule; the caller re-decides, the node never does. */
  "stale_command",
  /** A start carried an ID the node already accepted for a DIFFERENT request digest. Durable dedup refused it; nothing was spawned twice. */
  "run_conflict",
  /** A status/read/cancel named a run ID this node never accepted or has expired. Unknown IDs are never reusable start requests (SSH-SUPPORT.md §3, Durable dispatch). */
  "run_unknown",
  /** The fixed connection-test probe failed for no more specific reason. The one code that must never be dressed up as a diagnosis. */
  "connection_failed",
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
  quota_runs: "Too many SSH commands are running for this quota right now. Wait for one to finish or cancel it.",
  quota_terminals: "This account already has its share of open SSH terminals on that node. Close one first.",
  storage_full:
    "The node's SSH output store is full and cannot evict enough to accept new work. Delete old run history on the node.",
  stale_command: "The request expired before it reached the node. Nothing ran; send it again if it should.",
  run_conflict:
    "A run with this ID already exists with different contents. The earlier request stands; this one was refused.",
  run_unknown:
    "This node has no record of that run. Its result may never have existed or its history expired; never assume it completed.",
  connection_failed:
    "The connection test failed. Check the destination, the network, and the connecting account's SSH setup.",
};
