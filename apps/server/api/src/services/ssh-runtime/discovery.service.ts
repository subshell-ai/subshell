import { homedir } from "node:os";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { defaultSshConfigPath, discoverSshAliases, findBinary, resolveSshAliasConfig } from "@internal/pane-runtime";
import {
  isSshErrorCode,
  type NodeSshAliasListResult,
  type NodeSshResolveOutcomeWire,
  parseNodeSshAliasList,
  parseNodeSshResolveOutcome,
  parseSshConnectionSnapshot,
  SSH_ERROR_DESCRIPTIONS,
  SSH_FORBIDDEN_SNAPSHOT_FIELDS,
  SSH_PROBE_DEADLINE_MS,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import { logger } from "@/utils/logger.js";
import type { SshCaller } from "./ssh-actor.js";

/**
 * The two pre-session SSH reads the Connect-over-SSH wizard needs, re-homed
 * here by Workstream C's retirement of the old destination-execution product
 * (design 2026-10-05 §7: the doors retire, the live seams move). Everything
 * the retired `ssh-connections.service` pair did is kept with the SAME
 * semantics: the human-only cookie gate, the one node-eligibility
 * implementation, the node verbs over the signed link, the `local` in-process
 * twin, the frozen-grammar re-validation of an accepted snapshot, the
 * `ssh.discover` / `ssh.resolve` audit rows, and the named-code refusals.
 *
 * What did NOT move is what died with the product: connections, grants,
 * runs, terminals, the fixed test probe, and the policy's pane arms. The
 * eligibility gate keeps only the arm these reads asked (`dispatch_rpc`):
 * ownership facts AND a machine able to answer a short RPC now.
 *
 * Canonical-form strictness still lives HERE at the review gate: an accepted
 * resolve outcome is run through the protocol's `parseSshConnectionSnapshot`
 * before it is shown, so the human never reviews a destination the open
 * would refuse (a resolver bug meets the same parser as every later use).
 */

const nodes = new NodesRepository(db);

/* ------------------------------------------------------------------ */
/* the eligibility decision (the retired policy's shape, three arms)   */
/* ------------------------------------------------------------------ */

/** The named refusal set this surface can answer (frozen spellings, unchanged). */
export type SshGateCode = "cookie_required" | "not_found" | "node_ineligible";

/** The decision the cookie gate and the node gate return, in the retired policy's shape. */
export type SshDecision =
  | { allow: true }
  | {
      allow: false;
      code: SshGateCode;
      /** Wire-level elaboration (display metadata only; never config contents or secrets). */
      detail?: SshErrorCode;
    };

/** The one sentence per code; the remedy's LOCATION, never a diagnosis of hidden state. */
const GATE_SENTENCES: Record<SshGateCode, string> = {
  cookie_required: "SSH configuration acts require a signed-in human session, not a machine credential.",
  not_found: "Not found.",
  node_ineligible: "The connecting node is offline, in maintenance, or otherwise not taking SSH work right now.",
};

/** Throw the route-visible error for a refused decision (the retired refusal module's exact shape). */
function refuseSshDecision(decision: Extract<SshDecision, { allow: false }>): never {
  const { code, detail } = decision;
  throwApiError({
    code: code === "not_found" ? BackendErrorCodes.NOT_FOUND_ERROR : BackendErrorCodes.ACCESS_DENIED,
    message: GATE_SENTENCES[code],
    doNotLog: true,
    // The named code ALWAYS rides (the surface contract: equality over
    // parsing a sentence); `detail` elaborates when the decision carried one.
    metadataSafe: { sshCode: code, ...(detail === undefined ? {} : { detail }) },
  });
}

/**
 * Throw for a named {@link SshErrorCode}: a config-grammar refusal from the
 * server's own validation (or a node code the transport relayed). The
 * sentence is the protocol's own shipped description; the code rides the
 * metadata for equality mapping. The durable-dispatch pair keeps the 409
 * spelling (a state to wait out), everything else the 403.
 */
function refuseSshErrorCode(code: SshErrorCode, extra?: string): never {
  throwApiError({
    code:
      code === "run_conflict" || code === "run_unknown"
        ? BackendErrorCodes.EXISTS_ERROR
        : BackendErrorCodes.ACCESS_DENIED,
    message: extra === undefined ? SSH_ERROR_DESCRIPTIONS[code] : `${SSH_ERROR_DESCRIPTIONS[code]} (${extra})`,
    doNotLog: true,
    metadataSafe: { sshCode: code },
  });
}

/* ------------------------------------------------------------------ */
/* the node-eligibility seam (sshNodeGate's live posture, moved)       */
/* ------------------------------------------------------------------ */

/**
 * The node-eligibility question the two wizard reads ask: ownership facts
 * AND the machine able to answer a short RPC now. ONE implementation (the
 * retired policy's rule 2: a local copy of a named check is the drift);
 * `allow` means the arm's named facts are ALL confirmed - anything else
 * refuses.
 *
 * - Only the node OWNER may drive discovery on an enrolled agent (admin
 *   status does NOT reach it); a foreign row is `not_found`, the usual
 *   non-enumerating convention.
 * - Not in maintenance, and a LIVE agent socket. Refused agents are HELD,
 *   never live, so a held node takes no SSH work - the existing posture.
 * - The built-in `local` node answers to an ADMIN cookie subject to its
 *   maintenance flag and the launch-enabled rule (`allow_server_subshells`,
 *   read live like the launch path reads it), and has no link to be down
 *   (it runs in-process). The wizard's node picker only offers owned agent
 *   machines; the arm is kept verbatim so the move changes no semantics.
 */
async function sshNodeGate(caller: SshCaller, nodeId: string): Promise<SshDecision> {
  const row = await nodes.findById(nodeId);
  if (!row) return { allow: false, code: "not_found" };
  if (row.kind === "local") {
    if (caller.actor === "cookie" && !caller.isAdmin) return { allow: false, code: "not_found" };
    if (!(await serverSubshellsEnabled(db))) return { allow: false, code: "node_ineligible" };
  } else if (row.ownerUserId !== caller.userId) {
    return { allow: false, code: "not_found" };
  }
  if (row.maintenance === 1) return { allow: false, code: "node_ineligible" };
  if (row.kind !== "local" && !getLive(row.id)) return { allow: false, code: "node_ineligible" };
  return { allow: true };
}

/* ------------------------------------------------------------------ */
/* the node adapter (ssh-node-client's two surviving verbs, moved)     */
/* ------------------------------------------------------------------ */

/**
 * A node refusal the API surface must name: `code` is set when the agent's
 * `result{error}` equals a frozen {@link SshErrorCode} (the equality rule
 * the node maps live by). `transport` marks offline/timeout; `malformed`
 * marks a validator-refused answer (a broken node, reported 5xx-honest,
 * never as the caller's fault).
 */
class SshNodeRefusal extends Error {
  /** The named code when the refusal is one of the frozen set; null for a free-text or transport failure. */
  readonly code: SshErrorCode | null;
  /** True when the node had no live connection or the RPC timed out - the "offline/timeout" family. */
  readonly transport: boolean;
  /** True when the agent ANSWERED but the payload failed the shared parser. */
  readonly malformed: boolean;
  constructor(message: string, code: SshErrorCode | null, opts: { transport?: boolean; malformed?: boolean } = {}) {
    super(message);
    this.name = "SshNodeRefusal";
    this.code = code;
    this.transport = opts.transport ?? false;
    this.malformed = opts.malformed ?? false;
  }
}

/** Per-verb deadlines: discovery is a local bounded parse; resolve carries the probe budget. */
const DISCOVER_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
const RESOLVE_TIMEOUT_MS = SSH_PROBE_DEADLINE_MS;

/** The ssh-binary ladder (the agent's `ssh-shared.ts` twin verbatim: app->app imports are the architecture's wall, so the known-path list is stated twice rather than one app importing the other). */
const SSH_KNOWN_PATHS = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];
const SSH_BINARY_ENV = "SUBSHELL_SSH_PATH";

/** The connecting account's home, exactly how the agent sees its own (HOME, else the OS homedir). */
function connectingHome(): string {
  return process.env.HOME || homedir();
}

/** Ask `ssh_discover_aliases`; the alias-NAMES view, config contents never cross the link. */
async function nodeSshDiscover(nodeId: string): Promise<NodeSshAliasListResult> {
  const data = await call(nodeId, { type: "ssh_discover_aliases" }, DISCOVER_TIMEOUT_MS, "ssh_discover_aliases");
  return requireParsed(parseNodeSshAliasList(data), nodeId, "ssh_discover_aliases");
}

/** Ask `ssh_resolve_config` for one alias; a refusal is IN the data, not a transport error. */
async function nodeSshResolve(nodeId: string, alias: string): Promise<NodeSshResolveOutcomeWire> {
  const data = await call(nodeId, { type: "ssh_resolve_config", alias }, RESOLVE_TIMEOUT_MS, "ssh_resolve_config");
  return requireParsed(parseNodeSshResolveOutcome(data), nodeId, "ssh_resolve_config");
}

/**
 * One command with its deadline; node refusals surface as {@link SshNodeRefusal}.
 *
 * The dispatch seam: a `local` target is always "live" in-process, so its
 * verb is served by {@link dispatchLocalSsh} calling the SAME pane-runtime
 * the agent daemon wraps - no frame, no socket, no signature - and its
 * answer is fed through the IDENTICAL {@link classify} arm a socket answer's
 * `NodeRpcError` takes, so a local refusal maps to the same
 * {@link SshNodeRefusal} the plane already knows how to name.
 */
async function call(
  nodeId: string,
  cmd: { type: "ssh_discover_aliases" } | { type: "ssh_resolve_config"; alias: string },
  timeoutMs: number,
  verb: string,
): Promise<unknown> {
  try {
    if (nodeId === LOCAL_NODE_ID) {
      const result = await dispatchLocalSsh(cmd);
      if (result.ok) return result.data;
      throw new NodeRpcError(
        "failed",
        `node "${LOCAL_NODE_ID}" reported: ${result.error}`,
        LOCAL_NODE_ID,
        result.error,
      );
    }
    return await sendCommand(nodeId, cmd, { timeoutMs });
  } catch (err) {
    if (err instanceof NodeRpcError) throw classify(err, verb);
    throw err;
  }
}

/**
 * The server-hosted node's two SSH verbs (the retired `ssh-local.ts` arms,
 * kept so the `local` door answers exactly as it did). The result mirrors
 * the agent's `CommandResult`: `{ok:true, data}` is the payload a live node
 * would answer (the caller re-validates it with the frozen wire parsers
 * exactly as it does a socket answer), and `{ok:false, error}` carries the
 * SAME strings the agent emits.
 */
async function dispatchLocalSsh(
  cmd: { type: "ssh_discover_aliases" } | { type: "ssh_resolve_config"; alias: string },
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const home = connectingHome();
  if (cmd.type === "ssh_discover_aliases") {
    const found = discoverSshAliases({ homeDir: home, configPath: defaultSshConfigPath(home) });
    const data = parseNodeSshAliasList({
      aliases: found.aliases,
      includeCycle: found.includeCycle,
      truncated: found.truncated,
    });
    return data === null ? { ok: false, error: "malformed alias discovery" } : { ok: true, data };
  }
  // The agent's twin: `-G` evaluation against the account's OWN config, and
  // the account's name for the review card. A refusal is a SUCCESSFUL answer
  // (it rides `accepted:false` in the data); only a missing binary is a
  // command failure.
  const sshBin = await findBinary("ssh", SSH_BINARY_ENV, SSH_KNOWN_PATHS);
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  const outcome = await resolveSshAliasConfig(cmd.alias, {
    sshBin,
    homeDir: home,
    configPath: defaultSshConfigPath(home),
  });
  const data = parseNodeSshResolveOutcome(outcome);
  return data === null ? { ok: false, error: "malformed resolve outcome" } : { ok: true, data };
}

/** Map a {@link NodeRpcError} by EQUALITY on `detail`, per the house rule. */
function classify(err: NodeRpcError, verb: string): SshNodeRefusal {
  // `isSshErrorCode` is the whole equality table; a refusal the grammar
  // cannot name is a sentence, not a code.
  if (err.code === "failed" && err.detail !== undefined && isSshErrorCode(err.detail)) {
    return new SshNodeRefusal(err.message, err.detail, {});
  }
  return new SshNodeRefusal(
    err.code === "unsupported" ? `node ${err.nodeId} predates SSH support; update the node (${verb})` : err.message,
    null,
    { transport: err.code === "offline" || err.code === "timeout" },
  );
}

/** A validator-refused node answer: the node is broken, and say so without dressing it as a caller refusal. */
function requireParsed<T>(parsed: T | null, nodeId: string, verb: string): T {
  if (parsed === null) {
    logger.error(`node ${nodeId} answered ${verb} with a malformed payload`);
    throw new SshNodeRefusal(`node ${nodeId} answered ${verb} with a malformed payload`, null, { malformed: true });
  }
  return parsed;
}

/** Map an adapter failure to the API: named codes first, then the transport family. */
function mapNodeFailure(err: unknown, verb: string): Error {
  if (err instanceof SshNodeRefusal) {
    if (err.code !== null) refuseSshErrorCode(err.code, verb);
    if (err.transport) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: `the connecting node could not answer ${verb}`,
        doNotLog: true,
      });
    }
    throwApiError({
      code: BackendErrorCodes.NODE_UNREACHABLE,
      message: err.malformed ? `the connecting node answered ${verb} with a malformed payload` : err.message,
      doNotLog: !err.malformed,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/* ------------------------------------------------------------------ */
/* the two reads                                                       */
/* ------------------------------------------------------------------ */

/** `GET /api/ssh-runtime/discovery?nodeId=`: alias NAMES on an eligible node, human cookie only. */
export async function sshDiscovery(
  caller: SshCaller,
  nodeId: string,
): Promise<{ aliases: string[]; includeCycle: boolean; truncated: boolean }> {
  if (caller.actor !== "cookie") refuseSshDecision({ allow: false, code: "cookie_required" });
  const eligibility = await sshNodeGate(caller, nodeId);
  if (!eligibility.allow) refuseSshDecision(eligibility);
  let result: NodeSshAliasListResult;
  try {
    result = await nodeSshDiscover(nodeId);
  } catch (err) {
    throw mapNodeFailure(err, "discovery");
  }
  await audit({
    actorUserId: caller.userId,
    action: "ssh.discover",
    targetType: "node",
    targetId: nodeId,
    metadataJson: "{}",
  });
  return { aliases: result.aliases, includeCycle: result.includeCycle, truncated: result.truncated };
}

/** The resolve body (the wizard's pick), same shape the retired request type carried. */
export interface SshResolveRequest {
  /** The connecting node to parse on */
  nodeId: string;
  /** The alias to resolve */
  alias: string;
}

/** The resolve view: a named refusal is a 200 - "this config needs a ProxyCommand" is the answer to the question, not a transport failure. */
export type SshResolveView =
  | {
      /** The alias normalized cleanly. */
      accepted: true;
      /** The snapshot the human reviews; opening the session is a separate act. */
      snapshot: SshConnectionSnapshotWire;
      /** The connecting OS account name when the node could report it (the review sentence). */
      connectingAccount?: string;
    }
  | {
      /** Resolution refused: the config needs more than the approved normalization can run, or the destination is unusable. */
      accepted: false;
      /** Named limitation ({@link SshErrorCode} subset). */
      code: SshErrorCode;
      /** Config keywords that blocked, when the code names several. */
      settings: string[];
    };

/** `POST /api/ssh-runtime/resolve`: the reviewable outcome of one alias, human-only. */
export async function sshResolve(caller: SshCaller, body: SshResolveRequest): Promise<SshResolveView> {
  if (caller.actor !== "cookie") refuseSshDecision({ allow: false, code: "cookie_required" });
  const eligibility = await sshNodeGate(caller, body.nodeId);
  if (!eligibility.allow) refuseSshDecision(eligibility);
  let outcome: NodeSshResolveOutcomeWire;
  try {
    outcome = await nodeSshResolve(body.nodeId, body.alias);
  } catch (err) {
    throw mapNodeFailure(err, "resolution");
  }
  await audit({
    actorUserId: caller.userId,
    action: "ssh.resolve",
    targetType: "node",
    targetId: body.nodeId,
    metadataJson: JSON.stringify({
      accepted: outcome.accepted,
      ...(outcome.accepted ? {} : { code: outcome.code }),
    }),
  });
  if (!outcome.accepted) return { accepted: false, code: outcome.code, settings: outcome.settings };
  // The plane re-runs the grammar before showing the snapshot as approvable:
  // a resolver bug that produced a `ProxyCommand` meets the same parser here
  // as it would at the session open, and the human never sees a snapshot the
  // open would refuse.
  const snapshot = validateSnapshotForReview(outcome.snapshot);
  return {
    accepted: true,
    snapshot,
    ...(outcome.connectingAccount !== undefined ? { connectingAccount: outcome.connectingAccount } : {}),
  };
}

/**
 * Validate a candidate snapshot with the frozen grammar and refuse by NAME:
 * a present forbidden member is `unsupported_setting` (never a silent drop),
 * anything the grammar cannot express is a plain 400, because the caller
 * sent a shape that was never a snapshot.
 */
function validateSnapshotForReview(value: unknown): SshConnectionSnapshotWire {
  const snapshot = parseSshConnectionSnapshot(value);
  if (snapshot !== null) return snapshot;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const blocked = SSH_FORBIDDEN_SNAPSHOT_FIELDS.filter((f) => record[f] != null);
    if (blocked.length > 0) refuseSshErrorCode("unsupported_setting", blocked.join(", "));
  }
  throwApiError({
    code: BackendErrorCodes.BAD_REQUEST,
    message: "The snapshot does not match the approved connection grammar",
    doNotLog: true,
  });
}
