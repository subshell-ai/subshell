import { rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import {
  buildSshConfigPath,
  buildSshKnownHostsPath,
  discoverSshAliases,
  findBinary,
  getHarness,
  renderSshConfigContents,
  resolveSshAliasConfig,
  sshDestinationToken,
  sshOptionTokens,
} from "@internal/pane-runtime";
import {
  type NodeSshAgentIdentity,
  type NodeSshAliasListResult,
  type NodeSshResolveOutcomeWire,
  parseNodeSshAliasList,
  parseSshConnectionSnapshot,
  SSH_NAME_MAX_CHARS,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SshSavedHostsRepository } from "@/db/repositories/ssh-saved-hosts.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import type { SshSavedHostTable } from "@/db/types/ssh-saved-hosts.db-types.js";
import { sshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { SshRpcError, sshAgentIdentities, sshDiscover, sshResolve } from "@/services/nodes/ssh-rpc.js";
import { subshellSshConfigPath } from "@/services/nodes/subshell-paths.js";
import { gateSshNode } from "@/services/ssh-policy.service.js";
import { prepareRelayLeg } from "@/services/ssh-relay-launch.service.js";

export { gateSshNode } from "@/services/ssh-policy.service.js";

import { closeRelayForPaneExit, sshRelayPaneEnv } from "@/services/ssh-relay.service.js";
import type { SubshellsService } from "@/services/subshells.service.js";
import { logger } from "@/utils/logger.js";

/**
 * The SSH launcher surface (spec 2026-10-07 §5/§7, plan 2 Task 7): the gate,
 * the resolve trip, the compose, the launch, the ledger, the audit.
 *
 * **Responsibilities in order, each pinned by `api/ssh/__tests__/ssh-routes.test.ts`:**
 * 1. GATE: the central SSH policy answers from the plane's row and the caller's
 *    access BEFORE any `sendCommand` — the predicate says yes/no, this file
 *    names the cause in the message (spec §12); the code is one
 *    `SSH_GATE_OFF` for both causes. A held agent node is refused with the
 *    update remedy before any resolve (a held socket answers nothing but
 *    `update`, and a launch aimed at it is a frame the agent will never see).
 * 2. The destination is validated with the wire grammar's own alias rule
 *    BEFORE the machine is asked; discovery answers and hand-typed tokens
 *    take the SAME resolve path (`ssh_resolve_config`), so nothing composes a
 *    snapshot the resolver did not approve.
 * 3. The refusal shape splits by endpoint, per the frozen doctrine: `resolve`
 *    answers a refusal outcome IN THE DATA (200, a fact the human reads);
 *    `launch` and `saved-hosts PUT` refuse it (422 `{outcome}`), because
 *    acting on an unapproved destination is the act they are.
 * 4. Compose happens only against a snapshot re-validated by
 *    `parseSshConnectionSnapshot` at THIS trust boundary (the RPC validator
 *    already ran; the renderer's own entry check is the third copy — the
 *    tier-1 grammar doc names re-validation at each boundary the
 *    load-bearing defense, not the plane's approval).
 * 5. The audit `ssh.launch` lands AFTER a successful launch, never before —
 *    the same posture as `subshell.create`, which the manager records only
 *    once the spawn returned. A refused resolve, a thrown create, an offline
 *    machine: the trail stays silent about the act that did not happen.
 *    Saved-host CRUD audits nothing (the prompts precedent: a preference row
 *    is not an event).
 */

/** The refusal union the routes render verbatim (a returned `status()` body, never a thrown). */
export type SshRefusal =
  | { status: 400 | 403 | 404 | 409 | 502; code: BackendErrorCodes; message: string }
  | { status: 422; outcome: Extract<NodeSshResolveOutcomeWire, { accepted: false }> };

/** The service answer shape: a value, or the refusal the route returns as-is. */
export type SshAnswer<T> = { ok: true; value: T } | { ok: false; refusal: SshRefusal };

function ok<T>(value: T): SshAnswer<T> {
  return { ok: true, value };
}

function codedRefusal(status: 400 | 403 | 404 | 409 | 502, code: BackendErrorCodes, message: string): SshAnswer<never> {
  return { ok: false, refusal: { status, code, message } };
}

function refusedRefusal(outcome: Extract<NodeSshResolveOutcomeWire, { accepted: false }>): SshAnswer<never> {
  return { ok: false, refusal: { status: 422, outcome } };
}

/**
 * The destination as the wire grammar reads an alias (ssh-frames.ts
 * `isAliasName`, same numbers): 1..{@link SSH_NAME_MAX_CHARS}, no leading
 * `-`, no whitespace or control characters. Discovery answers and manual
 * tokens take this SAME path before any machine is asked — the tier-1
 * injection posture, applied at the surface rather than trusted to the
 * renderer's last-station check.
 */
export function isWireSafeSshDestination(value: string): boolean {
  return value.length > 0 && value.length <= SSH_NAME_MAX_CHARS && !value.startsWith("-") && !/\s|\p{Cc}/u.test(value);
}

/**
 * Everything the ssh launch needs, composed from an APPROVED snapshot, the
 * target machine's dataDir, and the new pane's id (spec 2026-10-07 decision
 * 4: the path is DERIVED from the two facts each end already holds). The
 * derived path rides the launch frame's ssh member, but only as a CLAIM the
 * other end never trusts: `apps/node/agent/src/commands/launch.ts` re-derives
 * it from its own dataDir and the pane id and refuses unless the frame's
 * `configPath` is byte-equal (the LocalLauncher byte-checks in-process), so
 * naming the path on the wire grants no write the machine did not choose.
 * Handoff 4's exact tail: every option token, then `--`,
 * then the bare host; `SSH_AUTH_SOCK` joins the pane env only when the
 * snapshot names a socket (decision 3's scoped exception).
 *
 * Throws (an impossible-state guard, never a user path) when the snapshot
 * fails the grammar re-check at this boundary, or the id is outside the
 * path-composition guard.
 */
export function composeSshLaunch(args: {
  snapshot: SshConnectionSnapshotWire;
  targetDataDir: string;
  subshellId: string;
  /**
   * The relay session's pinned host-key file path (Task 12, spec 2026-10-08
   * §9). PRESENT is the relay mode: the rendered config forces
   * `StrictHostKeyChecking yes` and names this one file as the ONLY trust
   * source - the pane's ssh verifies D against A's recorded key, never
   * against B's ambient known_hosts. ABSENT is the M1 direct launch: the
   * accept-new posture, byte-for-byte. The path is `buildSshKnownHostsPath`
   * of the SAME two facts the config path derives from; B writes the pin
   * delivered on the signed relay-open to its own derivation of them.
   */
  hostPinPath?: string;
}): {
  configPath: string;
  fileContent: string;
  presetFlags: string[];
  extraPaneEnv?: Record<string, string>;
} {
  const approved = parseSshConnectionSnapshot(args.snapshot);
  if (approved === null) throw new Error("ssh compose: snapshot failed grammar re-validation");
  const configPath = buildSshConfigPath(args.targetDataDir, args.subshellId);
  const fileContent = renderSshConfigContents(
    approved,
    args.hostPinPath === undefined ? undefined : { hostPinPath: args.hostPinPath },
  );
  const presetFlags = [...sshOptionTokens(approved, configPath), "--", sshDestinationToken(approved)];
  return approved.authAgentSocket === null
    ? { configPath, fileContent, presetFlags }
    : { configPath, fileContent, presetFlags, extraPaneEnv: { SSH_AUTH_SOCK: approved.authAgentSocket } };
}

/** Relay trust currently pins one canonical destination, not jump hosts or host-key aliases. */
export function relaySnapshotRefusal(snapshot: SshConnectionSnapshotWire): SshAnswer<never> | null {
  const settings: string[] = [];
  if (snapshot.proxyJumps.length > 0) settings.push("ProxyJump");
  if (snapshot.hostKeyAlias !== null) settings.push("HostKeyAlias");
  if (settings.length === 0) return null;
  return codedRefusal(
    409,
    BackendErrorCodes.SSH_RELAY_OPEN_FAILED,
    `Using SSH keys from another machine does not yet support ${settings.join(" or ")}. Use keys on the connecting machine, or choose a destination without these settings.`,
  );
}

/* ------------------------------------------------------------------ */
/* config lifecycle: the LOCAL sweep, ONE function for every teardown  */
/* point (spec 2026-10-07 decision 4; plan-2 handoff 2)                */
/* ------------------------------------------------------------------ */

/**
 * Best-effort `rm -rf` of the per-pane ssh config dir a LOCAL ssh pane wrote
 * on this disk: `<SUBSHELL_SERVER_DATA_DIR>/ssh/<id>` — the dirname of the
 * byte-derived config path the LocalLauncher wrote into. ONE function, called
 * from every site where such a pane stops existing, so no copy can drift:
 *
 * - the shared death transition (the manager's `#applyDeath`), the DETERMINISTIC
 *   driver: the 60 s reconcile reaches it whenever the process is gone, so a
 *   lost `pane-died` hook can no longer leave the dir behind (e2e spec 22's
 *   intermittent miss);
 * - the pane's own death report (the service's `reportExit`), which fires even
 *   when the row is already retired: a terminate kills the pane, the tmux
 *   `pane-died` hook races the retire stamp, and whichever order they land in
 *   the config must be gone once the report has been heard;
 * - the create rollback: a LOCAL ssh launch that wrote its config then threw
 *   past the spawn retires the row here, and the half-built dir must go with it;
 * - the terminate verb, AFTER the kill: terminate revokes the pane's token
 *   synchronously with the kill, so the dying hook's report can arrive 401
 *   and run no sweep at all (e2e spec 22) — the hand that kills must also
 *   remove the dir;
 * - the maintenance kill (the manager's `terminateForMaintenance`), which
 *   reaches the manager's own kill directly, never passing through the
 *   service verb above: without its own sweep a maintenance window left
 *   every local ssh config dir behind;
 * - the delete path: the row is gone before the sweep could ever ride the
 *   exit hook, and the artifacts list must not carry the config path either,
 *   because removing the file and leaving the DIR behind is not a removal.
 *
 * The guard is the row's OWN facts (`local` node ∧ the snapshot column,
 * migration 0048) applied HERE, once, so callers hand over the row they
 * already hold unconditionally. Agent rows are skipped by rule, not by
 * accident — their config lives on the NODE's disk and the agent's own exit
 * watcher unlinks it; removing a directory named after a remote pane off THIS
 * server would be this host deleting a file that is not its (the delete
 * path's per-node launcher doctrine, same reason).
 *
 * Best-effort by shape: any failure (missing dir, an id outside the path
 * guard, a refusing filesystem) costs one log line and nothing else — the
 * teardown must land regardless, and a stale config in a dir whose name is a
 * dead pane's id is garbage, not a hazard.
 */
export function sweepLocalSshDir(row: Pick<SubshellTable, "id" | "nodeId" | "ssh"> | null | undefined): void {
  if (!row || row.nodeId !== LOCAL_NODE_ID || row.ssh === null) return;
  try {
    rmSync(dirname(subshellSshConfigPath(row.id)), { recursive: true, force: true });
  } catch (err) {
    logger.withError(err).warn(`ssh config sweep failed for local pane ${row.id}`);
  }
}

/* ------------------------------------------------------------------ */
/* the gate (spec §4.3: the plane's row, then the held check, BEFORE   */
/* any command; naming WHY is this surface's copy, per §12)            */
/* ------------------------------------------------------------------ */

/**
 * The machine refused or could not answer; the code family, never the
 * agent's own text. Exported for the §7 setup-here act, whose ssh_exec RPCs
 * must map failures through the SAME doors (spec §12's naming doctrine: one
 * cause, one sentence, wherever it was reached).
 */
export function rpcRefusal(err: SshRpcError): SshAnswer<never> {
  if (err.kind === "offline") {
    return codedRefusal(
      409,
      BackendErrorCodes.NODE_OFFLINE,
      "That machine has no live connection right now; bring its Subshell app online and retry.",
    );
  }
  if (err.kind === "unsupported") {
    return codedRefusal(
      409,
      BackendErrorCodes.NODE_OUTDATED,
      "The Subshell app on that machine is too old to speak SSH. Update it from its machine page.",
    );
  }
  if (err.kind === "timeout") {
    return codedRefusal(
      409,
      BackendErrorCodes.NODE_UNREACHABLE,
      "That machine did not answer the SSH request in time; check its connection and retry.",
    );
  }
  // refused / malformed: the machine's own answer (`ssh disabled on this
  // node`, no ssh binary, a payload that failed the frozen validator). Its
  // verbatim text goes to the LOG, never to the response (the
  // files-remote-browse posture: agent refusal strings are not client API).
  logger.withError(err).warn(`ssh rpc ${err.kind} failed against node ${err.nodeId}: ${err.detail ?? err.message}`);
  return codedRefusal(
    502,
    BackendErrorCodes.SSH_NODE_REFUSED,
    err.nodeId === "local"
      ? "The server service account could not use SSH. Ensure ssh is installed and that this service has an absolute SSH_AUTH_SOCK pointing to its running SSH agent. Keys in another login session are not automatically available to the service."
      : "The connecting machine refused the SSH request. Check that SSH is switched on there and that ssh is installed.",
  );
}

/* ------------------------------------------------------------------ */
/* transports: the agent answers over the signed RPC; `local` runs    */
/* the SAME pane-runtime engines in-process (no agent socket exists — */
/* ssh-frames.ts spells the commands transport-agnostic for exactly   */
/* this, and the server account's gate is the DB row, not a mirror).  */
/* ------------------------------------------------------------------ */

async function nodeAliases(row: NodeTable): Promise<SshAnswer<NodeSshAliasListResult>> {
  if (row.kind === "local") {
    const found = parseNodeSshAliasList(discoverSshAliases({ homeDir: osHomedir() }));
    if (!found) {
      // Unreachable by construction (the discovery engine is OURS); refuse
      // loudly rather than pass anything the wire validator rejected.
      return codedRefusal(502, BackendErrorCodes.SSH_NODE_REFUSED, "This host could not produce its alias list.");
    }
    return ok(found);
  }
  try {
    return ok(await sshDiscover(row.id));
  } catch (err) {
    if (err instanceof SshRpcError) return rpcRefusal(err);
    throw err;
  }
}

async function nodeResolve(row: NodeTable, destination: string): Promise<SshAnswer<NodeSshResolveOutcomeWire>> {
  if (row.kind === "local") {
    // The same ladder the agent runs (decision 2: the rule travels, the path
    // is the machine's own) — for `local`, this process IS the machine.
    const spec = getHarness("ssh")?.detectSpec;
    const sshBin = spec ? await findBinary(spec.binaryName, spec.envOverride, spec.knownPaths) : null;
    if (sshBin === null) {
      return codedRefusal(
        502,
        BackendErrorCodes.SSH_NODE_REFUSED,
        "This host has no ssh binary installed, so it cannot resolve a destination.",
      );
    }
    return ok(await resolveSshAliasConfig(destination, { sshBin, homeDir: osHomedir() }));
  }
  try {
    return ok(await sshResolve(row.id, destination));
  } catch (err) {
    if (err instanceof SshRpcError) return rpcRefusal(err);
    throw err;
  }
}

/** The node's dataDir at the compose instant, or null (the offline class). Exported with the gate. */
export function targetDataDir(row: NodeTable): string | null {
  // local: the server's own dir (LocalLauncher byte-checks this exact
  // derivation); agent: the ready-reported `dataDir`, which the AGENT
  // re-derives from itself and refuses a byte-mismatch on.
  return row.kind === "local" ? SUBSHELL_SERVER_DATA_DIR : (getLive(row.id)?.agent?.dataDir ?? null);
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

/** `GET /api/ssh/aliases` — the machine's usable alias names (gate, then the transport). */
export async function sshListAliases(viewerId: string, nodeId: string): Promise<SshAnswer<NodeSshAliasListResult>> {
  const gate = await gateSshNode(viewerId, nodeId);
  if (!gate.ok) return gate;
  return await nodeAliases(gate.value.row);
}

/**
 * `POST /api/ssh/resolve` — the destination's outcome. A refusal rides IN THE
 * DATA (200): which setting blocked is a fact the human reads, not a failure
 * of this request.
 */
export async function sshResolveDestination(
  viewerId: string,
  nodeId: string,
  destination: string,
): Promise<SshAnswer<NodeSshResolveOutcomeWire>> {
  const gate = await gateSshNode(viewerId, nodeId);
  if (!gate.ok) return gate;
  if (!isWireSafeSshDestination(destination)) {
    return codedRefusal(400, BackendErrorCodes.ALIAS_UNSAFE, UNSAFE_DESTINATION_COPY);
  }
  return await nodeResolve(gate.value.row, destination);
}

const UNSAFE_DESTINATION_COPY =
  "That destination is not a token ssh can be given safely: no leading dash, no whitespace or control characters, at most 253 characters.";

/**
 * `POST /api/ssh/launch` — gate, resolve, compose, launch, ledger, audit.
 * The pane arrives through the ordinary create path (`harnessId: "ssh"`,
 * presetless: `presetFlags` CARRY the launch, the working directory gets the
 * launch node's home by the spec-2026-10-01 terminal default), and the ssh
 * member + snapshot ride the plumbing this task added to `createSubshell`.
 * `restartOnExit` inherits the preset — a presetless launch inherits nothing
 * (0): ssh panes are forced off auto-restart by construction, decision 7's
 * other half.
 */
export async function sshLaunch(args: {
  viewerId: string;
  nodeId: string;
  destination: string;
  name?: string;
  /** Optional key machine; current launch access on both machines authorizes relay use. */
  keyHomeNodeId?: string;
  fingerprints?: readonly string[];
  /** The REQUEST-scoped subshells service (the create path is its own). */
  subshells: Pick<SubshellsService, "createSubshell">;
}): Promise<SshAnswer<{ subshellId: string }>> {
  const gate = await gateSshNode(args.viewerId, args.nodeId);
  if (!gate.ok) return gate;
  const row = gate.value.row;
  if (!isWireSafeSshDestination(args.destination)) {
    return codedRefusal(400, BackendErrorCodes.ALIAS_UNSAFE, UNSAFE_DESTINATION_COPY);
  }
  if (args.fingerprints !== undefined && args.keyHomeNodeId === undefined) {
    return codedRefusal(400, BackendErrorCodes.SSH_KEYS_INVALID, "Choose a key home before selecting SSH keys.");
  }
  // Explicit own-machine key homes use the direct account path. A supplied subset cannot be broadened.
  if (args.keyHomeNodeId === row.id) {
    if (args.fingerprints !== undefined)
      return codedRefusal(
        400,
        BackendErrorCodes.SSH_KEYS_INVALID,
        "Use this machine's own keys without a key selection, or choose a different key machine to select a subset.",
      );
    args = { ...args, keyHomeNodeId: undefined };
  }
  const resolved = await nodeResolve(row, args.destination);
  if (!resolved.ok) return resolved;
  if (!resolved.value.accepted) return refusedRefusal(resolved.value);
  const snapshot = resolved.value.snapshot; // parseNodeSshResolveOutcome already narrowed + rebuilt it
  if (args.keyHomeNodeId !== undefined) {
    const refusal = relaySnapshotRefusal(snapshot);
    if (refusal) return refusal;
  }
  const dataDir = targetDataDir(row);
  if (dataDir === null) {
    // Between the resolve and here the machine dropped, or it connected
    // without reporting `ready` facts yet — there is no dataDir to derive a
    // path from, so nothing was composed or spawned.
    return codedRefusal(
      409,
      BackendErrorCodes.NODE_OFFLINE,
      "That machine has not reported its data directory yet; retry once it is fully connected.",
    );
  }
  const subshellId = crypto.randomUUID();
  // Open the relay before creating the pane. Access, the selected live keys,
  // destination trust and both relay endpoints must all succeed first.
  let relay: { socketPath: string; ref: string; fingerprints: string[] } | null = null;
  if (args.keyHomeNodeId !== undefined) {
    const gateA = await gateSshNode(args.viewerId, args.keyHomeNodeId);
    if (!gateA.ok) return gateA;
    const aRow = gateA.value.row;
    const leg = await prepareRelayLeg({
      viewerId: args.viewerId,
      aNode: { id: aRow.id, name: aRow.name },
      bNodeId: row.id,
      fingerprints: args.fingerprints,
      // The canonical triple the pin is keyed by, from the SAME validated
      // snapshot that the connecting machine resolved.
      destination: sshCanonicalDestination({ host: snapshot.host, port: snapshot.port, user: snapshot.user }),
      paneId: subshellId,
    });
    if (!leg.ok) return leg;
    relay = leg.value;
  }
  const composed = composeSshLaunch({
    snapshot,
    targetDataDir: dataDir,
    subshellId,
    // Relay mode (Task 12): the config pins B's trust source to the file the
    // signed relay-open just wrote beside it; a direct launch renders the M1
    // accept-new bytes untouched.
    ...(relay ? { hostPinPath: buildSshKnownHostsPath(dataDir, subshellId) } : {}),
  });
  // Relay mode RE-POINTS the scoped exception (spec §5.2): the socket the
  // pane's ssh authenticates through is B's proxy the broker just verified,
  // never the snapshot's agent socket even if the config names one. Still
  // one key, still the ssh invocation only, still never the whole-pane env.
  if (relay) composed.extraPaneEnv = sshRelayPaneEnv(relay.socketPath);
  // The create can still refuse (node switched off, harness gone, a
  // lockdown, a maintenance window) — those ride the global error handler
  // with their own codes. They land here, AFTER the resolve: the honest
  // order, since this act's gate (SSH use) is strictly narrower than the
  // launch's and every refusal below writes no pane.
  let created;
  try {
    created = await args.subshells.createSubshell({
      userId: args.viewerId,
      harnessId: "ssh",
      presetId: null,
      // The presetless-terminal default (spec 2026-10-01 §2): the launch node's
      // home, resolved by the create path itself - exactly what the wizard's
      // "connect from this machine" journey wants as the pane's starting cwd.
      workingDir: undefined,
      name: args.name,
      nodeId: row.id,
      machineActor: false, // the routes are cookie-only (requireCookieActor)
      crossAgent: false,
      subshellId,
      ssh: {
        configPath: composed.configPath,
        fileContent: composed.fileContent,
        snapshot,
        // Preserve the actual selected keys, including the complete roster
        // resolved for callers that omitted selection. Later acts cannot widen it.
        ...(relay ? { keyHomeNodeId: args.keyHomeNodeId as string, relayFingerprints: relay.fingerprints } : {}),
      },
      presetFlags: composed.presetFlags,
      ...(composed.extraPaneEnv ? { extraPaneEnv: composed.extraPaneEnv } : {}),
    });
  } catch (err) {
    // A session was opened under a pane id that will never have a child:
    // the child-exit word is the honest cut (the process is gone at t=0),
    // and the sweep is the same best-effort helper every death site uses.
    // The refusal the caller sees is the create's own, untouched.
    if (relay) closeRelayForPaneExit(subshellId);
    throw err;
  }
  // Recency FIRST (a bookkeeping refresh the human already sees as part of the
  // launch), then the audit — both AFTER the pane exists. The ledger is
  // best-effort (a failed touch must not turn a live pane into an error, the
  // recentPaths posture); the audit sink never throws by contract.
  const destination = sshCanonicalDestination({ host: snapshot.host, port: snapshot.port, user: snapshot.user });
  const now = new Date().toISOString();
  await new SshSavedHostsRepository(db)
    .touch({ ownerUserId: args.viewerId, destination, nodeId: row.id, alias: snapshot.alias, at: now })
    .catch((err: unknown) => {
      logger.withError(err).warn(`ssh saved-hosts recency touch failed for ${args.viewerId}/${destination}`);
    });
  // Success-only, matching the manager's own `subshell.create` posture (which
  // is recorded after the spawn returned): a refusal writes nothing to that
  // trail, and an act that failed to spawn is not an event.
  await audit({
    actorUserId: args.viewerId,
    action: "ssh.launch",
    targetType: "node",
    targetId: row.id,
    // Only session ids and destination metadata enter the success audit.
    metadataJson: JSON.stringify(
      relay
        ? { nodeId: row.id, destination, subshellId: created.id, relayRef: relay.ref }
        : { nodeId: row.id, destination, subshellId: created.id },
    ),
  });
  return ok({ subshellId: created.id });
}

/**
 * `PUT /api/ssh/saved-hosts` — save a destination: the SAME gate + resolve
 * (the canonical key must come from a validated snapshot's fields, handoff
 * 1), refusal-shaped outcomes refuse with 422 exactly as a launch would.
 * Unaudited (prompts precedent: this is a preference row, not an event).
 */
export async function sshSaveHost(args: {
  viewerId: string;
  nodeId: string;
  destination: string;
  /** Explicit display token; absent falls back to the snapshot's alias. */
  alias?: string;
}): Promise<SshAnswer<SshSavedHostTable>> {
  const gate = await gateSshNode(args.viewerId, args.nodeId);
  if (!gate.ok) return gate;
  if (!isWireSafeSshDestination(args.destination)) {
    return codedRefusal(400, BackendErrorCodes.ALIAS_UNSAFE, UNSAFE_DESTINATION_COPY);
  }
  const resolved = await nodeResolve(gate.value.row, args.destination);
  if (!resolved.ok) return resolved;
  if (!resolved.value.accepted) return refusedRefusal(resolved.value);
  const snapshot = resolved.value.snapshot;
  const row = await new SshSavedHostsRepository(db).markSaved({
    ownerUserId: args.viewerId,
    destination: sshCanonicalDestination({ host: snapshot.host, port: snapshot.port, user: snapshot.user }),
    nodeId: gate.value.row.id,
    alias: args.alias ?? snapshot.alias,
    at: new Date().toISOString(),
  });
  return ok(row);
}

/** `DELETE /api/ssh/saved-hosts/:id` — false for foreign AND absent (one 404). */
export async function sshRemoveSavedHost(viewerId: string, id: string): Promise<boolean> {
  return await new SshSavedHostsRepository(db).remove(viewerId, id);
}

/** The public key roster, gated exactly like discovery, resolve and launch. */
export async function listNodeAgentIdentities(args: {
  viewerId: string;
  aNodeId: string;
}): Promise<SshAnswer<{ identities: NodeSshAgentIdentity[] }>> {
  const gate = await gateSshNode(args.viewerId, args.aNodeId);
  if (!gate.ok) return gate;
  try {
    return ok(await sshAgentIdentities(args.aNodeId));
  } catch (err) {
    if (err instanceof SshRpcError) return rpcRefusal(err);
    throw err;
  }
}

/** The GET payload of the launcher screen: the owner's rows plus their default machine. */
export async function sshSavedHostsView(viewerId: string): Promise<{
  saved: SshSavedHostTable[];
  recent: SshSavedHostTable[];
  defaultNodeId: string | null;
}> {
  const repo = new SshSavedHostsRepository(db);
  const [saved, recent, defaultNodeId] = await Promise.all([
    repo.listSaved(viewerId),
    repo.listRecent(viewerId),
    getSshDefaultNode(viewerId),
  ]);
  return { saved, recent, defaultNodeId };
}

/* ------------------------------------------------------------------ */
/* preferences: the default connecting machine, a per-user setting     */
/* ------------------------------------------------------------------ */

/**
 * The preference lives in the instance `settings` table under a per-user
 * NAMESPACED key because that is the only JSON key/value store this schema
 * has and a migration for one string was not on Task 7's map: `user_meta`
 * columns each need their own migration, and 0048 (the ledger + the snapshot
 * column) was frozen before preferences were wired. The namespace keeps two
 * users' defaults from sharing a row; nothing renders `settings` rows raw, so
 * the key shape is storage detail, not API surface.
 */
const sshDefaultNodeKey = (userId: string): string => `ssh.defaultNode:${userId}`;

export async function getSshDefaultNode(userId: string): Promise<string | null> {
  return (await new SettingsRepository(db).get<string | null>(sshDefaultNodeKey(userId), null)) ?? null;
}

/**
 * `PATCH /api/ssh/preferences`. The WRITE validates the node exists and is
 * visible to the caller (404 otherwise — the ordinary invisibility, never a
 * "you may not" leak). The READ path (above) deliberately returns the stored
 * id WITHOUT a visibility read: a node deleted under a saved default must not
 * silently clear a preference the human chose, and a preference that
 * re-validates on every page load would make the launcher's first GET
 * machine-visibility-coupled; the SPA resolves the id against its node list
 * and decides what to show.
 */
export async function sshSetDefaultNode(viewerId: string, nodeId: string | null): Promise<SshAnswer<string | null>> {
  if (nodeId !== null) {
    const gate = await loadNodeGate(viewerId, nodeId);
    if (!gate) return codedRefusal(404, BackendErrorCodes.NOT_FOUND_ERROR, "Node not found");
  }
  await new SettingsRepository(db).set(sshDefaultNodeKey(viewerId), nodeId);
  return ok(nodeId);
}
