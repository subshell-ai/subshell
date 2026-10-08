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
 * refused. The sealed agent-relay milestone (M2) adds three commands here:
 * `ssh_register_identity` (§4.3 bootstrap: a pre-M2 node’s signing key reaches
 * the plane inside a signed command on the existing node link), and the
 * brokered pair `ssh_relay_open` / `ssh_relay_close` (§5.1: the plane’s OPEN
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
 * a REST call it cannot make), and the lifetime. Every field is REQUIRED:
 * a partial pairing names no session the endpoint could honor, so the
 * grammar refuses it rather than let an executor guess a half.
 *
 * The peer keys travel as their registered spellings: the ES256 signing half
 * as a JSON-serialized public JWK (what §4.2/§4.3 store and report), the
 * ECDH-ES encryption half as canonical base64 (what the link pins). The
 * byte-equality enforcement is the receiver's machine pin store (§4.4),
 * not this grammar's.
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
  /** The peer's registered ECDH-ES encryption public key (canonical base64) to pin. */
  peerEncryptPublicKey: string;
  /** The live grant this session runs under (revoke cuts the session, §6.3). */
  grantId: string;
  /** The grant's selected key fingerprints, at most SSH_MAX_GRANT_FINGERPRINTS. */
  fingerprints: string[];
  /** Session ceiling in ms; SSH_RELAY_LIFETIME_MS is what the plane sends. */
  lifetimeMs: number;
}

/**
 * The brokered TEARDOWN (spec §5.1/§5.6): stop the session named by the
 * routing ref and say why, in the open. The reason is a named cause
 * (lifetime expiry, grant revoke, A drop, child exit, over-cap frame...)
 * because §5.1's "closed with a named reason" is the whole failure-mode
 * posture; an unnamed close is the silence this family refuses.
 */
export interface SshRelayCloseCommand {
  type: "ssh_relay_close";
  /** The routing ref of the session to tear down. */
  ref: string;
  /** The named reason this session ends; relayed to the endpoint's log. */
  reason: string;
}

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody =
  | SshDiscoverAliasesCommand
  | SshResolveConfigCommand
  | SshRegisterIdentityCommand
  | SshRelayOpenCommand
  | SshRelayCloseCommand;

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = [
  "ssh_discover_aliases",
  "ssh_resolve_config",
  "ssh_register_identity",
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
 * The grant's selected fingerprint set: strings, every one non-empty (an
 * empty entry matches no key yet would ride a grant as a silent never-serve
 * line), and at most {@link SSH_MAX_GRANT_FINGERPRINTS} - over-cap is a
 * refusal at the grammar so the truncation nobody may silently perform is
 * impossible by construction (§5.4). An EMPTY set parses: §5.4's
 * "names no fingerprint, serves nothing" is a decision, not a defect.
 */
function isGrantFingerprints(value: unknown): value is string[] {
  return isStrArray(value) && value.every((f) => f.length > 0) && value.length <= SSH_MAX_GRANT_FINGERPRINTS;
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
      // The signing half is a JSON public JWK - the grammar proves it is a
      // non-empty string; importability and the private-part refusal are the
      // server's gate, beside the one enroll and `ssh_register_identity` run.
      if (!isIdStr(value.peerSigningPublicKey)) return null;
      // The encryption half is a base64 key (the link pin's own spelling); a
      // present-but-undecodable one is malformed, not "the pin sorts it out".
      if (!isIdStr(value.peerEncryptPublicKey) || !BASE64_RE.test(value.peerEncryptPublicKey)) return null;
      if (!isGrantFingerprints(value.fingerprints)) return null;
      // Positive whole milliseconds; the VALUE's lawfulness (SSH_RELAY_LIFETIME_MS
      // as the ceiling the broker sends) is the broker's, this is the shape.
      if (!isInt(value.lifetimeMs) || (value.lifetimeMs as number) <= 0) return null;
      return value as unknown as SshRelayOpenCommand;
    }
    case "ssh_relay_close":
      // Ref + named reason, and nothing else may ride it: the close selects
      // a session, it does not amend one (§5.1/§5.6).
      return isIdStr(value.ref) && isIdStr(value.reason)
        ? { type: "ssh_relay_close", ref: value.ref, reason: value.reason }
        : null;
    default:
      return null;
  }
}
