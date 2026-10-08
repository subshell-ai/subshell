/**
 * The approved normalized connection snapshot (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md,
 * section 5.2). Configuration here is executable, not passive data.
 *
 * This is the ONLY connection shape the wire ever carries. OpenSSH config can
 * start local helpers, forward ports and reuse ambient sockets, so nothing
 * here is a passthrough: the human-facing resolution step produces this shape
 * once, and the NODE re-validates it with {@link
 * parseSshConnectionSnapshot} on EVERY command that embeds a snapshot (of the
 * destination product's four, only the resolve command survives; its node-side
 * dispatch is not wired on this tier). The plane approving a snapshot is not
 * the load-bearing defense - this validator refusing a forbidden member is, on
 * the machine that will actually run ssh.
 *
 * The eight absent-forbidden members (`proxyCommand`, `forwards`, `tunnels`,
 * `localCommands`, `remoteCommand`, `sendEnv`, `setEnv`, `escapes`) are typed
 * as literal `null` ON PURPOSE: they exist in the shape to be refused. A
 * resolver that faithfully recorded a `ProxyCommand` produced a value this
 * parser rejects, which is the "refuse with a named limitation rather than
 * silently changing connection semantics" rule expressed in grammar. The
 * runtime check is stricter than the type: any present non-null value fails,
 * so hand-built JSON cannot smuggle one past TypeScript.
 *
 * Hand-rolled in the `node-frames.ts` validator style; imports no `node:`
 * builtin; lives in the Metro-safe barrel.
 */

import { isInt, isRecord, isStr } from "./guards.js";
import {
  SSH_MAX_CERT_REFS,
  SSH_MAX_IDENTITY_REFS,
  SSH_MAX_KNOWN_HOSTS_FILES,
  SSH_MAX_PROXY_HOPS,
  SSH_NAME_MAX_CHARS,
  SSH_PATH_MAX_CHARS,
} from "./ssh-limits.js";

/**
 * One ProxyJump hop as the approved snapshot carries it: a destination and
 * nothing else. Hops are normalized "under the same restrictions" as the
 * final destination (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md) - they never carry identity files or
 * options; authentication for the whole chain comes from the snapshot's own
 * refs, which is what makes the chain reviewable as a route.
 *
 * A `type` alias, not an interface: snapshots ride inside JSON command fields,
 * and an interface has no implicit index signature.
 */
export type SshHopWire = {
  /** Hop hostname (same hygiene as the destination host) */
  host: string;
  /** Hop user; null = the connecting account's default */
  user: string | null;
  /** Hop port, already resolved (an absent `Port` means 22) */
  port: number;
};

/**
 * A resolved, approved SSH destination, normalized to the settings the approved
 * grammar supports and nothing more. Persisted server-side per connection revision and
 * embedded verbatim in every node command that connects.
 */
export interface SshConnectionSnapshotWire {
  /**
   * The config token the human chose (display and review context only -
   * routing uses `host`, and a manual alias with no config behind it still
   * carries the destination it resolved to).
   */
  alias: string;
  /** Resolved destination hostname. Never an option-like string: the validator refuses a leading `-`. */
  host: string;
  /** Destination user; null means the connecting account's own default */
  user: string | null;
  /** Destination port, resolved (1..65535; a default-until-resolved `Port` never reaches the wire as 0) */
  port: number;
  /**
   * Identity file references: ABSOLUTE POSIX paths on the CONNECTING NODE,
   * never key contents. Credential material stays where the OS put it.
   */
  identityFiles: string[];
  /** Certificate file references (OpenSSH allows several `CertificateFile` lines), same path-only rule. */
  certificateFiles: string[];
  /**
   * The authentication-agent socket to use: an absolute path from the
   * connecting account's trusted setup, or null to run with no agent. An
   * already-unlocked agent MAY be used (the key home's agent, per
   * docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md); this field is
   * the only channel through which one is named.
   */
  authAgentSocket: string | null;
  /** Known-hosts files to consult. Revocation/CA semantics inside them are the runtime's to preserve; the refs are the snapshot's to carry. */
  knownHostsFiles: string[];
  /** OpenSSH `HostKeyAlias` when the config sets one; the name strict checking looks up. */
  hostKeyAlias: string | null;
  /** Bounded ProxyJump chain, outermost first, at most {@link SSH_MAX_PROXY_HOPS} hops. */
  proxyJumps: SshHopWire[];
  /** Literal null: a resolved `ProxyCommand` makes this snapshot REFUSABLE, never renderable. */
  proxyCommand: null;
  /** Literal null: `LocalForward`/`RemoteForward`/`DynamicForward` found at resolution fail setup. */
  forwards: null;
  /** Literal null: `Tunnel`/`PermitRemoteOpen` found at resolution fail setup. */
  tunnels: null;
  /** Literal null: `LocalCommand`, `PermitLocalCommand`, or a `Match exec` found at resolution fail setup. */
  localCommands: null;
  /** Literal null: `RemoteCommand` found at resolution fails setup; it would replace the command contract. */
  remoteCommand: null;
  /** Literal null: `SendEnv` found at resolution fails setup; no environment rides the link. */
  sendEnv: null;
  /** Literal null: `SetEnv` found at resolution fails setup; same reason, remote side. */
  setEnv: null;
  /** Literal null: live escape characters fail setup; the ~ menu is an interactive local shell. */
  escapes: null;
}

/** The absent-forbidden members, in the order the parser refuses them; the resolve `settings` list names these strings back. */
export const SSH_FORBIDDEN_SNAPSHOT_FIELDS = [
  "proxyCommand",
  "forwards",
  "tunnels",
  "localCommands",
  "remoteCommand",
  "sendEnv",
  "setEnv",
  "escapes",
] as const;

/** One member of {@link SSH_FORBIDDEN_SNAPSHOT_FIELDS}. */
export type SshForbiddenSnapshotField = (typeof SSH_FORBIDDEN_SNAPSHOT_FIELDS)[number];

/**
 * Control characters and space: nothing a host, user, or alias may contain on
 * any sane SSH stack. Spelled as the Unicode category (C0+C1 controls
 * including DEL) because biome refuses the raw `\x00` spellings, and the
 * category is the rule stated as its own name anyway.
 */
const NAME_UNSAFE_RE = /\s|\p{Cc}/u;

/**
 * A hostname: a DNS-ish label run (this grammar admits IPv4 literals and
 * underscores, which occur in real deployments) OR a bracketed IPv6 literal.
 * A port baked onto the host (`[::1]:2222`) is refused on purpose: `port` is
 * its own field, and accepting the composed spelling would let a host string
 * carry a second authority the reviewer never saw.
 */
const HOST_RE = /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;

/** A POSIX-ish username: the characters ssh's `user@host` split and PAM actually meet. */
const USER_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A wire name (config alias, `HostKeyAlias`): length-capped, no whitespace or
 * control characters, and NOT option-like (a leading `-` is how a value
 * becomes a flag when argv is assembled - the wire-name injection rule, checked where
 * the value is born rather than trusting every later composer).
 */
function isWireName(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_NAME_MAX_CHARS &&
    !value.startsWith("-") &&
    !NAME_UNSAFE_RE.test(value)
  );
}

/** A destination hostname (or bracketed IPv6), by grammar not by hygiene: see {@link HOST_RE}. */
function isHostName(value: unknown): value is string {
  return isStr(value) && value.length <= SSH_NAME_MAX_CHARS && HOST_RE.test(value);
}

/** A username, by grammar: see {@link USER_RE}. Length is bounded by the same cap. */
function isUserName(value: unknown): value is string {
  return isStr(value) && value.length <= SSH_NAME_MAX_CHARS && USER_RE.test(value);
}

/** An absolute POSIX path: leading `/`, length-capped, no control characters. Existence and ownership are the node's to check; shape is ours. */
function isAbsPosixPath(value: unknown): value is string {
  return isStr(value) && value.startsWith("/") && value.length <= SSH_PATH_MAX_CHARS && !/\p{Cc}/u.test(value);
}

/** A resolved port: a positive integer inside the legal range. */
function isPort(value: unknown): value is number {
  return isInt(value) && (value as number) >= 1 && (value as number) <= 65535;
}

/** A path list within `cap`, or empty. Every ref list shares this grammar. */
function isPathListWithin(value: unknown, cap: number): value is string[] {
  return Array.isArray(value) && value.length <= cap && value.every(isAbsPosixPath);
}

function isHop(value: unknown): value is SshHopWire {
  if (!isRecord(value) || !isHostName(value.host) || !isPort(value.port)) return false;
  if (!("user" in value)) return false;
  return value.user === null || isUserName(value.user);
}

/**
 * Validates and narrows an arbitrary value into an approved connection
 * snapshot. Both sides call it: the plane before it stores or dispatches one,
 * the node before it renders a command line from one. A snapshot that fails
 * ANY check is refused whole - there is no partial approval, and the
 * forbidden-member refusal is deliberately a PARSE failure rather than a
 * field drop (dropping a `ProxyCommand` silently is the exact defect the refusal-by-name rule names).
 *
 * @param value - candidate snapshot (parsed JSON; unknown provenance)
 * @returns the narrowed snapshot, or null when malformed or non-approvable
 */
export function parseSshConnectionSnapshot(value: unknown): SshConnectionSnapshotWire | null {
  if (!isRecord(value)) return null;
  // Forbidden members first: any present non-null value refuses the whole
  // snapshot, checked before the shape of everything else so a resolver bug
  // surfaces as "this is not approvable", never as "incomplete input".
  for (const field of SSH_FORBIDDEN_SNAPSHOT_FIELDS) {
    if (value[field] != null) return null;
  }
  if (!isWireName(value.alias) || !isHostName(value.host) || !isPort(value.port)) return null;
  if (!("user" in value) || !(value.user === null || isUserName(value.user))) return null;
  if (!isPathListWithin(value.identityFiles, SSH_MAX_IDENTITY_REFS)) return null;
  if (!isPathListWithin(value.certificateFiles, SSH_MAX_CERT_REFS)) return null;
  if (!isPathListWithin(value.knownHostsFiles, SSH_MAX_KNOWN_HOSTS_FILES)) return null;
  if (!("authAgentSocket" in value) || !(value.authAgentSocket === null || isAbsPosixPath(value.authAgentSocket)))
    return null;
  if (!("hostKeyAlias" in value) || !(value.hostKeyAlias === null || isWireName(value.hostKeyAlias))) return null;
  if (!Array.isArray(value.proxyJumps) || value.proxyJumps.length > SSH_MAX_PROXY_HOPS) return null;
  for (const hop of value.proxyJumps) if (!isHop(hop)) return null;
  // Return a REBUILT object, never the input cast: the eight forbidden fields
  // are written as literal null here, so what the caller holds is provably a
  // snapshot the grammar can express - stray keys on the input die with it.
  return {
    alias: value.alias,
    host: value.host,
    user: value.user === undefined ? null : (value.user as string | null),
    port: value.port,
    identityFiles: [...(value.identityFiles as string[])],
    certificateFiles: [...(value.certificateFiles as string[])],
    authAgentSocket: value.authAgentSocket === undefined ? null : (value.authAgentSocket as string | null),
    knownHostsFiles: [...(value.knownHostsFiles as string[])],
    hostKeyAlias: value.hostKeyAlias === undefined ? null : (value.hostKeyAlias as string | null),
    proxyJumps: (value.proxyJumps as SshHopWire[]).map((h) => ({ host: h.host, user: h.user, port: h.port })),
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
  };
}
