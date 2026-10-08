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
 * refused. The sealed agent-relay milestone (M2) adds four commands here:
 * `ssh_register_identity` (§4.3 bootstrap: a pre-M2 node's signing key reaches
 * the plane inside a signed command on the existing node link), the roster
 * read `ssh_agent_identities` (§5.4: the approval screen asks A's agent for
 * its public identities, fingerprints plus comments, blobs withheld), and the
 * brokered pair `ssh_relay_open` / `ssh_relay_close` (§5.1: the plane's OPEN
 * hands one machine the whole pairing, the CLOSE names why it ends). What
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

import { BASE64_RE, isInt, isRecord, isStr, isStrArray } from "./guards.js";
import { SSH_MAX_GRANT_FINGERPRINTS, SSH_NAME_MAX_CHARS } from "./ssh-limits.js";

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
}

/**
 * Every reason a relay session may be closed with (spec 2026-10-08 §5.1/§5.6):
 * §5.1's "closed with a named reason" is only kept if the grammar knows every
 * name, so a close carrying anything else is malformed, not a fresh idea.
 * - `handshake-grace`: the pairing's handshake window elapsed unanswered.
 * - `child-exit`: the A-side agent child died; the session ends with it.
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

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody =
  | SshDiscoverAliasesCommand
  | SshResolveConfigCommand
  | SshRegisterIdentityCommand
  | SshAgentIdentitiesCommand
  | SshRelayOpenCommand
  | SshRelayCloseCommand;

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = [
  "ssh_discover_aliases",
  "ssh_resolve_config",
  "ssh_register_identity",
  "ssh_agent_identities",
  "ssh_relay_open",
  "ssh_relay_close",
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
      // The signing half is a JSON public JWK. The shape gate mirrors
      // `parseNodeSshIdentity` (node-results.ts) for the enroll answer: a
      // non-empty string AND `JSON.parse` yielding a plain record - and it
      // also refuses the shallow private-material tell (a top-level `d`
      // member), so "hello", a JSON scalar/array, and a serialized PRIVATE
      // JWK all read as malformed here. Deep private-material and key-validity
      // refusal stays at `bytesOfJwk` on the node (Task 6), which is beside
      // the one import; this gate keeps obvious nonsense out of the signed
      // command's narrowed body.
      if (!isIdStr(value.peerSigningPublicKey)) return null;
      let peerSigningJwk: unknown;
      try {
        peerSigningJwk = JSON.parse(value.peerSigningPublicKey);
      } catch {
        return null;
      }
      if (!isRecord(peerSigningJwk) || "d" in peerSigningJwk) return null;
      // The encryption half is base64 of the UTF-8 JSON public JWK (the one
      // canonical spelling, see the command's doc); a present-but-undecodable
      // one is malformed, not "the pin sorts it out".
      if (!isIdStr(value.peerEncryptPublicKey) || !BASE64_RE.test(value.peerEncryptPublicKey)) return null;
      if (!isSshGrantFingerprints(value.fingerprints)) return null;
      // Positive whole milliseconds; the VALUE's lawfulness (SSH_RELAY_LIFETIME_MS
      // as the ceiling the broker sends) is the broker's, this is the shape.
      if (!isInt(value.lifetimeMs) || (value.lifetimeMs as number) <= 0) return null;
      // Task 8 (b): the pane the pairing serves. The B proxy socket is named
      // by it, so it must be a path-composability id - the SAME guard the
      // node's socket bind runs, applied before anything is signed.
      if (!isSshPaneId(value.paneId)) return null;
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
    default:
      return null;
  }
}
