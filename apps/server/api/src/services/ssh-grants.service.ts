import { BackendErrorCodes } from "@internal/backend-errors";
import {
  isSshGrantFingerprints,
  type NodeSshAgentIdentitiesResult,
  type NodeSshAgentIdentity,
  SSH_MAX_GRANT_FINGERPRINTS,
  SSH_NAME_MAX_CHARS,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { type NewSshGrantRequest, SshGrantsRepository } from "@/db/repositories/ssh-grants.repository.js";
import type { SshGrantCreatedVia, SshGrantRequestStatus, SshKeyGrantTable } from "@/db/types/ssh-grants.db-types.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { SshRpcError, sshAgentIdentities } from "@/services/nodes/ssh-rpc.js";
import { getNotifyService } from "@/services/notify.service.js";
import { captureHostPin, hostPinFor, hostPinRefusal, SshHostPinError } from "@/services/ssh-host-pins.service.js";
import { getRelayBroker, type RelayBroker, type RelayPeerKeys, SshRelayRefusal } from "@/services/ssh-relay.service.js";
import { logger } from "@/utils/logger.js";

/**
 * The key-grant authorization layer (spec 2026-10-08 §6; migration 0050).
 * This module is the ONLY place a grant is decided, asked, answered, edited,
 * or revoked; the launch path and the routes are its callers.
 *
 * **The flow the layer implements** (§6.2/§6.3): a relay launch asks
 * {@link matchGrant} first. A standing grant answers with the selection;
 * nothing else does, so {@link prepareRelayLeg} opens a broker session only
 * under a row that existed at the match read and still exists after the open
 * (the liveness re-check is decision 3's answer to T8 NIT1: a revoke landing
 * between the match and `openRelay` finds no orphan, because the fresh
 * session is cut with the named reason and the launch refuses). No grant:
 * {@link requestFirstUse} records the durable pending row, notifies the
 * owner, and the launch fails fast with the named refusal - never a pane
 * hanging on a human.
 *
 * **The owner model** (decision 5, spec §6.2): a grant and its requests are
 * owned by the key home's owner, and the launch gates A through `nodeCanSsh`
 * before this layer is ever consulted - SSH is owner-reserved on agent nodes,
 * so the asking user, the row's owner, and the approving operator are one
 * account. The routes render foreign ids as the 404 the ownership axis
 * demands; a foreign row is absent here, never "forbidden".
 *
 * **What may and may not leave this layer's row** (Global Constraints; spec
 * §9/§10): the fingerprint VALUES are public `SHA256:` identifiers, and the
 * `approve` and `create` audit rows NAME them - that row pair is the durable
 * record of the operator's selection, and a count records no selection. The
 * values appear in NO OTHER audit row (an edit names the count), NO
 * notification (fixed copy + the opaque request id), and NO log line this
 * file writes; no key material, challenge, or signature ever rides any row.
 *
 * Everything outside the module is an injected seam (the `getNodeWsDeps`
 * pattern): the clock, the relay broker, the notification sink, and the
 * roster RPC the approval screen reads. The production defaults sit at the
 * bottom; tests replace the whole set.
 */

/** How long an unanswered first-use request stays answerable: setup-key scale (24 h). */
export const GRANT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const repo = new SshGrantsRepository(db);

/** The service's world. Production at {@link defaultGrantsDeps}; tests install a fake. */
export interface SshGrantsDeps {
  /** The one clock: row stamps, dedup cuts, the expiry sweep. */
  nowIso(): string;
  /** The relay broker the revoke hook and the launch leg reach (the module singleton). */
  broker(): RelayBroker;
  /** Ring the owner about one pending request (fire-and-forget; the sink swallows its own failures). */
  notifyGrantApproval(ownerUserId: string, requestId: string): void;
  /**
   * Ask one machine for its live agent's public roster over the node link
   * (default: `ssh-rpc.sshAgentIdentities`, the `??` at the call site being
   * the production wiring - the NodeWsDeps.detect shape). A test seam so the
   * approval surface can pin fail-closed behavior without a live socket.
   */
  fetchAgentIdentities?(nodeId: string): Promise<NodeSshAgentIdentitiesResult>;
}

let depsOverride: SshGrantsDeps | null = null;

function grantsDeps(): SshGrantsDeps {
  if (depsOverride) return depsOverride;
  return {
    nowIso: () => new Date().toISOString(),
    broker: () => getRelayBroker(),
    notifyGrantApproval: (ownerUserId, requestId) => {
      // The notify surface is best-effort by its own contract; the durable
      // pending row is the real record, so this call is never awaited.
      getNotifyService()
        .notifyGrantApprovalOwner(ownerUserId, requestId)
        .catch((err: unknown) => logger.warn(`grant_approval notify dispatch failed: ${String(err)}`));
    },
  };
}

/**
 * Install (or with null, drop) the whole seam.
 * @internal test-only - the suite pins first-use/notify, the broker hooks, and
 * the clock without a live plane, socket, or real 24 h wait.
 */
export function setSshGrantsDepsForTests(deps: SshGrantsDeps | null): void {
  depsOverride = deps;
}

/* ------------------------------------------------------------------ */
/* selector grammar: concrete host or `*` pattern, matched on hostnames */
/* ------------------------------------------------------------------ */

/**
 * Normalize one destination selector: trim, lowercase (hostnames are
 * case-insensitive; the stored selector is compared against lowercased
 * resolved hosts), and enforce the pattern grammar - `[a-z0-9*._-]`, must
 * hold at least one literal character ("*" alone names nothing), no leading
 * `-`/`.`, no doubled `*`, no `..`, no whitespace or control characters, at
 * most {@link SSH_NAME_MAX_CHARS}. Parent §5.1: the selector is a concrete
 * host or a host glob matched against the resolved destination hostname, as
 * policy only, unrelated to the wildcard patterns discovery drops.
 *
 * KNOWN LIMITATION (PR #338 review round 2, documented not fixed): the
 * alphabet has no `:` or bracket, so an IPv6-literal destination (the
 * bracketed spelling OpenSSH itself uses, `[::1]:22`) can never be named by
 * a selector and can therefore never hold a standing grant. The consequence
 * is fail-closed by construction - every launch to such a destination
 * re-asks through first-use approval and nothing is ever over-granted.
 * Widening the grammar to colons and brackets is a design decision (it
 * changes what a stored grant line can match), not a bug fix.
 *
 * @returns the normalized selector, or null for anything the grammar refuses.
 */
export function normalizeSshGrantSelector(value: string): string | null {
  const s = value.trim().toLowerCase();
  if (s.length === 0 || s.length > SSH_NAME_MAX_CHARS) return null;
  if (/\s/.test(s) || /\p{Cc}/u.test(s)) return null;
  if (s.startsWith("-") || s.startsWith(".") || s.endsWith(".") || s.includes("..") || s.includes("**")) return null;
  if (!/^[a-z0-9*][a-z0-9.*_-]*$/.test(s)) return null;
  if (!/[a-z0-9]/.test(s)) return null;
  return s;
}

/** Escape one glob segment: `*` is the only wildcard, the dot stays a dot. */
function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a normalized selector against one resolved destination hostname
 * (§6.1: matched against the resolved hostname, not the alias the human
 * typed). A selector with no `*` is an exact string equality; with wildcards,
 * every `*` spans any run of characters and everything else is literal.
 */
export function sshGrantSelectorMatches(normalizedSelector: string, resolvedHost: string): boolean {
  const host = resolvedHost.trim().toLowerCase();
  if (!normalizedSelector.includes("*")) return normalizedSelector === host;
  const pattern = new RegExp(`^${normalizedSelector.split("*").map(escapeSegment).join(".*")}$`);
  return pattern.test(host);
}

/** Specificity for the §6.3 tie-break: fewer wildcards first, then more literal characters. */
function selectorSpecificity(selector: string): { wildcards: number; literals: number } {
  return {
    wildcards: (selector.match(/\*/g) ?? []).length,
    literals: selector.replace(/\*/g, "").length,
  };
}

/* ------------------------------------------------------------------ */
/* views: the row with its JSON columns parsed                         */
/* ------------------------------------------------------------------ */

/** One grant row as the API and the launch leg read it: fingerprints parsed, not a JSON string. */
export interface SshGrantView {
  /** Unique grant row id (uuid) */
  id: string;
  /** Display name the operator gave the grant (defaults to the selector when unnamed) */
  name: string;
  /** Machine A: the key home whose ssh-agent signs under this grant */
  keyHomeNodeId: string;
  /** The destination selector, stored resolved (concrete hostname or `*` host pattern, lowercase) */
  resolvedSelector: string;
  /** The chosen public agent identities (`SHA256:` strings, parsed from the stored JSON array) - exactly which keys may sign */
  fingerprints: string[];
  /** Which door created the row: an approved first use or the grants screen */
  createdVia: SshGrantCreatedVia;
  /** ISO 8601 creation stamp (the match tie-break: oldest grant wins) */
  createdAt: string;
  /** ISO 8601 of the last operator edit (name/selector) */
  updatedAt: string;
}

/** One first-use request row as the approvals screen reads it. */
export interface SshGrantRequestView {
  /** Request row id (uuid) - the opaque ref the launch refusal and the notification name */
  id: string;
  /** Machine A asked to sign (the key home whose owner must answer) */
  keyHomeNodeId: string;
  /** The resolved destination hostname the asking launch would have dialed */
  resolvedSelector: string;
  /** Fingerprints that rode the request; null when none did (the approver selects, the asking pane proposes nothing) */
  requestedFingerprints: string[] | null;
  /** B's pane (subshell id) whose launch asked - what the screen names as the requester */
  paneId: string;
  /** B's node id: the connecting machine of the asking launch */
  bNodeId: string;
  /** ISO 8601 answer deadline (24 h); past it the lazy sweep marks the row expired and writes nothing */
  expiresAt: string;
  /** Lifecycle state - only `pending` is answerable */
  status: SshGrantRequestStatus;
  /** ISO 8601 creation stamp */
  createdAt: string;
}

function parseFingerprintArray(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((f) => typeof f === "string") ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function grantView(row: SshKeyGrantTable): SshGrantView {
  return { ...row, fingerprints: parseFingerprintArray(row.fingerprints) };
}

/* ------------------------------------------------------------------ */
/* fingerprint selection: cap and grammar, law first                   */
/* ------------------------------------------------------------------ */

/**
 * The refusal union the grant surface returns. The status set matches the
 * ssh-launch one's coded arms (no 422 - the outcome-in-data grammar is the
 * resolve surface's), so the SAME `throwCodedRefusal` renders both. The gate
 * arms (403 gate-off, 502 machine-refused) reach it through the launcher's
 * `gateSshNode` when a create names a machine the caller may not use.
 */
type SshRefusalNarrow = { status: 400 | 403 | 404 | 409 | 502; code: BackendErrorCodes; message: string };

/** The grant surface's answer union: a value, or the refusal the route returns as-is. */
export type SshGrantAnswer<T> = { ok: true; value: T } | { ok: false; refusal: SshRefusalNarrow };

function granted<T>(value: T): SshGrantAnswer<T> {
  return { ok: true, value };
}

function refused(refusal: SshRefusalNarrow): SshGrantAnswer<never> {
  return { ok: false, refusal };
}

const NOT_FOUND_REQUEST = {
  status: 404,
  code: BackendErrorCodes.NOT_FOUND_ERROR,
  message: "Grant request not found",
} as const;

const NOT_FOUND_GRANT = {
  status: 404,
  code: BackendErrorCodes.NOT_FOUND_ERROR,
  message: "Grant not found",
} as const;

const ALREADY_ANSWERED = {
  status: 409,
  code: BackendErrorCodes.SSH_GRANT_ALREADY_ANSWERED,
  message: "That grant request has already been answered.",
} as const;

/* ------------------------------------------------------------------ */
/* audit: ids, hosts, the CHOSEN fingerprints on approve/create (§10), */
/* counts elsewhere - never key material, challenge, or signature      */
/* ------------------------------------------------------------------ */

function grantAudit(
  actorUserId: string,
  action: string,
  aNodeId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const event: AuditEventInput = {
    actorUserId,
    action,
    targetType: "node",
    targetId: aNodeId,
    metadataJson: JSON.stringify(metadata),
  };
  return audit(event);
}

/* ------------------------------------------------------------------ */
/* first use                                                           */
/* ------------------------------------------------------------------ */

/**
 * Record the first-use approval question (spec §6.2): the DURABLE pending row
 * first, then the owner-addressed notify, then the launch's caller fails it
 * fast. A standing pending row for the same (owner, key home, selector) is
 * FOUND, not duplicated (§6.2: "a re-launch simply finds the pending row"),
 * and the found path sends no second notification and no second audit.
 * Does NOT open a relay - that is {@link prepareRelayLeg} on the next launch.
 */
export async function requestFirstUse(args: {
  ownerUserId: string;
  aNodeId: string;
  bNodeId: string;
  resolvedSelector: string;
  /**
   * The FULL canonical destination `user@host:port` the asking launch dialed
   * (Task 12): the approval that answers this row also captures the host-key
   * pin, and the pin is keyed per triple - the host alone cannot name a port
   * or a user. Row-stored (migration 0051), never re-derived at approval.
   */
  destination: string;
  paneId: string;
}): Promise<SshGrantAnswer<{ requestId: string; reused: boolean }>> {
  const now = grantsDeps().nowIso();
  await repo.sweepExpiredRequests(now);
  const existing = await repo.findPendingRequest(args.ownerUserId, args.aNodeId, args.resolvedSelector, now);
  if (existing) return granted({ requestId: existing.id, reused: true });
  const request: NewSshGrantRequest = {
    id: crypto.randomUUID(),
    ownerUserId: args.ownerUserId,
    keyHomeNodeId: args.aNodeId,
    resolvedSelector: args.resolvedSelector,
    destination: args.destination,
    requestedFingerprints: null, // the approver selects; the asking pane proposes nothing (spec §6.2)
    paneId: args.paneId,
    bNodeId: args.bNodeId,
    expiresAt: new Date(Date.parse(now) + GRANT_REQUEST_TTL_MS).toISOString(),
    status: "pending",
    createdAt: now,
  };
  await repo.insertRequest(request);
  await grantAudit(args.ownerUserId, "node.ssh_grant.request", args.aNodeId, {
    requestId: request.id,
    paneId: args.paneId,
    aNodeId: args.aNodeId,
    bNodeId: args.bNodeId,
    destination: args.resolvedSelector,
  });
  grantsDeps().notifyGrantApproval(args.ownerUserId, request.id);
  return granted({ requestId: request.id, reused: false });
}

/**
 * The expiry sweep (spec §6.2: "expiry writes nothing at all"): mark every
 * past-deadline pending row `expired`. No audit row, no grant, no
 * notification; the boot/hourly hook in `index.ts` runs it on the same
 * cadence as the signup queue it borrows, and the read paths call it lazily
 * so an unanswered question flips state before anyone answers it.
 *
 * @returns the number of rows swept
 */
export async function sweepExpiredGrantRequests(): Promise<number> {
  return await repo.sweepExpiredRequests(grantsDeps().nowIso());
}

/* ------------------------------------------------------------------ */
/* answering: approve / deny                                           */
/* ------------------------------------------------------------------ */

/**
 * Answer a pending request YES (spec §6.2): validate the selection against
 * the cap and the grammar FIRST, then - Task 12 - ensure the destination's
 * host-key PIN exists (capture from A's `known_hosts`, or accept the owner's
 * standing/explicit pin: the approval is "grant creation" for the first-use
 * door, and a relay grant is never created without its pin), then flip the
 * row `pending -> approved` on a compare-and-set (a raced approver or the
 * sweep loses here and sees the 409, never a double grant), then write the
 * standing grant with EXACTLY the chosen fingerprints, created via first-use.
 * Audits BOTH facts: the answer (`approve`) and the row's birth (`create`,
 * the same event the screen's own create writes, per §6.2), naming ids,
 * destination, and the CHOSEN fingerprint VALUES - §10 makes the approve row
 * the only durable record of the operator's selection, so a count here would
 * record no selection. A capture failure leaves the row PENDING and the grant
 * unwritten (the pending row is what makes the ask retryable); a pin row
 * captured before a lost race stands harmless - same owner, same key home,
 * same destination, and the retried capture accepts it idempotently.
 */
export async function approveGrant(args: {
  ownerUserId: string;
  requestId: string;
  fingerprints: readonly string[];
  name?: string;
}): Promise<SshGrantAnswer<{ grant: SshGrantView }>> {
  const keys = await validateSelectionOf(args.fingerprints);
  if (!keys.ok) return keys.answer;
  const now = grantsDeps().nowIso();
  await repo.sweepExpiredRequests(now);
  const row = await repo.getRequest(args.ownerUserId, args.requestId);
  if (!row) return refused(NOT_FOUND_REQUEST);
  if (row.status !== "pending") return refused(ALREADY_ANSWERED);
  // Capture-at-grant-creation (spec §9), before the flip and before the grant
  // row exists: no pin, no grant. The stored pin (a previous grant's TOFU
  // record for the same destination) satisfies the door WITHOUT re-asking A -
  // the TOFU decision persists across grants; only an ABSENT pin triggers the
  // fetch, whose every failure leaves the request pending untouched.
  if (row.destination === null) {
    return refused({
      status: 409,
      code: BackendErrorCodes.SSH_HOST_PIN_MISSING,
      message:
        "This request predates host-key pinning and carries no full destination to pin. Deny it and launch again to ask fresh.",
    });
  }
  try {
    await ensureDestinationPin({
      ownerUserId: args.ownerUserId,
      aNodeId: row.keyHomeNodeId,
      destination: row.destination,
    });
  } catch (err) {
    if (err instanceof SshHostPinError) return refused(hostPinRefusal(err));
    throw err;
  }
  const flipped = await repo.markRequestStatus(args.ownerUserId, args.requestId, "pending", "approved");
  if (!flipped) return refused(ALREADY_ANSWERED);
  const grant: SshKeyGrantTable = {
    id: crypto.randomUUID(),
    ownerUserId: args.ownerUserId,
    name: args.name?.trim() || row.resolvedSelector,
    keyHomeNodeId: row.keyHomeNodeId,
    resolvedSelector: row.resolvedSelector,
    fingerprints: JSON.stringify(keys.value),
    createdVia: "first-use",
    createdAt: now,
    updatedAt: now,
  };
  await repo.insertGrant(grant);
  await grantAudit(args.ownerUserId, "node.ssh_grant.approve", row.keyHomeNodeId, {
    requestId: row.id,
    grantId: grant.id,
    destination: row.resolvedSelector,
    fingerprints: keys.value, // the CHOSEN VALUES; §10's durable selection record
  });
  await grantAudit(args.ownerUserId, "node.ssh_grant.create", row.keyHomeNodeId, {
    grantId: grant.id,
    destination: row.resolvedSelector,
    fingerprints: keys.value,
    via: "first-use",
  });
  return granted({ grant: grantView(grant) });
}

/**
 * Answer a pending request NO (spec §6.2): the audit row and nothing else -
 * no grant, no pin, and the requesting pane's next relaunch simply asks
 * again (a fresh question, since denial is an answer, not a standing state).
 */
export async function denyGrant(args: {
  ownerUserId: string;
  requestId: string;
}): Promise<SshGrantAnswer<{ requestId: string }>> {
  const now = grantsDeps().nowIso();
  await repo.sweepExpiredRequests(now);
  const row = await repo.getRequest(args.ownerUserId, args.requestId);
  if (!row) return refused(NOT_FOUND_REQUEST);
  if (row.status !== "pending") return refused(ALREADY_ANSWERED);
  const flipped = await repo.markRequestStatus(args.ownerUserId, args.requestId, "pending", "denied");
  if (!flipped) return refused(ALREADY_ANSWERED);
  await grantAudit(args.ownerUserId, "node.ssh_grant.deny", row.keyHomeNodeId, {
    requestId: row.id,
    paneId: row.paneId,
    bNodeId: row.bNodeId,
    destination: row.resolvedSelector,
  });
  return granted({ requestId: row.id });
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * The §6.3 match: the owner's standing grants for the key home chosen at
 * launch, selector-matched against the resolved destination hostname. Most
 * specific selector wins; equal specificity ties to the OLDEST grant. B is
 * not part of the predicate (a grant authorizes the owner's own connecting
 * machines, §6.3), and a foreign or deleted grant is invisible here exactly
 * as on the screen.
 */
export async function matchGrant(args: {
  ownerUserId: string;
  aNodeId: string;
  resolvedHost: string;
}): Promise<SshGrantView | null> {
  const rows = await repo.grantsFor(args.ownerUserId, args.aNodeId);
  const host = args.resolvedHost.trim().toLowerCase();
  const matches = rows
    .map((row) => ({ row, spec: selectorSpecificity(row.resolvedSelector) }))
    .filter((m) => sshGrantSelectorMatches(m.row.resolvedSelector, host));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (a.spec.wildcards !== b.spec.wildcards) return a.spec.wildcards - b.spec.wildcards;
    if (a.spec.literals !== b.spec.literals) return b.spec.literals - a.spec.literals;
    return a.row.createdAt < b.row.createdAt ? -1 : a.row.createdAt > b.row.createdAt ? 1 : 0;
  });
  const first = matches[0];
  return first ? grantView(first.row) : null;
}

/* ------------------------------------------------------------------ */
/* the grants screen: create / edit / revoke                           */
/* ------------------------------------------------------------------ */

/** Create a grant from the screen (spec §8; §6.2: the same row and event the approval writes). */
export async function createGrant(args: {
  ownerUserId: string;
  aNodeId: string;
  name: string;
  selector: string;
  fingerprints: readonly string[];
}): Promise<SshGrantAnswer<{ grant: SshGrantView }>> {
  const selector = normalizeSshGrantSelector(args.selector);
  if (selector === null) return refused(SELECTOR_INVALID);
  const keys = await validateSelectionOf(args.fingerprints);
  if (!keys.ok) return keys.answer;
  const now = grantsDeps().nowIso();
  const grant: SshKeyGrantTable = {
    id: crypto.randomUUID(),
    ownerUserId: args.ownerUserId,
    name: args.name.trim() || selector,
    keyHomeNodeId: args.aNodeId,
    resolvedSelector: selector,
    fingerprints: JSON.stringify(keys.value),
    createdVia: "manual",
    createdAt: now,
    updatedAt: now,
  };
  await repo.insertGrant(grant);
  await grantAudit(args.ownerUserId, "node.ssh_grant.create", args.aNodeId, {
    grantId: grant.id,
    destination: selector,
    fingerprints: keys.value, // the same selection record the approved first use writes (§10)
    via: "manual",
  });
  return granted({ grant: grantView(grant) });
}

const SELECTOR_INVALID: SshRefusalNarrow = {
  status: 400,
  code: BackendErrorCodes.SSH_GRANT_SELECTOR_INVALID,
  message: "That grant selector is not a hostname pattern.",
};

/**
 * Edit the screen's own fields: name and/or selector. The fingerprint
 * SELECTION is immutable through edit - changing which keys serve is a
 * revoke plus a fresh grant, so the standing selection always has exactly the
 * audit trail that chose it (§6.2's posture extended to edits by the
 * revoke-is-the-only-widening rule).
 */
export async function updateGrant(args: {
  ownerUserId: string;
  grantId: string;
  name?: string;
  selector?: string;
}): Promise<SshGrantAnswer<{ grant: SshGrantView }>> {
  let selector: string | undefined;
  if (args.selector !== undefined) {
    const normalized = normalizeSshGrantSelector(args.selector);
    if (normalized === null) return refused(SELECTOR_INVALID);
    selector = normalized;
  }
  const existing = await repo.getGrant(args.ownerUserId, args.grantId);
  if (!existing) return refused(NOT_FOUND_GRANT);
  const updated = await repo.updateGrant(args.ownerUserId, args.grantId, {
    name: args.name?.trim(),
    resolvedSelector: selector,
    updatedAt: grantsDeps().nowIso(),
  });
  if (!updated) return refused(NOT_FOUND_GRANT);
  await grantAudit(args.ownerUserId, "node.ssh_grant.update", updated.keyHomeNodeId, {
    grantId: updated.id,
    destination: updated.resolvedSelector,
    fingerprintsCount: parseFingerprintArray(updated.fingerprints).length,
    changed: [args.name !== undefined ? "name" : null, selector !== undefined ? "selector" : null].filter(Boolean),
  });
  return granted({ grant: grantView(updated) });
}

/**
 * Revoke, the instant both-ways cut (§6.3): the row goes FIRST (the raced
 * launch's post-open liveness re-check then answers "gone"), then the broker
 * tears down every live session that ran under this grant, with the named
 * `grant-revoked` reason. This is the hook T8 left standing; without the
 * second call a signing session would ride on after the operator said stop.
 */
export async function revokeGrant(args: {
  ownerUserId: string;
  grantId: string;
}): Promise<SshGrantAnswer<{ relaysClosed: number }>> {
  const existing = await repo.getGrant(args.ownerUserId, args.grantId);
  if (!existing) return refused(NOT_FOUND_GRANT);
  const deleted = await repo.deleteGrant(args.ownerUserId, args.grantId);
  if (!deleted) return refused(NOT_FOUND_GRANT); // raced with itself; the row is gone either way
  const relaysClosed = await grantsDeps().broker().closeForGrant(args.grantId, "grant-revoked");
  await grantAudit(args.ownerUserId, "node.ssh_grant.delete", existing.keyHomeNodeId, {
    grantId: args.grantId,
    destination: existing.resolvedSelector,
    relaysClosed,
  });
  return granted({ relaysClosed });
}

/** The grants screen list. */
export async function listGrants(args: { ownerUserId: string }): Promise<SshGrantView[]> {
  return (await repo.listGrants(args.ownerUserId)).map(grantView);
}

/** The approvals queue (pending by default); the lazy sweep runs first. */
export async function listGrantRequests(args: {
  ownerUserId: string;
  statuses?: readonly SshGrantRequestStatus[];
}): Promise<SshGrantRequestView[]> {
  const now = grantsDeps().nowIso();
  await repo.sweepExpiredRequests(now);
  return (await repo.listRequests(args.ownerUserId, args.statuses)).map((row) => ({
    id: row.id,
    keyHomeNodeId: row.keyHomeNodeId,
    resolvedSelector: row.resolvedSelector,
    requestedFingerprints: row.requestedFingerprints === null ? null : parseFingerprintArray(row.requestedFingerprints),
    paneId: row.paneId,
    bNodeId: row.bNodeId,
    expiresAt: row.expiresAt,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

/* ------------------------------------------------------------------ */
/* the roster fetch: the choice list behind BOTH grant doors (§5.4,    */
/* Task 11's approval screen; Task 18's create picker reads it by node) */
/* ------------------------------------------------------------------ */

/**
 * Read the key home's public agent roster for the approval screen (spec
 * 2026-10-08 §5.4): the signed `ssh_agent_identities` command goes to A over
 * the existing node-link RPC, and the answer is A's WHOLE roster - the
 * operator selects the grant's subset from it, capped at approval, never
 * here. The read is a question, not an answer: it writes NO audit row and
 * changes no row, and every failure (offline, outdated, timeout, refusal,
 * malformed answer) answers the named error with the request left PENDING.
 * Fabricating an empty roster would read to the operator as "A holds no
 * keys"; an empty roster that is the truth comes from a live agent and rides
 * the answer untouched.
 */
export async function listRequestAgentIdentities(args: {
  ownerUserId: string;
  requestId: string;
}): Promise<SshGrantAnswer<{ identities: NodeSshAgentIdentity[] }>> {
  const now = grantsDeps().nowIso();
  await repo.sweepExpiredRequests(now);
  const row = await repo.getRequest(args.ownerUserId, args.requestId);
  if (!row) return refused(NOT_FOUND_REQUEST);
  if (row.status !== "pending") return refused(ALREADY_ANSWERED);
  return await fetchAgentRoster(row.keyHomeNodeId);
}

/**
 * Fetch one machine's public roster over the node link and map every failure
 * to the grant-surface refusal (Task 18: the shared half of BOTH roster
 * reads - the request-scoped one above and the roster-by-node read behind
 * the create picker, which reaches it with a directly-chosen key home and no
 * request row at all). Same command, same grammar, same fail-closed doors.
 */
export async function fetchAgentRoster(
  aNodeId: string,
): Promise<SshGrantAnswer<{ identities: NodeSshAgentIdentity[] }>> {
  try {
    const fetcher = grantsDeps().fetchAgentIdentities ?? sshAgentIdentities; // the `??` is the production wiring
    const roster = await fetcher(aNodeId);
    return granted({ identities: roster.identities });
  } catch (err) {
    if (err instanceof SshRpcError) return refused(rosterRpcRefusal(err));
    throw err;
  }
}

/**
 * The roster RPC's failure as a grant-surface refusal: the same code family
 * `ssh-launch`'s `rpcRefusal` uses (they are the same doors on the same
 * link), with the KEY HOME named in the copy and the agent's own text kept
 * out of the response (it reaches the log on the refused/malformed arm, per
 * the files-remote-browse posture). The pending row rides untouched through
 * every arm - §5.4's "stays pending until A is reachable" is exactly the
 * absence of a write here.
 */
function rosterRpcRefusal(err: SshRpcError): SshRefusalNarrow {
  if (err.kind === "offline") {
    return {
      status: 409,
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "The key home has no live connection right now; bring its Subshell app online and ask again.",
    };
  }
  if (err.kind === "unsupported") {
    return {
      status: 409,
      code: BackendErrorCodes.NODE_OUTDATED,
      message: "The Subshell app on the key home is too old to report its agent keys. Update it from its machine page.",
    };
  }
  if (err.kind === "timeout") {
    return {
      status: 409,
      code: BackendErrorCodes.NODE_UNREACHABLE,
      message: "The key home did not answer the roster request in time; check its connection and ask again.",
    };
  }
  logger
    .withError(err)
    .warn(`ssh roster rpc ${err.kind} failed against node ${err.nodeId}: ${err.detail ?? err.message}`);
  return {
    status: 502,
    code: BackendErrorCodes.SSH_NODE_REFUSED,
    message: "The key home refused the roster request. Check that SSH is switched on there and an agent is running.",
  };
}

/* ------------------------------------------------------------------ */
/* the pin door (spec 2026-10-08 §9, Task 12): a relay never opens     */
/* without the destination's stored pin - the approval captures one   */
/* (this helper's first-use half) and the launch leg captures at the   */
/* first open for a destination a manual grant has not pinned yet.     */
/* ------------------------------------------------------------------ */

/**
 * Read the destination's pin, capturing from A's `known_hosts` when none
 * stands. Returns the row's pinned `known_hosts` line - the exact bytes that
 * ride the relay-open to B. Raises {@link SshHostPinError} with the named
 * cause on every fail-closed door (no entry, ambiguous, changed, the machine
 * unreachable); nothing is written and no relay opens past one.
 */
export async function ensureDestinationPin(args: {
  ownerUserId: string;
  aNodeId: string;
  destination: string;
}): Promise<{ line: string }> {
  const existing = await hostPinFor({ ownerUserId: args.ownerUserId, destination: args.destination });
  if (existing !== null) return { line: existing.hostKey };
  const row = await captureHostPin(args);
  return { line: row.hostKey };
}

/* ------------------------------------------------------------------ */
/* the launch leg: match -> open (or ask -> refuse)                    */
/* ------------------------------------------------------------------ */

/**
 * The relay launch's authorization leg, run by `sshLaunch` once B is gated,
 * the destination resolved, and the pane id minted (decision 2: this is
 * where `openRelay` finally gets its production caller):
 *
 * 1. {@link matchGrant} - a standing grant answers.
 * 2. No grant: {@link requestFirstUse} + the named 409 fail-fast. Nothing
 *    was opened, nothing will hang; the pane never exists.
 * 3. A grant: read BOTH machines' registered halves from the identities
 *    store (a slot still empty is the named identity refusal, with the
 *    §4.3 `ready` bootstrap as the remedy), re-check grant liveness,
 *    `openRelay`, then re-check liveness AGAIN: a revoke landing across the
 *    open cuts the fresh session with the named reason and refuses the
 *    launch, so no orphan rides under a dead grant (decision 3 / T8 NIT1).
 *
 * @returns the broker's byte-checked `socketPath` (the launch exports it as
 *   the scoped `SSH_AUTH_SOCK` through `sshRelayPaneEnv`) and the grant id.
 */
export async function prepareRelayLeg(args: {
  viewerId: string;
  aNode: { id: string; name: string };
  bNodeId: string;
  resolvedHost: string;
  /**
   * The canonical destination `user@host:port` the launch dialed (Task 12):
   * the pin lookup key AND the capture destination (a manual wildcard grant
   * gets its pin at this first open for each concrete destination - "one
   * selector over many hosts yields many pins"), AND the first-use row's
   * stored destination. The relay-open never carries a pairing without it.
   */
  destination: string;
  paneId: string;
}): Promise<SshGrantAnswer<{ socketPath: string; grantId: string }>> {
  const grant = await matchGrant({
    ownerUserId: args.viewerId,
    aNodeId: args.aNode.id,
    resolvedHost: args.resolvedHost,
  });
  if (!grant) {
    const asked = await requestFirstUse({
      ownerUserId: args.viewerId,
      aNodeId: args.aNode.id,
      bNodeId: args.bNodeId,
      resolvedSelector: args.resolvedHost,
      destination: args.destination,
      paneId: args.paneId,
    });
    const ref = asked.ok ? asked.value.requestId : "";
    return refused({
      status: 409,
      code: BackendErrorCodes.SSH_GRANT_APPROVAL_REQUIRED,
      message: `Asked ${args.aNode.name} to approve signing with its keys${ref ? ` (request ${ref})` : ""}. Launch again once it is approved.`,
    });
  }
  const identities = new IdentitiesRepository(db);
  const [rowA, rowB] = await Promise.all([
    identities.findByPrincipal(`node:${args.aNode.id}`),
    identities.findByPrincipal(`node:${args.bNodeId}`),
  ]);
  // The two halves the broker pairs: the registered ES256 signing JWK and the
  // ECDH-ES encryption JWK, both read from the identities store, never from
  // the caller. A row without either half is the named refusal - the §4.3
  // `ready` bootstrap or a re-enroll is the only thing that fills a slot.
  const peerHalf = (row: typeof rowA): RelayPeerKeys | null =>
    row && row.signingPublicKey !== null
      ? { signingPublicKey: row.signingPublicKey, encryptionPublicJwk: row.publicKey }
      : null;
  const aPeer = peerHalf(rowA);
  const bPeer = peerHalf(rowB);
  if (!aPeer || !bPeer) {
    return refused({
      status: 409,
      code: BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING,
      message:
        "That key home or connecting machine has not registered its relay identity yet. Re-enroll it, or wait for its next check-in to deliver the key.",
    });
  }
  // Liveness immediately BEFORE the open: the cheap read that makes the
  // window this call cannot close (between match and here) at least start
  // from a row that still exists.
  const standing = await repo.getGrant(args.viewerId, grant.id);
  if (!standing) {
    return refused(GRANT_REVOKED_DURING_LAUNCH);
  }
  // The pin door (spec §9, Task 12): read the destination's stored pin,
  // capturing from A's `known_hosts` at first open when none stands (the
  // manual-grant and later-destination case). Every failure refuses the
  // launch BEFORE any session exists - a relay without a pin would mean B
  // ambient-TOFUing D, which is the one posture the design refuses.
  let hostPin: string;
  try {
    hostPin = (
      await ensureDestinationPin({ ownerUserId: args.viewerId, aNodeId: args.aNode.id, destination: args.destination })
    ).line;
  } catch (err) {
    if (err instanceof SshHostPinError) return refused(hostPinRefusal(err));
    throw err;
  }
  const broker = grantsDeps().broker();
  let socketPath: string;
  try {
    const opened = await broker.openRelay({
      grantId: grant.id,
      fingerprints: grant.fingerprints,
      paneId: args.paneId,
      aNode: args.aNode.id,
      bNode: args.bNodeId,
      aPeer,
      bPeer,
      hostPin,
    });
    socketPath = opened.socketPath;
  } catch (err) {
    if (err instanceof SshRelayRefusal) {
      return refused({
        status: 409,
        code: BackendErrorCodes.SSH_RELAY_OPEN_FAILED,
        message: relayRefusalCopy(err.code),
      });
    }
    throw err;
  }
  // Liveness immediately AFTER the open (decision 3): a revoke that landed
  // between the reads found an empty session map and cut nothing, so THIS
  // call cuts the fresh session itself and the launch refuses.
  if (!(await repo.getGrant(args.viewerId, grant.id))) {
    await broker.closeForGrant(grant.id, "grant-revoked");
    return refused(GRANT_REVOKED_DURING_LAUNCH);
  }
  return granted({ socketPath, grantId: grant.id });
}

const GRANT_REVOKED_DURING_LAUNCH: SshRefusalNarrow = {
  status: 409,
  code: BackendErrorCodes.SSH_GRANT_APPROVAL_REQUIRED,
  message: "The key grant was revoked while this launch was opening. Launch again to ask for approval.",
};

/** Human copy per broker refusal code; ids only, never key material or sockets. */
function relayRefusalCopy(code: SshRelayRefusal["code"]): string {
  switch (code) {
    case "quota":
      return "That machine already carries its full share of live relay sessions. Wait for one to close and retry.";
    case "handshake":
      return "The key home or the connecting machine did not complete the relay handshake. Check both machines are online and retry.";
    case "node-off":
      return "SSH was switched off on one of the machines between the gate and the relay open.";
    case "no-node":
    case "no-datadir":
      return "One of the machines is not fully connected; retry once it reports in.";
    case "local-node":
      return "The server host itself can be neither key home nor connecting machine for a relay.";
    case "same-node":
      return "The key home and the connecting machine are the same machine; this connection needs no relay.";
    case "bad-socket-path":
      return "The connecting machine answered a socket path the server could not verify. Nothing was launched.";
    case "bad-pane-id":
    case "bad-fingerprints":
      return "The relay refused the session's identifiers as malformed; the launch was refused.";
    case "bad-host-pin":
      return "The relay refused the destination host pin as malformed; the launch was refused.";
  }
}

/* ------------------------------------------------------------------ */
/* selection validation shared by approve and create                   */
/* ------------------------------------------------------------------ */

type SelectionResult = { ok: true; value: string[] } | { ok: false; answer: SshGrantAnswer<never> };

async function validateSelectionOf(fingerprints: readonly string[]): Promise<SelectionResult> {
  if (!Array.isArray(fingerprints) || fingerprints.some((f) => typeof f !== "string"))
    return { ok: false, answer: refused(invalidRefusal()) };
  const unique = [...new Set(fingerprints)];
  if (unique.length > SSH_MAX_GRANT_FINGERPRINTS) return { ok: false, answer: refused(overRefusal()) };
  if (!isSshGrantFingerprints(unique)) return { ok: false, answer: refused(invalidRefusal()) };
  return { ok: true, value: unique };
}

function overRefusal(): SshRefusalNarrow {
  return {
    status: 400,
    code: BackendErrorCodes.SSH_GRANT_KEYS_OVER_LIMIT,
    message: `A grant can carry at most ${SSH_MAX_GRANT_FINGERPRINTS} keys. Deselect some and try again; nothing was truncated.`,
  };
}

function invalidRefusal(): SshRefusalNarrow {
  return {
    status: 400,
    code: BackendErrorCodes.SSH_GRANT_KEYS_INVALID,
    message: "Every selected key must be a SHA256 fingerprint exactly as the roster reports it.",
  };
}
