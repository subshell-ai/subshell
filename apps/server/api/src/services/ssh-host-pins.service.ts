import { createHash } from "node:crypto";
import { BackendErrorCodes } from "@internal/backend-errors";
import { isSshKnownHostsPinLine, type NodeSshHostKeyResult } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SshHostPinsRepository } from "@/db/repositories/ssh-host-pins.repository.js";
import type { SshHostPinTable } from "@/db/types/ssh-host-pins.db-types.js";
import { parseSshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { SshRpcError, sshHostKey } from "@/services/nodes/ssh-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * Destination trust follows the key home. Capture its known_hosts entry or
 * accept an explicit operator pin, store it per owner and canonical destination,
 * then deliver it to the connecting machine for strict host-key checking.
 * Missing or ambiguous captures refuse the connection. A changed key never
 * overwrites an existing pin: verify it separately, delete the old pin and retry.
 * Audit records contain public fingerprints, never key bytes.
 */

/** Why a capture refused; each code names its own door (the routes render the copy). */
export type SshHostPinFailure =
  | "no-pin"
  | "ambiguous"
  | "changed"
  | "invalid-line"
  | "offline"
  | "unsupported"
  | "timeout"
  | "refused"
  | "malformed";

/** The loud refusal every pin act raises. No row exists after a thrown `changed`-class failure. */
export class SshHostPinError extends Error {
  readonly code: SshHostPinFailure;
  /** The canonical destination the act was about (ids/hosts in copy, never key bytes). */
  readonly destination: string;

  constructor(code: SshHostPinFailure, message: string, destination: string) {
    super(message);
    this.name = "SshHostPinError";
    this.code = code;
    this.destination = destination;
  }
}

const repo = new SshHostPinsRepository(db);

/**
 * True when a failed insert hit this table's UNIQUE
 * `(owner_user_id, destination)` index (idx_ssh_host_pins_owner_destination):
 * the `node-errors` message-containment posture, scoped to the table so any
 * OTHER constraint violation stays loud instead of being swallowed as a race.
 */
function isUniquePinViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed") && msg.includes("ssh_host_pins");
}

/** The service's world. Production at {@link defaultPinsDeps}; tests install a fake. */
export interface SshHostPinsDeps {
  /** The one clock: row stamps. */
  nowIso(): string;
  /**
   * Ask one machine for its `known_hosts` entries for one destination
   * (default: `ssh-rpc.sshHostKey`, the `??` at the call site being the
   * production wiring). A test seam so the capture surface can pin its
   * fail-closed behavior without a live ssh-keygen.
   */
  fetchHostKey?(
    nodeId: string,
    destination: { host: string; port: number; user: string | null },
  ): Promise<NodeSshHostKeyResult>;
}

let depsOverride: SshHostPinsDeps | null = null;

function pinsDeps(): SshHostPinsDeps {
  if (depsOverride) return depsOverride;
  return { nowIso: () => new Date().toISOString() };
}

/**
 * Install (or with null, drop) the whole seam.
 * @internal test-only - the suite pins capture/fail-closed without a node.
 */
export function setSshHostPinsDepsForTests(deps: SshHostPinsDeps | null): void {
  depsOverride = deps;
}

/* ------------------------------------------------------------------ */
/* the line -> fingerprint extraction (public identifiers, never keys) */
/* ------------------------------------------------------------------ */

/** OpenSSH key-type tokens as known_hosts spells them (plain, cert, and security-key families). */
const KEY_TYPE_RE = /^(?:ssh|ecdsa|sk)-[A-Za-z0-9][A-Za-z0-9@._-]*$/;
/** Strict standard base64 (the known_hosts field's own spelling), shape only. */
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The `SHA256:` display fingerprint of a known_hosts line's key material -
 * OpenSSH's own notation: SHA-256 over the decoded public blob (the agent
 * wire encoding is the same bytes a known_hosts base64 field decodes to),
 * base64url WITHOUT padding. A line with no extractable (type, base64) pair
 * is malformed; a line whose several pairs disagree on the key is `ambiguous`
 * for CAPTURE purposes, so the return is a SET and the callers decide what
 * plurality means.
 */
export function hostKeyFingerprints(line: string): string[] {
  const tokens = line.split(/\s+/);
  const fps = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const type = tokens[i];
    const b64 = tokens[i + 1];
    if (type === undefined || b64 === undefined) continue;
    if (!KEY_TYPE_RE.test(type) || !B64_RE.test(b64)) continue;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) continue;
    fps.add(`SHA256:${createHash("sha256").update(bytes).digest("base64url")}`);
  }
  return [...fps];
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

/** The line a capture would pin, chosen from A's answer; raises the named refusals. */
function chooseCapturedLine(destination: string, lines: string[]): string {
  if (lines.length === 0) {
    throw new SshHostPinError(
      "no-pin",
      `no known_hosts entry for ${destination}: connect to the destination once from the key home, or supply its host key explicitly`,
      destination,
    );
  }
  const perLine = lines.map((line) => ({ line, fps: hostKeyFingerprints(line) }));
  if (perLine.some((e) => e.fps.length === 0)) {
    throw new SshHostPinError(
      "invalid-line",
      `the host-key answer for ${destination} carried an unparsable entry`,
      destination,
    );
  }
  const distinct = new Set(perLine.flatMap((e) => e.fps));
  if (distinct.size > 1) {
    // Several KEYS (not several spellings of one key) match the destination:
    // pinning would pick one of A's entries on the capture's own authority,
    // and that is exactly the coin flip §9's byte-equality posture refuses.
    throw new SshHostPinError(
      "ambiguous",
      `the key home recorded more than one host key for ${destination}; clean the known_hosts entry or supply the key explicitly`,
      destination,
    );
  }
  const first = perLine[0];
  if (first === undefined) {
    // Unreachable (lines.length was checked above), but the grammar's "pick
    // the one key" step never casts: an empty pick is a named refusal, not a
    // crash.
    throw new SshHostPinError("no-pin", `no known_hosts entry for ${destination}`, destination);
  }
  return first.line;
}

/**
 * Ask A for the destination's `known_hosts` entries and pick the one line to
 * pin (the fetch half of {@link captureHostPin}, split out so the explicit
 * path never builds an answer it will not read). Every transport failure
 * leaves as the named {@link SshHostPinError}; the empty answer is the
 * `no-pin` refusal, never a fabricated key.
 */
async function fetchAndChooseLine(aNodeId: string | null, destination: string): Promise<string> {
  const triple = parseSshCanonicalDestination(destination);
  if (triple === null) {
    throw new SshHostPinError(
      "invalid-line",
      `${destination} is not a canonical user@host:port destination`,
      destination,
    );
  }
  // Without a supplied line there is no pin without a key home to ask: the
  // trust screen supplies lines, never fetches.
  if (aNodeId === null) {
    throw new SshHostPinError("invalid-line", `no key home to ask for ${destination}'s host key`, destination);
  }
  let answer: NodeSshHostKeyResult;
  try {
    const fetcher = pinsDeps().fetchHostKey ?? sshHostKey; // the `??` is the production wiring
    answer = await fetcher(aNodeId, triple);
  } catch (err) {
    if (err instanceof SshRpcError) throw rpcFailure(err, destination);
    throw err;
  }
  return chooseCapturedLine(destination, answer.lines);
}

/**
 * The decision over a STANDING row, shared by the serialized read and the
 * insert-collision readback so a raced capture decides EXACTLY as the
 * serialized one: a differing key is §9's byte-equality hard block (nothing
 * written, nothing deleted - the operator's re-decide is the only way past),
 * the same key is the TOFU record agreeing with itself (the row stands,
 * updatedAt = the last accepted match, no second create row).
 */
async function acceptStandingPin(
  ownerUserId: string,
  existing: SshHostPinTable,
  fps: string[],
  destination: string,
): Promise<SshHostPinTable> {
  const stored = hostKeyFingerprints(existing.hostKey);
  if (stored.length !== 1 || stored[0] !== fps[0]) {
    // §9's byte-equality hard block, at the plane's edge: A now reports a
    // different key than the pin. Nothing written, nothing deleted - the
    // operator's re-decide (delete + fresh capture) is the only way past.
    throw new SshHostPinError(
      "changed",
      `the key home now reports a different host key for ${destination} than the pinned one`,
      destination,
    );
  }
  // The same key again is the TOFU record agreeing with itself: the row
  // stands (updatedAt = the last accepted match), no second create row.
  await repo.touchPin(ownerUserId, destination, pinsDeps().nowIso());
  return { ...existing, updatedAt: pinsDeps().nowIso() };
}

/**
 * Capture (or accept, idempotently) the owner's pin for one canonical
 * destination. `hostKeyLine` supplies the explicit-pin posture (the operator's
 * key, not a fetch); absent it, A's `known_hosts` is asked over the signed
 * RPC. Returns the standing row. Raises {@link SshHostPinError} with the
 * named cause on every fail-closed door, writing NOTHING: a stored pin that
 * disagrees is `changed` (the hard block, never an overwrite), a fresh
 * capture audits `node.ssh_host_pin.create` naming destination + fingerprint.
 */
export async function captureHostPin(args: {
  ownerUserId: string;
  /** The key home the fetch asks; null when the line is SUPPLIED (the trust screen names no machine). */
  aNodeId: string | null;
  destination: string; // canonical `user@host:port`
  hostKeyLine?: string;
}): Promise<SshHostPinTable> {
  const { ownerUserId, aNodeId, destination } = args;
  if (!isSshKnownHostsPinLine(args.hostKeyLine ?? "") && args.hostKeyLine !== undefined) {
    throw new SshHostPinError(
      "invalid-line",
      `the supplied host key for ${destination} is not one known_hosts line`,
      destination,
    );
  }
  const line = args.hostKeyLine ?? (await fetchAndChooseLine(aNodeId, destination));
  const fps = hostKeyFingerprints(line);
  if (fps.length !== 1) {
    throw new SshHostPinError(
      "invalid-line",
      `the host key for ${destination} carries no single public key`,
      destination,
    );
  }
  const existing = await repo.getPin(ownerUserId, destination);
  if (existing !== null) return await acceptStandingPin(ownerUserId, existing, fps, destination);
  const now = pinsDeps().nowIso();
  const row: SshHostPinTable = {
    id: crypto.randomUUID(),
    ownerUserId,
    destination,
    hostKey: line,
    createdAt: now,
    updatedAt: now,
  };
  // The get-then-insert above races the UNIQUE (owner_user_id, destination)
  // index: two concurrent FIRST captures of one destination both read "no
  // row". A collision is decided, never surfaced raw: the loser re-reads the
  // winner's row and accepts it through the SAME rule the serialized path
  // applies (same key = the idempotent touch, different key = the changed
  // block). A winner that vanished between the refused insert and the
  // readback (a concurrent delete) gets one retry; a second double-race
  // refuses by name rather than looping - a non-violation DB error is not a
  // race and stays loud.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await repo.insertPin(row);
      break;
    } catch (err) {
      if (!isUniquePinViolation(err)) throw err;
      const standing = await repo.getPin(ownerUserId, destination);
      if (standing !== null) return await acceptStandingPin(ownerUserId, standing, fps, destination);
      if (attempt === 1) {
        throw new SshHostPinError(
          "changed",
          `the host-pin store refused the capture for ${destination} twice while its row kept changing; ask again`,
          destination,
        );
      }
    }
  }
  await pinAudit(ownerUserId, "node.ssh_host_pin.create", aNodeId, {
    destination,
    fingerprint: fps[0], // the public identifier ONLY, never the line's bytes (§10)
    via: args.hostKeyLine !== undefined ? "explicit" : "captured",
  });
  return row;
}

/** Read the owner's pin for one destination, or null (no audit, no side effect). */
export async function hostPinFor(args: { ownerUserId: string; destination: string }): Promise<SshHostPinTable | null> {
  return await repo.getPin(args.ownerUserId, args.destination);
}

/** Delete the owner's pin (the §9 recovery's first half); false for foreign AND absent. */
export async function deleteHostPin(args: {
  ownerUserId: string;
  destination: string;
}): Promise<SshHostPinTable | null> {
  const existing = await repo.getPin(args.ownerUserId, args.destination);
  if (existing === null) return null;
  if (!(await repo.deletePin(args.ownerUserId, args.destination))) return null; // raced away
  const fps = hostKeyFingerprints(existing.hostKey);
  await pinAudit(args.ownerUserId, "node.ssh_host_pin.delete", null, {
    destination: args.destination,
    fingerprint: fps[0] ?? null, // names the removed pin; never its bytes
  });
  return existing;
}

/** One pin as the trust screen reads it: destination + fingerprint, NEVER key bytes. */
export interface SshHostPinView {
  /** Pin row id (uuid) */
  id: string;
  /** Canonical resolved destination `user@host:port` */
  destination: string;
  /** The pinned key's `SHA256:` display fingerprint (a public identifier; the line itself is not serialized) */
  fingerprint: string;
  /** ISO 8601 first capture (the TOFU moment) */
  createdAt: string;
  /** ISO 8601 of the last accepted match */
  updatedAt: string;
}

/** The trust screen's list: every one of the owner's pins, display-shaped. */
export async function listHostPins(args: { ownerUserId: string }): Promise<SshHostPinView[]> {
  const rows = await repo.listPins(args.ownerUserId);
  return rows.map((row) => ({
    id: row.id,
    destination: row.destination,
    fingerprint: hostKeyFingerprints(row.hostKey)[0] ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* refusal mapping: the RPC's kinds and the capture's own doors        */
/* ------------------------------------------------------------------ */

/** The coded refusal shape shared by trust and connection operations. */
export type SshHostPinRefusal = { status: 400 | 403 | 404 | 409 | 502; code: BackendErrorCodes; message: string };

/** Map the capture's own error onto the coded refusal its caller renders. */
export function hostPinRefusal(err: SshHostPinError): SshHostPinRefusal {
  switch (err.code) {
    case "no-pin":
      return {
        status: 409,
        code: BackendErrorCodes.SSH_HOST_PIN_MISSING,
        message:
          "The key home has no recorded host key for that destination. Connect to it once from the key home, or supply its host key on the trust screen.",
      };
    case "ambiguous":
      return {
        status: 409,
        code: BackendErrorCodes.SSH_HOST_PIN_MISSING,
        message:
          "The key home recorded more than one host key for that destination. Resolve its known_hosts entry, then ask again.",
      };
    case "changed":
      return {
        status: 409,
        code: BackendErrorCodes.SSH_HOST_PIN_CHANGED,
        message:
          "The key home now reports a different host key for that destination than the stored pin. Verify out of band, delete the pin, and retry the connection to trust the verified key.",
      };
    case "invalid-line":
      return { status: 400, code: BackendErrorCodes.SSH_HOST_PIN_INVALID, message: err.message };
    case "offline":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "The key home has no live connection right now; bring its Subshell app online and ask again.",
      };
    case "unsupported":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_OUTDATED,
        message: "The Subshell app on the key home is too old to report host keys. Update it from its machine page.",
      };
    case "timeout":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_UNREACHABLE,
        message: "The key home did not answer the host-key request in time; check its connection and ask again.",
      };
    case "refused":
    case "malformed":
      return {
        status: 502,
        code: BackendErrorCodes.SSH_NODE_REFUSED,
        message: "The key home refused the host-key request. Check that SSH is switched on there.",
      };
  }
}

/** The RPC error as the capture's own named cause (the machine's text goes to the LOG, never the refusal). */
function rpcFailure(err: SshRpcError, destination: string): SshHostPinError {
  if (err.kind === "refused" || err.kind === "malformed") {
    logger
      .withError(err)
      .warn(`ssh host-key rpc ${err.kind} failed against node ${err.nodeId}: ${err.detail ?? err.message}`);
  }
  return new SshHostPinError(err.kind, `host-key capture for ${destination} failed: ${err.kind}`, destination);
}

function pinAudit(
  actorUserId: string,
  action: string,
  aNodeId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const event: AuditEventInput = {
    actorUserId,
    action,
    targetType: aNodeId === null ? null : "node",
    targetId: aNodeId,
    metadataJson: JSON.stringify(metadata),
  };
  return audit(event);
}

/** Read the stored destination pin, capturing from the key home's trust on first use. */
export async function ensureDestinationPin(args: {
  ownerUserId: string;
  aNodeId: string;
  destination: string;
}): Promise<{ line: string }> {
  const existing = await hostPinFor({ ownerUserId: args.ownerUserId, destination: args.destination });
  if (existing !== null) return { line: existing.hostKey };
  return { line: (await captureHostPin(args)).hostKey };
}
