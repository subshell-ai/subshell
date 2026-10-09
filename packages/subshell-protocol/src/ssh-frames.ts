/**
 * The SSH node commands: the bounded config DISCOVERY and the single-alias
 * RESOLUTION that feed the wizard's review step (design 2026-10-05 §7), and
 * the M2 §4.3 IDENTITY bootstrap a pre-M2 node answers once. They ride the
 * existing signed/encrypted command transport unchanged - signing proves WHO
 * ordered it, this file freezes WHAT was ordered.
 *
 * The rest of the family the earlier command table named (`ssh_test_
 * connection`, the run start/status/read/cancel quartet, `ssh_terminal_
 * launch`, `ssh_input_control`) retired with that destination-execution
 * product, which never shipped; their `type` arms are therefore deleted, not
 * refused. The sealed agent-relay milestone (M2) adds five commands here:
 * `ssh_register_identity` (§4.3 bootstrap: a pre-M2 node's signing key reaches
 * the plane inside a signed command on the existing node link), the roster
 * read `ssh_agent_identities` (§5.4: the approval screen asks A's agent for
 * its public identities, fingerprints plus comments, blobs withheld), the
 * host-key capture `ssh_host_key` (§9, Task 12: the plane asks A's
 * `known_hosts` for one resolved destination's entries, and the answer
 * becomes the pin the relay-open carries to B), the brokered pair
 * `ssh_relay_open` / `ssh_relay_close` (§5.1: the plane's OPEN hands one
 * machine the whole pairing plus the destination's host-key pin, the CLOSE
 * names why it ends), the non-interactive setup-exec pair `ssh_exec` /
 * `ssh_exec_status` (spec 2026-10-08 §7, Task 14: the "Set up Subshell here"
 * act runs the rendered installer over its own short-lived `ssh` connection,
 * never the pane, and the answer carries output only through the setup-key
 * redactor), and the §4.5 recovery `ssh_machine_pin_repair` (Task 17: the
 * owner of A re-delivers ONE peer's registered public pair to replace that
 * peer's stored pin - the only sanctioned way a pinned entry changes). What
 * rides the link AFTER an open - the sealed blobs themselves - is not a
 * command at all: it is the `relay` link frame in `node-frames.ts`, which
 * carries no per-message signing because the link already authenticates.
 *
 * The commands are TRANSPORT-AGNOSTIC plain objects: the server-hosted
 * `local` node executes the same runtime in-process against these exact
 * bodies, so nothing may assume a socket, a jti, or a signature - those are
 * the transport's, and they live outside the body.
 *
 * Hand-rolled in the `node-frames.ts` style; imports no `node:` builtin, so
 * it rides the Metro-safe barrel with the rest of the grammar. The wiring
 * landed with the launcher tier: `parseNodeCommandBody` dispatches every
 * `ssh_*` arm here, and `node-results.ts` validates the answers that carry
 * data (the relay pair answer with a plain ack - no envelope to validate).
 */

import { BASE64_RE, isBool, isInt, isRecord, isStr, isStrArray } from "./guards.js";
import {
  SSH_CONFIG_FILE_MAX_BYTES,
  SSH_EXEC_COMMAND_MAX_CHARS,
  SSH_EXEC_MAX_PRESET_FLAGS,
  SSH_EXEC_TIMEOUT_MAX_MS,
  SSH_MAX_GRANT_FINGERPRINTS,
  SSH_MAX_HOST_PIN_LINE_CHARS,
  SSH_NAME_MAX_CHARS,
  SSH_PATH_MAX_CHARS,
} from "./ssh-limits.js";

/* ------------------------------------------------------------------ */
/* command bodies                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bounded parse of the connecting account's SSH config for alias NAMES. Takes
 * no input beyond the command itself (which node answers it is the
 * transport's, not the body's). Human-only at the API level; the node holds
 * no concept of who asked - the signature already did that part.
 */
export interface SshDiscoverAliasesCommand {
  type: "ssh_discover_aliases";
}

/** Resolve one alias into the approved normalized snapshot (or a named refusal). Human config step. */
export interface SshResolveConfigCommand {
  type: "ssh_resolve_config";
  /** The config token to resolve. Shape-checked here; whether it EXISTS in the account's config is what the command is for. */
  alias: string;
}

/**
 * The machine reports its OWN ES256 relay signing public key (spec
 * 2026-10-08 §4.3): the once-over-the-link bootstrap for a node that enrolled
 * before the key existed. No input beyond the type - the answer is the
 * machine's own identity, there is nothing for the plane to ask about.
 */
export interface SshRegisterIdentityCommand {
  type: "ssh_register_identity";
}

/**
 * Enumerate the key home's LIVE agent identities for the first-use approval
 * screen (spec 2026-10-08 §5.4, Task 11): the plane asks A's agent for its
 * WHOLE public roster, and the answer is fingerprints plus comments with the
 * blobs withheld. No input beyond the type: the command asks the roster, so a
 * plane-sent selection field could only be a narrowing or widening attempt at
 * what A's own agent reports. It is answered with no grant outstanding and no
 * relay session, like `detect` and `ssh_register_identity`, and it writes no
 * audit row on either side.
 */
export interface SshAgentIdentitiesCommand {
  type: "ssh_agent_identities";
}

/**
 * Ask the key home for the `known_hosts` entries its connecting account has
 * recorded for ONE resolved destination (spec 2026-10-08 §9 "M2 host-key pin
 * path", Task 12): the capture command whose answer becomes the pin delivered
 * to B on the relay-open. Unlike the roster read it must NAME a destination,
 * because OpenSSH's host-key lookup is per destination - `host`, `port`, and
 * the connecting `user` (null when the snapshot named none) are the three
 * facts the lookup's candidate spellings are built from, and each is sent in
 * its resolved form so a later `~/.ssh/config` edit cannot retarget the ask
 * (the same store-resolved rule §6.1 applies to the grant selector).
 *
 * Answered with NO grant and no relay session, like `detect`,
 * `ssh_register_identity`, and `ssh_agent_identities`; it writes no audit row
 * on either side (the durable record of a pin is `node.ssh_host_pin.create`,
 * written by the capture ACT, not by the question), and an unreachable or
 * refusing machine answers a named error - the capture never guesses.
 */
export interface SshHostKeyCommand {
  type: "ssh_host_key";
  /** The resolved destination host (bracketed IPv6 spelled as OpenSSH spells it). */
  host: string;
  /** The resolved port; always sent, because `[host]:port` is one of ssh's own lookup spellings. */
  port: number;
  /** The connecting user, or null when the snapshot named none (the bare-`host` spellings still match). */
  user: string | null;
}

/**
 * Which side of a relay pairing a machine is (spec 2026-10-08 §2): A is the
 * key home whose agent signs, B is the connecting machine that holds none.
 */
export type SshRelayRole = "A" | "B";

/**
 * The brokered OPEN (spec §5.1): the plane hands one machine the WHOLE
 * pairing in this one signed command - relay-session id, opaque routing ref,
 * both node ids with their roles, the peer's registered signing AND
 * encryption public keys to pin (§4.4), the grant id with its selected
 * key-fingerprint set (§5.4, delivered so the responder enforces it without
 * a REST call it cannot make), the lifetime, and the pane the pairing serves.
 * Every field is REQUIRED: a partial pairing names no session the endpoint
 * could honor, so the grammar refuses it rather than let an executor guess a
 * half.
 *
 * The peer keys travel as their ONE canonical spellings - the same strings
 * §4.2/§4.3 store, transported byte-identically so the pin store's
 * byte-equality rule has something to match:
 * - `peerSigningPublicKey`: the peer's ES256 signing PUBLIC JWK, JSON-
 *   serialized (the registration/enroll reporting spelling).
 * - `peerEncryptPublicKey`: base64 (standard, padded, `BASE64_RE`) of the
 *   UTF-8 bytes of the peer's ECDH-ES encryption PUBLIC JWK, JSON-serialized
 *   (what the receiver decodes back to the exact string its machine pin
 *   store holds, and what `seal` consumes).
 * The byte-equality enforcement is the receiver's machine pin store (§4.4),
 * not this grammar's.
 *
 * `paneId` (Task 8 (b)): the B-side proxy socket is
 * `<dataDir>/ssh/<paneId>/agent.sock`, and pane-runtime's path-composition
 * guard (`buildSshConfigPath`/`buildAgentSocketPath`) accepts only ids
 * matching {@link isSshPaneId}; the grammar names the SAME shape so a command
 * that could only ever fail the node's socket-path guard is refused here,
 * before the plane signs it.
 *
 * `hostPin` (Task 12, spec 2026-10-08 §9): the destination's pinned
 * `known_hosts` line, captured from A at grant creation and REQUIRED. A
 * relay-open without it is a relay grant with no pin, and the invariant says
 * such a thing does not exist: B must never fall back to its own ambient
 * TOFU, so the grammar refuses the pinless open rather than let the launch
 * render an `accept-new` config against an untrusted machine's file. The B
 * side writes the line, byte-for-byte, to `<dataDir>/ssh/<paneId>/known_hosts`
 * (0600, beside the config the pane's `ssh -F` reads); the shape rule is
 * {@link isSshKnownHostsPinLine} - one printable line, never a smuggled
 * second entry. The same class of pre-merge grammar extension as `paneId`:
 * plane and agent ship together under the exact-match protocol gate, so the
 * field is required outright, not version-gated.
 */
export interface SshRelayOpenCommand {
  type: "ssh_relay_open";
  /** The relay-session id the plane minted (audit + §5.6's signature covers it). */
  relayId: string;
  /** Opaque routing ref - the plane's blind pairing key for later relay frames. */
  ref: string;
  /** THIS machine's role in the pairing; the executor branches on it. */
  role: SshRelayRole;
  /** The key home's node id (names A whichever machine reads this). */
  aNodeId: string;
  /** The connecting machine's node id (names B likewise). */
  bNodeId: string;
  /** The peer's registered ES256 signing public key (JSON public JWK) to pin. */
  peerSigningPublicKey: string;
  /** Base64 of the UTF-8 bytes of the peer's JSON-serialized encryption public JWK, to pin. */
  peerEncryptPublicKey: string;
  /** The live grant this session runs under (revoke cuts the session, §6.3). */
  grantId: string;
  /** The grant's selected key fingerprints, at most SSH_MAX_GRANT_FINGERPRINTS. */
  fingerprints: string[];
  /** Session ceiling in ms; SSH_RELAY_LIFETIME_MS is what the plane sends. */
  lifetimeMs: number;
  /** The pane (subshell id) the pairing serves: names B's proxy socket path (§5.2). */
  paneId: string;
  /** The destination's pinned host-key line (A's known_hosts entry; required - a pinless relay-open is malformed, §9). */
  hostPin: string;
}

/**
 * Every reason a relay session may be closed with (spec 2026-10-08 §5.1/§5.6):
 * §5.1's "closed with a named reason" is only kept if the grammar knows every
 * name, so a close carrying anything else is malformed, not a fresh idea.
 * - `handshake-grace`: the pairing's handshake window elapsed unanswered.
 * - `child-exit`: the B-side pane's `ssh` child died; the session ends with it.
 * - `lifetime-expiry`: SSH_RELAY_LIFETIME_MS ran out.
 * - `a-dropped`: A's link dropped and no re-pair restored it.
 * - `grant-revoked`: the grant underneath the session was revoked (§6.3).
 * - `over-cap`: a frame over SSH_RELAY_FRAME_MAX_BYTES arrived (§5.1: cap
 *   is law; the refusal closes the session by name rather than silently).
 */
export const SSH_RELAY_CLOSE_REASONS = [
  "handshake-grace",
  "child-exit",
  "lifetime-expiry",
  "a-dropped",
  "grant-revoked",
  "over-cap",
] as const;

/** One named close reason; the runtime census is {@link SSH_RELAY_CLOSE_REASONS}. */
export type SshRelayCloseReason = (typeof SSH_RELAY_CLOSE_REASONS)[number];

/**
 * The peer's registered ES256 signing key as the ONE public-JWK string the
 * relay-open and the §4.5 re-pair both carry: non-empty, parses to a plain
 * record, and refuses the shallow private-material tell (a top-level `d`
 * member). Deep validity (importability, curve, non-top-level private
 * members) stays `bytesOfJwk` on the node, beside the one import - this gate
 * keeps obvious nonsense out of a command the plane is about to SIGN.
 * Exported so the re-delivery sites and this grammar share one definition of
 * "a public signing JWK on the wire".
 */
export function isSshPeerSigningJwkStr(value: unknown): value is string {
  if (!isIdStr(value)) return false;
  let jwk: unknown;
  try {
    jwk = JSON.parse(value);
  } catch {
    return false;
  }
  return isRecord(jwk) && !("d" in jwk);
}

/**
 * The peer's registered ECDH-ES encryption key in its transport spelling:
 * base64 (standard, padded) of the UTF-8 bytes of the JSON-serialized public
 * JWK - the one canonical carriage both the relay-open and the §4.5 re-pair
 * use, so a node decodes back the exact string its machine pin store holds.
 * Base64 SHAPE only here (decodability and deep public-only validity are the
 * node's `bytesOfJwk` gate, beside the import).
 */
export function isSshPeerEncryptJwkB64Str(value: unknown): value is string {
  return isIdStr(value) && BASE64_RE.test(value);
}

/**
 * The §4.5 re-pair (spec 2026-10-08 §4.5, Task 17): the plane re-delivers
 * ONE peer's registered public pair to the machine whose machine pin store
 * must replace that peer's entry - the sanctioned recovery when a peer's
 * machine key genuinely changed (a re-enroll or a replaced data dir, §4.2).
 * This is the ONLY way a pinned entry may change: byte-equality still governs
 * every NORMAL pairing check (§4.4), and nothing here softens it. The peer
 * keys travel in the SAME carriage the relay-open uses ({@link
 * isSshPeerSigningJwkStr} / {@link isSshPeerEncryptJwkB64Str}, private `d`
 * refused at the grammar), because re-pairing the wrong shape is exactly as
 * dangerous as pairing with it.
 *
 * The command names only the PEER: which machine repairs its store is the
 * transport's business (the signed command targets it the way every other
 * arm's does, and the owner-of-A gate on the plane is what authorizes the
 * act). A re-pair writes BOTH halves for that peer - replacing one half and
 * leaving the other stale would pin a key pair no machine has ever held.
 */
export interface SshMachinePinRepairCommand {
  type: "ssh_machine_pin_repair";
  /** The peer whose stored entry is replaced (or added, after a lost store). */
  peerNodeId: string;
  /** The peer's registered ES256 signing public key (JSON public JWK). */
  peerSigningPublicKey: string;
  /** Base64 of the UTF-8 bytes of the peer's registered JSON encryption public JWK. */
  peerEncryptPublicKey: string;
}

/**
 * The brokered TEARDOWN (spec §5.1/§5.6): stop the session named by the
 * routing ref and say why, in the open. The reason is a NAMED cause drawn
 * from {@link SSH_RELAY_CLOSE_REASONS} because §5.1's "closed with a named
 * reason" is the whole failure-mode posture; an unnamed close is the silence
 * this family refuses.
 */
export interface SshRelayCloseCommand {
  type: "ssh_relay_close";
  /** The routing ref of the session to tear down. */
  ref: string;
  /** The named reason this session ends; relayed to the endpoint's log. */
  reason: SshRelayCloseReason;
}

/**
 * The non-interactive setup exec (spec 2026-10-08 §7, Task 14): run
 * `ssh <flags> -- <destination> '<command>'` on THIS machine as one short-
 * lived, output-capturing connection - the "Set up Subshell here" act's
 * separate channel, NEVER typed into the interactive pane. The command string
 * carries the minted setup key; every refusal and every captured byte on the
 * answer side obeys the redaction rule ({@link redactSshSetupKeyLines}), so
 * the key lands nowhere the pane, the pane log, or the plane's trail can
 * read.
 *
 * The shape mirrors the `launch` frame's ssh member, with one sharper rule
 * repeated: `configPath` is a CLAIM. The node re-derives
 * `buildSshConfigPath(dataDir, execId)` from the exec id and refuses a
 * single-byte mismatch, so a signed command can never name a config path
 * outside the ephemeral per-act directory the machine's own sweeps own.
 *
 * `relay: true` is relay mode: the ssh child's `SSH_AUTH_SOCK` is the agent
 * proxy socket the earlier `ssh_relay_open` bound at
 * `buildAgentSocketPath(dataDir, execId)` - derived HERE, claimed by nothing,
 * which is why a non-null `agentSocketPath` beside `relay: true` is a
 * contradiction the grammar refuses. `relay: false` is M1's direct posture:
 * the snapshot's own agent socket rides as `agentSocketPath` (the same scoped
 * env the direct pane launch carries) or nothing does.
 */
export interface SshExecCommand {
  type: "ssh_exec";
  /** The ephemeral act id (path-composition shape): names `<dataDir>/ssh/<execId>/`. */
  execId: string;
  /** The rendered-config path the plane derived; the node byte-checks its own. */
  configPath: string;
  /** The rendered ssh config bytes (relay render: pinned, `StrictHostKeyChecking yes`). */
  fileContent: string;
  /** The ssh option tokens through the destination: `-F … … -- host`. */
  presetFlags: string[];
  /** The remote one-liner (the installer command; the setup key lives HERE, transiently). */
  command: string;
  /** True: authenticate through the exec's own relay proxy socket (relay mode). */
  relay: boolean;
  /** Direct mode only: the snapshot's agent socket, or null; MUST be null when relay is true. */
  agentSocketPath: string | null;
  /** The node-side hard deadline for the run; the plane's RPC deadline rides past it. */
  timeoutMs: number;
}

/** Ask one machine for the state of a kicked `ssh_exec` (running, or done with its captured answer). */
export interface SshExecStatusCommand {
  type: "ssh_exec_status";
  /** The same ephemeral act id the kick carried. */
  execId: string;
}

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody =
  | SshDiscoverAliasesCommand
  | SshResolveConfigCommand
  | SshRegisterIdentityCommand
  | SshAgentIdentitiesCommand
  | SshHostKeyCommand
  | SshRelayOpenCommand
  | SshRelayCloseCommand
  | SshExecCommand
  | SshExecStatusCommand
  | SshMachinePinRepairCommand;

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = [
  "ssh_discover_aliases",
  "ssh_resolve_config",
  "ssh_register_identity",
  "ssh_agent_identities",
  "ssh_host_key",
  "ssh_relay_open",
  "ssh_relay_close",
  "ssh_exec",
  "ssh_exec_status",
  "ssh_machine_pin_repair",
] as const;

/* ------------------------------------------------------------------ */
/* arm validators (delegated from parseNodeCommandBody)                */
/* ------------------------------------------------------------------ */

/** Same hygiene the snapshot applies to names; a config alias is the same kind of string. */
function isAliasName(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_NAME_MAX_CHARS &&
    !value.startsWith("-") &&
    !/\s|\p{Cc}/u.test(value)
  );
}

/** Identifiers on this grammar are non-empty strings; shape only, existence is what the command asks. */
function isIdStr(value: unknown): value is string {
  return isStr(value) && value.length > 0;
}

/**
 * The OpenSSH display notation the grant stores: the `SHA256:` prefix over
 * base64url digest text (43 chars in practice; bounded generously at 128).
 * Shape, not truth - whether the digest matches a key is the responder's
 * §5.4 enforcement. The alphabet rule is also what stops control characters
 * reaching a future audit row through a field that promises to be a
 * fingerprint.
 */
const GRANT_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether `value` is ONE fingerprint in the canonical display grammar. This is
 * the roster answer's grammar too, deliberately the SAME predicate: the
 * approve surface promises selections "exactly as the roster reports them",
 * so a fingerprint the roster may carry and a grant may not select would be
 * one broken round trip invented by drift. Exported for `node-results.ts`'s
 * roster validator.
 */
export function isSshGrantFingerprint(value: unknown): value is string {
  return isStr(value) && GRANT_FINGERPRINT_RE.test(value);
}

/**
 * The pane id the relay-open command names: exactly the shape pane-runtime's
 * socket-path composition accepts (`buildSshConfigPath`'s own guard - the
 * grammar and the path guard cannot drift apart, because the plane's
 * `openRelay` validates with THIS predicate before signing, both nodes'
 * parsers validate it on receipt, and the node's bind still runs the path
 * guard itself as the last station.
 */
const SSH_PANE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Whether `value` is a pane (subshell) id inside the socket-path composition
 * shape. Exported so the PLANE validates the id it is about to sign into a
 * relay-open with the same rule its parser enforces on receipt.
 */
export function isSshPaneId(value: unknown): value is string {
  return isStr(value) && SSH_PANE_ID_RE.test(value);
}

/**
 * The grant's selected fingerprint set: strings, every one in the `SHA256:`
 * display form (an empty or free-text entry matches no key yet would ride a
 * grant as a silent never-serve line), and at most
 * {@link SSH_MAX_GRANT_FINGERPRINTS} - over-cap is a refusal at the grammar
 * so the truncation nobody may silently perform is impossible by construction
 * (§5.4). An EMPTY set parses: §5.4's "names no fingerprint, serves nothing"
 * is a decision, not a defect. Exported for the plane's pre-signing check
 * (one definition of the grant-selection law, both directions).
 */
export function isSshGrantFingerprints(value: unknown): value is string[] {
  return isStrArray(value) && value.every(isSshGrantFingerprint) && value.length <= SSH_MAX_GRANT_FINGERPRINTS;
}

/**
 * Whether `value` is ONE OpenSSH `known_hosts` line as the wire carries it:
 * non-empty, bounded ({@link SSH_MAX_HOST_PIN_LINE_CHARS}), trimmed, and free
 * of control characters - which subsumes the newline, the load-bearing half.
 * The B side writes a relay-open's pin line verbatim into the pane's 0600
 * pinned file, so a smuggled `\n` would install a SECOND, plane-authored
 * trust entry beside A's; the comment-marker refusal keeps `#` lines out of a
 * field that promises to be a key. Everything past shape - whether the line
 * is a well-formed entry, which key it carries, whether it matches D - is
 * OpenSSH's own judgment at connect time on B (StrictHostKeyChecking yes
 * against this exact file), and the capture service's fingerprint extraction
 * on the plane. Hashed (`|1|…`) and option-prefixed entries pass: they are
 * how the operator's own file may spell A's trust, verbatim-rewritten.
 *
 * One definition, both directions: the `ssh_host_key` ANSWER validator
 * (`node-results.ts`) and the `ssh_relay_open` pin carriage both check with
 * this predicate, so a line A answered can always ride the relay-open.
 */
export function isSshKnownHostsPinLine(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_MAX_HOST_PIN_LINE_CHARS &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value) &&
    !value.startsWith("#")
  );
}

/**
 * Validates and narrows any `ssh_*` command body. `parseNodeCommandBody`
 * routes every `ssh_` arm here, so the SSH grammar lives in ONE file
 * beside the commands it narrows. The contract this upholds is
 * the same as the node commands' today: a NON-null return is safe to switch
 * on by `type`.
 *
 * @param value - candidate payload whose `type` starts with `ssh_`
 * @returns the narrowed command, or null when malformed
 */
export function parseSshNodeCommandBody(value: unknown): SshNodeCommandBody | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ssh_discover_aliases":
      return { type: "ssh_discover_aliases" };
    case "ssh_resolve_config":
      return isAliasName(value.alias) ? { type: "ssh_resolve_config", alias: value.alias } : null;
    case "ssh_register_identity":
      // The whole command is its type: the machine answers about ITSELF, and
      // the answer's shape is `node-results.ts`'s business, not this grammar's.
      return { type: "ssh_register_identity" };
    case "ssh_agent_identities":
      // The roster read is its type alone, for the same reason: the command
      // asks the WHOLE roster, so a plane-sent field could only aim at
      // narrowing or widening what A's agent actually reports.
      return { type: "ssh_agent_identities" };
    case "ssh_host_key": {
      // The capture asks for ONE destination's entries, so the destination is
      // the whole input: host and user take the SAME token hygiene the alias
      // and snapshot names apply (option-like, whitespace, and control-char
      // refusals at the grammar, before the plane signs the ask), the port is
      // a real 16-bit int because `[host]:port` is one of ssh's own lookup
      // spellings, and the user is REQUIRED to state itself - null spelled -
      // so no omitted field can silently widen or narrow who the lookup names.
      if (!isAliasName(value.host)) return null;
      if (!isInt(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) return null;
      if (!("user" in value)) return null;
      if (!(value.user === null || isAliasName(value.user))) return null;
      return { type: "ssh_host_key", host: value.host, port: value.port as number, user: value.user };
    }
    case "ssh_relay_open": {
      // EVERY pairing field is required (§5.1): this command IS the pairing,
      // and an executor guessing a missing half would be guessing trust
      // (whose key to pin) or safety (which fingerprints to serve). The
      // role is only "A" or "B" - there is no third machine in this design.
      if (value.role !== "A" && value.role !== "B") return null;
      if (
        !isIdStr(value.relayId) ||
        !isIdStr(value.ref) ||
        !isIdStr(value.aNodeId) ||
        !isIdStr(value.bNodeId) ||
        !isIdStr(value.grantId)
      ) {
        return null;
      }
      // The signing half is a JSON public JWK and the encryption half its
      // base64 twin - the shared peer carriage (see {@link
      // isSshPeerSigningJwkStr} / {@link isSshPeerEncryptJwkB64Str}), so the
      // relay-open and the §4.5 re-pair gate the delivered pair with exactly
      // one definition. Deep private-material and key-validity refusal stays
      // at `bytesOfJwk` on the node (Task 6), which is beside the one import.
      if (!isSshPeerSigningJwkStr(value.peerSigningPublicKey)) return null;
      if (!isSshPeerEncryptJwkB64Str(value.peerEncryptPublicKey)) return null;
      if (!isSshGrantFingerprints(value.fingerprints)) return null;
      // Positive whole milliseconds; the VALUE's lawfulness (SSH_RELAY_LIFETIME_MS
      // as the ceiling the broker sends) is the broker's, this is the shape.
      if (!isInt(value.lifetimeMs) || (value.lifetimeMs as number) <= 0) return null;
      // Task 8 (b): the pane the pairing serves. The B proxy socket is named
      // by it, so it must be a path-composability id - the SAME guard the
      // node's socket bind runs, applied before anything is signed.
      if (!isSshPaneId(value.paneId)) return null;
      // Task 12 (spec §9): the destination's pinned host-key line, REQUIRED.
      // A relay-open with no pin is a relay grant with no pin, and B must
      // never ambient-TOFU a destination it does not already trust: the
      // refusal is the grammar's, before the plane signs and before either
      // endpoint runs. Shape only here ({@link isSshKnownHostsPinLine});
      // whether the line matches D is ssh's own hard block on B at connect.
      if (!isSshKnownHostsPinLine(value.hostPin)) return null;
      // Rebuilt from the validated fields, never a cast of the candidate: a
      // stray member on the wire drops here, exactly as the close arm drops.
      return {
        type: "ssh_relay_open",
        relayId: value.relayId,
        ref: value.ref,
        role: value.role,
        aNodeId: value.aNodeId,
        bNodeId: value.bNodeId,
        peerSigningPublicKey: value.peerSigningPublicKey,
        peerEncryptPublicKey: value.peerEncryptPublicKey,
        grantId: value.grantId,
        fingerprints: [...value.fingerprints],
        lifetimeMs: value.lifetimeMs as number,
        paneId: value.paneId,
        hostPin: value.hostPin,
      };
    }
    case "ssh_relay_close": {
      // Ref + a reason from the NAMED set, and nothing else may ride it: the
      // close selects a session, it does not amend one (§5.1/§5.6). Membership
      // in SSH_RELAY_CLOSE_REASONS is the check - §5.1's "closed with a named
      // reason" is worthless as a free string, so an unknown reason is a
      // malformed close refused at the grammar.
      if (!isIdStr(value.ref) || !isStr(value.reason)) return null;
      if (!(SSH_RELAY_CLOSE_REASONS as readonly string[]).includes(value.reason)) return null;
      return { type: "ssh_relay_close", ref: value.ref, reason: value.reason as SshRelayCloseReason };
    }
    case "ssh_exec": {
      // Every field is required (the §7 redaction rule has no omitted half
      // to paper over): the exec id takes the SAME path-composition shape
      // the relay's paneId takes, the config member takes the launch frame's
      // ssh rules verbatim (absolute bounded path, bounded content), the
      // flag list and the command are the argv this machine will spawn, so
      // they are bounded TEXT, control characters refused (a smuggled
      // newline would be a second command on the destination), and the
      // relay/own-mode contradiction is refused at the grammar rather than
      // guessed by the executor.
      if (!isSshPaneId(value.execId)) return null;
      if (
        !isStr(value.configPath) ||
        !value.configPath.startsWith("/") ||
        value.configPath.length > SSH_PATH_MAX_CHARS
      ) {
        return null;
      }
      if (!isStr(value.fileContent) || value.fileContent.length > SSH_CONFIG_FILE_MAX_BYTES) return null;
      if (!isStrArray(value.presetFlags) || value.presetFlags.length === 0) return null;
      if (value.presetFlags.length > SSH_EXEC_MAX_PRESET_FLAGS) return null;
      for (const flag of value.presetFlags) {
        if (!isExecToken(flag)) return null;
      }
      if (!isStr(value.command) || value.command.length === 0) return null;
      if (value.command.length > SSH_EXEC_COMMAND_MAX_CHARS) return null;
      if (/\p{Cc}/u.test(value.command)) return null; // one printable line; a control char is a smuggled second command
      if (!isBool(value.relay)) return null;
      if (!("agentSocketPath" in value)) return null;
      if (!(value.agentSocketPath === null || isAbsPathStr(value.agentSocketPath))) return null;
      if (value.relay && value.agentSocketPath !== null) return null; // relay derives its own socket
      if (!isInt(value.timeoutMs) || (value.timeoutMs as number) < 1) return null;
      if ((value.timeoutMs as number) > SSH_EXEC_TIMEOUT_MAX_MS) return null;
      return {
        type: "ssh_exec",
        execId: value.execId,
        configPath: value.configPath,
        fileContent: value.fileContent,
        presetFlags: [...value.presetFlags],
        command: value.command,
        relay: value.relay,
        agentSocketPath: value.agentSocketPath,
        timeoutMs: value.timeoutMs as number,
      };
    }
    case "ssh_exec_status": {
      // One path-shaped id selects the act; the answer's shape is
      // `node-results.ts`'s business, and a stray member drops here.
      if (!isSshPaneId(value.execId)) return null;
      return { type: "ssh_exec_status", execId: value.execId };
    }
    case "ssh_machine_pin_repair": {
      // §4.5's re-delivery: the peer id plus BOTH registered public halves,
      // every field required (a half-repair is a contradiction: the store
      // pins the pair), the pair gated by the SAME carriage predicates the
      // relay-open uses - including the private-`d` refusal, which matters
      // most here because this command WRITES a trust store.
      if (!isIdStr(value.peerNodeId)) return null;
      if (!isSshPeerSigningJwkStr(value.peerSigningPublicKey)) return null;
      if (!isSshPeerEncryptJwkB64Str(value.peerEncryptPublicKey)) return null;
      return {
        type: "ssh_machine_pin_repair",
        peerNodeId: value.peerNodeId,
        peerSigningPublicKey: value.peerSigningPublicKey,
        peerEncryptPublicKey: value.peerEncryptPublicKey,
      };
    }
    default:
      return null;
  }
}

/** A preset flag: bounded, non-empty, whitespace-free, control-char-free. */
function isExecToken(value: string): boolean {
  return value.length > 0 && value.length <= SSH_NAME_MAX_CHARS && !/\s|\p{Cc}/u.test(value);
}

/** An absolute path claim the grammar may pass on (the launch frame's ssh rule, restated). */
function isAbsPathStr(value: unknown): value is string {
  return isStr(value) && value.startsWith("/") && value.length <= SSH_PATH_MAX_CHARS;
}

/**
 * Drop every line of captured installer output that carries the setup-key
 * marker (`nsk_`, the mint shape's fixed prefix). Whole lines go, never bytes
 * spliced: a line that mentions the key at all is a line the pane's machine,
 * the plane's retained copy, and every downstream surface must not have.
 * Deliberately broader than the key grammar - ANY `nsk_` substring drops -
 * because the rule's job is to survive the mint's format changing under it.
 * The node applies it before retaining or answering with ANY captured byte;
 * the plane applies it again as the belt that does not trust the machine's
 * hygiene (the "never trust a machine answer" doctrine, applied to output).
 */
export function redactSshSetupKeyLines(text: string): string {
  if (!text.includes("nsk_")) return text;
  return text
    .split("\n")
    .filter((line) => !line.includes("nsk_"))
    .join("\n");
}
