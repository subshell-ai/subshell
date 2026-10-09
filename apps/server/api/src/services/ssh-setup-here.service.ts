import { BackendErrorCodes } from "@internal/backend-errors";
import { buildSshKnownHostsPath, shellQuote } from "@internal/pane-runtime";
import {
  parseSshConnectionSnapshot,
  redactSshSetupKeyLines,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { sshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { SshRpcError, sshExec, sshExecStatus } from "@/services/nodes/ssh-rpc.js";
import {
  composeSshLaunch,
  gateSshNode,
  relaySnapshotRefusal,
  rpcRefusal,
  type SshAnswer,
  targetDataDir,
} from "@/services/ssh-launch.service.js";
import { getRelayBroker, type RelayBroker } from "@/services/ssh-relay.service.js";
import { prepareRelayLeg } from "@/services/ssh-relay-launch.service.js";
import type { SshSetupStage } from "@/services/ssh-setup-progress.js";
import { logger } from "@/utils/logger.js";

/**
 * The "Set up Subshell here" act (spec 2026-10-08 §7, Task 14): turn the
 * destination D of an open SSH-terminal pane into an enrolled node by running
 * the ORDINARY enrollment install on D, over a SEPARATE non-interactive
 * `ssh D '<install>'` that reuses the pane's authorization and leaves the
 * pane itself untouched. The plan, in the order it runs:
 *
 * 1. THE PANE: owner's row (a foreign id is the 404 the ownership axis
 *    demands), its approved snapshot (D), and its key home column (0052): the
 *    pane was a relay pane exactly when it names an A.
 * 2. THE GATES: B re-gated through the launcher's own door; in relay mode A
 *    too, AND live - the act signs with A's agent, so an offline key home is
 *    refused with A-online NAMED before a key is minted or a pane is touched.
 * 3. THE KEY: a fresh single-use setup key, minted by the ordinary
 *    repository, owned by the caller (the new node's future owner). It is
 *    never typed anywhere a pane or a log can read: it rides the signed
 *    node-link command, then B's short-lived ssh argv, then D's install URL -
 *    the three accepted postures §7 names - and nothing else. The act's
 *    refusal copy, its audit rows, and every retained byte pass through the
 *    redactor (belt on the plane: the machine's own redaction is the first
 *    station, this one does not trust it).
 * 4. THE RUN: `ssh_exec` on B - compose exactly like the pane launch
 *    (relay-mode render pins D's host key the same way), kick it off B's
 *    command chain, and poll `ssh_exec_status` to the terminal answer. The
 *    answer's output is PARSED into a controlled status verb; raw installer
 *    output is never echoed to a caller.
 * 5. THE EGRESS CAUSE: an install that could not reach the plane answers
 *    `SSH_UPGRADE_EGRESS` - a code of its own, distinct from any key error,
 *    per §7. The pane is untouched either way (this act never writes one).
 * 6. SUCCESS: the new node's `ready` frame, awaited with a bounded wait
 *    (the setup key's row carries the node id enrollment consumed it for;
 *    the registry's `agent` facts appear only when `ready` lands). Success
 *    is that fact, not the installer's own cheer line.
 *
 * Every exit AFTER THE KEY EXISTS writes ONE `node.ssh_upgrade.run` audit
 * row naming ids, the destination, the relay session, and the OUTCOME/stage - never
 * the key, never the installer's words; an unexpected internal throw records
 * its own `internal-error` stage on the way out (best effort) before
 * propagating. Refusals raised by the gates write no row - there is no key
 * or session to account for there.
 */

/** How long B's ssh child may run before the node-side deadline ends it. An installer pulls a ~100 MB binary; this is minutes, honestly. */
export const SSH_SETUP_EXEC_TIMEOUT_MS = 8 * 60_000;

/** The plane's poll margin past the node's own deadline (the deadline kills the child; the margin only decides when we stop asking). */
const EXEC_POLL_MARGIN_MS = 60_000;

/** The bounded wait for the new node to enroll (spend the key) and report `ready` after the installer exited 0. */
export const SETUP_READY_BUDGET_MS = 60_000;

/** The poll cadence for both waits; tests collapse it to zero with the injected clock. */
const SETUP_POLL_MS = 1_500;

/** The service's world. Production at {@link defaultDeps}; tests install a fake. */
export interface SshSetupHereDeps {
  /** Epoch-ms clock driving both bounded waits. */
  nowMs(): number;
  /** Sleep between polls (production: real timers). */
  sleepMs(ms: number): Promise<void>;
  /** The node's ssh child deadline for this act (production: {@link SSH_SETUP_EXEC_TIMEOUT_MS}). */
  execTimeoutMs: number;
  /** The plane's poll margin past that deadline (production: {@link EXEC_POLL_MARGIN_MS}). */
  execPollMarginMs: number;
  /** The enroll+ready budget after a clean install (production: {@link SETUP_READY_BUDGET_MS}). */
  readyBudgetMs: number;
  /** Poll cadence (production: {@link SETUP_POLL_MS}). */
  pollMs: number;
  /** The relay broker the act's own pairing is closed through. */
  broker(): RelayBroker;
}

let depsOverride: SshSetupHereDeps | null = null;

function setupDeps(): SshSetupHereDeps {
  if (depsOverride) return depsOverride;
  return {
    nowMs: () => Date.now(),
    sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
    execTimeoutMs: SSH_SETUP_EXEC_TIMEOUT_MS,
    execPollMarginMs: EXEC_POLL_MARGIN_MS,
    readyBudgetMs: SETUP_READY_BUDGET_MS,
    pollMs: SETUP_POLL_MS,
    broker: () => getRelayBroker(),
  };
}

/**
 * Install (or with null, drop) the whole seam.
 * @internal test-only - no suite waits eight minutes for a child or sixty
 * seconds for a `ready` frame.
 */
export function setSshSetupHereDepsForTests(deps: SshSetupHereDeps | null): void {
  depsOverride = deps;
}

function coded(status: 400 | 403 | 404 | 409 | 502, code: BackendErrorCodes, message: string): SshAnswer<never> {
  return { ok: false, refusal: { status, code, message } };
}

/**
 * Does this failed-install answer say "D could not reach the plane" (§7's
 * NAMED egress stage)? Two shapes carry that fact, and both matter: the
 * rendered installer's own sentence (it was running and a fetch failed
 * mid-way), and curl's own connect/DNS failure - the act's FIRST fetch is
 * install.sh itself, so a DARK destination never prints a script line at
 * all; its answer is curl's stderr and curl's exit code alone (6 resolve,
 * 7 connect, 28 timeout). A key or artifact failure never looks like this:
 * those answer an HTTP status (curl 22, or the script's own advice), not a
 * failed connect, and the belt arm keys on the missing `==>` banner, which
 * only the pre-script curl failure lacks.
 */
function couldNotReachPlane(output: string, code: number | null): boolean {
  if (output.includes("could not reach") || output.includes("could not fetch the checksum")) return true;
  if (/\bcurl: \((6|7|28)\)/.test(output)) return true;
  const lower = output.toLowerCase();
  if (lower.includes("could not resolve host") || /\bfailed( to)? connect\b/.test(lower)) return true;
  return (code === 6 || code === 7) && !output.includes("==>");
}

/** Enrollment identity, with an explicit flag when its connection is not confirmed. */
export interface SetupHereResult {
  nodeId: string;
  /** False when enrollment completed but the new machine has not reported ready. */
  connected?: boolean;
}

/**
 * Run the act for one pane. The caller is the pane's owner (a cookie actor;
 * a foreign or absent pane is one 404, the ordinary invisibility). Refusals
 * name their stage; the key never rides one.
 */
export async function setupHere(args: {
  viewerId: string;
  paneId: string;
  onProgress?: (stage: SshSetupStage) => void;
}): Promise<SshAnswer<SetupHereResult>> {
  const deps = setupDeps();
  const pane = await db.selectFrom("subshells").selectAll().where("id", "=", args.paneId).executeTakeFirst();
  if (!pane || pane.userId !== args.viewerId) {
    return coded(404, BackendErrorCodes.NOT_FOUND_ERROR, "Subshell not found");
  }
  if (pane.ssh === null) {
    return coded(
      409,
      BackendErrorCodes.SSH_UPGRADE_FAILED,
      "Setting up Subshell here is an act on an SSH-terminal pane; this pane is not one.",
    );
  }
  let snapshot: SshConnectionSnapshotWire | null = null;
  try {
    snapshot = parseSshConnectionSnapshot(JSON.parse(pane.ssh) as unknown);
  } catch {
    snapshot = null;
  }
  if (snapshot === null) {
    return coded(
      409,
      BackendErrorCodes.SSH_UPGRADE_FAILED,
      "This pane's approved destination could not be read back from its row; open the connection again and run the act fresh.",
    );
  }

  // Gates first (B, then A in relay mode): every refusal below writes no key,
  // opens no session, and leaves the pane running.
  const gateB = await gateSshNode(args.viewerId, pane.nodeId);
  if (!gateB.ok) return gateB;
  if (gateB.value.row.kind !== "agent") {
    // The server host has no agent socket to carry an exec; §7's act runs on
    // the Subshell app's machine, so a direct pane launched FROM the plane
    // host refuses by name rather than inventing an in-process path.
    return coded(
      409,
      BackendErrorCodes.SSH_UPGRADE_FAILED,
      "Setting up Subshell here runs from the Subshell app on the connecting machine; the server host is not a connecting machine for it.",
    );
  }
  const dataDirB = targetDataDir(gateB.value.row);
  if (dataDirB === null) {
    return coded(
      409,
      BackendErrorCodes.NODE_OFFLINE,
      "That machine has not reported its data directory yet; retry once it is fully connected.",
    );
  }
  const destination = sshCanonicalDestination({ host: snapshot.host, port: snapshot.port, user: snapshot.user });

  // The act's own ephemeral id: the config dir, the pinned-file path, the
  // relay socket, and the exec registry key ALL derive from it. It is not the
  // pane's id - the pane's config and socket stay exactly as they are.
  const execId = crypto.randomUUID();

  let relayRef: string | null = null;
  let aNodeId: string | null = null;
  const keyHome = pane.keyHomeNodeId;
  if (keyHome !== null && keyHome !== undefined) {
    const unsupported = relaySnapshotRefusal(snapshot);
    if (unsupported) return unsupported;
    aNodeId = keyHome;
    const gateA = await gateSshNode(args.viewerId, keyHome);
    if (!gateA.ok) return gateA;
    if (gateA.value.row.kind !== "agent") {
      return coded(
        409,
        BackendErrorCodes.SSH_RELAY_OPEN_FAILED,
        "The server host itself cannot hold a relay key home; this pane was not opened through one.",
      );
    }
    if (!getLive(keyHome)) {
      return coded(
        409,
        BackendErrorCodes.SSH_RELAY_OPEN_FAILED,
        `Setting up Subshell here signs with ${gateA.value.row.name}'s keys over the relay, and that key home must be online for it. Bring it online and run the act again.`,
      );
    }
    const leg = await prepareRelayLeg({
      viewerId: args.viewerId,
      aNode: { id: gateA.value.row.id, name: gateA.value.row.name },
      bNodeId: pane.nodeId,
      destination,
      // The pairing serves the EXEC, so the ephemeral id is its paneId: the
      // proxy socket and the delivered host pin land in the exec's own
      // directory, never the pane's.
      paneId: execId,
    });
    if (!leg.ok) return leg;
    relayRef = leg.value.ref;
  }

  // The single-use key, minted only once every door above has opened.
  const keys = new NodeSetupKeysRepository(db);
  const keyRow = await keys.create(args.viewerId);

  const composed = composeSshLaunch({
    snapshot,
    targetDataDir: dataDirB,
    subshellId: execId,
    ...(relayRef !== null ? { hostPinPath: buildSshKnownHostsPath(dataDirB, execId) } : {}),
  });
  // BatchMode first: the exec must never fall back to a password or a
  // host-key PROMPT - auth failure or pin mismatch is a fast refusal, an
  // interactive prompt would sit out the deadline on a terminal no one holds.
  const presetFlags = ["-o", "BatchMode=yes", ...composed.presetFlags];
  // The installer one-liner, exactly the copy-paste act §7 describes, with
  // the scripted name (the pane's destination host) because the exec has no
  // terminal to answer `setup`'s naming question. shellQuote every token;
  // `bash -c` so pipefail exists and a failed fetch is not hidden by the
  // empty-stdin pipe.
  const installUrl = `${APP_BASE_URL}/install.sh?setup_key=${keyRow.key}`;
  const nodeName = snapshot.host;
  const remoteCommand = `bash -c ${shellQuote(
    `set -o pipefail; curl -fsSL ${shellQuote(installUrl)} | SUBSHELL_NODE_NAME=${shellQuote(nodeName)} bash`,
  )}`;

  // The audit this act OWNS: written at every exit with ids and the outcome
  // only. Built once per path; the key never enters it (never interpolated).
  const runAudit = async (outcome: "enrolled" | "refused", cause: string, newNodeId?: string): Promise<void> => {
    await audit({
      actorUserId: args.viewerId,
      action: "node.ssh_upgrade.run",
      targetType: "node",
      targetId: pane.nodeId,
      metadataJson: JSON.stringify({
        paneId: pane.id,
        bNodeId: pane.nodeId,
        ...(aNodeId !== null ? { aNodeId } : {}),
        ...(relayRef !== null ? { relayRef } : {}),
        destination,
        execId,
        outcome,
        cause, // a STAGE word chosen by this file, never machine text
        ...(newNodeId !== undefined ? { newNodeId } : {}),
      }),
    });
  };
  /** Best-effort: an unspent key is revoked when the act gives up; a spent one stands as enroll's record. */
  const revokeUnspentKey = async (): Promise<void> => {
    try {
      // Atomic with enrollment's compare-and-set: never erase its consumed
      // record between a state read and deletion.
      await db.deleteFrom("nodeSetupKeys").where("id", "=", keyRow.id).where("usedAt", "is", null).execute();
    } catch (err) {
      logger.withError(err).warn(`setup-here: could not revoke the unspent key for pane ${pane.id}`);
    }
  };
  /** Enrollment is durable even if installation or the connecting link fails afterward. */
  const enrolledResult = async (cause: string): Promise<SshAnswer<SetupHereResult> | null> => {
    const spent = await keys.findById(keyRow.id);
    const nodeId = spent?.consumedNodeId;
    if (!nodeId) return null;
    const connected = getLive(nodeId)?.agent !== undefined;
    await runAudit("enrolled", connected ? "ready" : cause, nodeId);
    return { ok: true, value: { nodeId, ...(connected ? {} : { connected: false }) } };
  };
  /**
   * The post-mint invariant: even an unexpected internal throw (not the
   * machine refusing, something HERE failing) leaves its terminal row.
   * Best-effort: the audit system must never replace the original error.
   */
  const auditInternalFailure = async (): Promise<void> => {
    try {
      await runAudit("refused", "internal-error");
    } catch (auditErr) {
      logger.withError(auditErr).warn(`setup-here: could not audit the internal failure for pane ${pane.id}`);
    }
  };
  /** Close the exec's own relay pairing (the act's child is gone; the socket should be). */
  const closeExecRelay = async (): Promise<void> => {
    if (relayRef === null) return;
    try {
      await deps.broker().closeForPane(execId, "child-exit");
    } catch (err) {
      logger.withError(err).warn(`setup-here: relay close for exec ${execId} failed`);
    }
  };

  args.onProgress?.("installing");

  // KICK. A refusal here has minted a key and opened a relay and must leave
  // both as it found them (revoke the unspent key, cut the fresh session).
  try {
    await sshExec(pane.nodeId, {
      execId,
      configPath: composed.configPath,
      fileContent: composed.fileContent,
      presetFlags,
      command: remoteCommand,
      relay: relayRef !== null,
      agentSocketPath: relayRef === null ? snapshot.authAgentSocket : null,
      timeoutMs: deps.execTimeoutMs,
    });
  } catch (err) {
    await closeExecRelay();
    await revokeUnspentKey();
    const enrolled = await enrolledResult(err instanceof SshRpcError ? `exec-${err.kind}` : "internal-error");
    if (enrolled) return enrolled;
    if (err instanceof SshRpcError) {
      const r = rpcRefusal(err);
      await runAudit("refused", `exec-${err.kind}`);
      return r;
    }
    await auditInternalFailure();
    throw err;
  }

  // POLL to the terminal answer. The node holds the deadline; the plane only
  // stops asking past its own margin.
  const pollDeadline = deps.nowMs() + deps.execTimeoutMs + deps.execPollMarginMs;
  let terminal: Awaited<ReturnType<typeof sshExecStatus>>;
  for (;;) {
    try {
      terminal = await sshExecStatus(pane.nodeId, execId);
    } catch (err) {
      await closeExecRelay();
      await revokeUnspentKey();
      const enrolled = await enrolledResult(err instanceof SshRpcError ? `exec-lost-${err.kind}` : "internal-error");
      if (enrolled) return enrolled;
      if (err instanceof SshRpcError) {
        await runAudit("refused", `exec-lost-${err.kind}`);
        return rpcRefusal(err);
      }
      await auditInternalFailure();
      throw err;
    }
    if (terminal.state === "done") break;
    if (deps.nowMs() > pollDeadline) {
      await closeExecRelay();
      await revokeUnspentKey();
      const enrolled = await enrolledResult("install-deadline");
      if (enrolled) return enrolled;
      await runAudit("refused", "install-deadline");
      return coded(
        409,
        BackendErrorCodes.SSH_UPGRADE_FAILED,
        "The install did not finish within its deadline on the connecting machine; nothing was enrolled by this act.",
      );
    }
    await deps.sleepMs(deps.pollMs);
  }
  await closeExecRelay();

  // The belt redaction: the machine's answer is the first station's word,
  // this plane keeps NOTHING raw. Output informs the verb and then goes.
  const output = redactSshSetupKeyLines(`${terminal.stdout}\n${terminal.stderr}`);
  const installOk = terminal.code === 0 && !terminal.timedOut;

  if (!installOk) {
    await revokeUnspentKey();
    // Awaited, not fire-and-forget: the trail of the act that just refused
    // must be readable when the caller sees the refusal (the `ssh.launch`
    // posture inverted - there success audits last, here every exit audits
    // BEFORE the answer leaves).
    const fail = async (cause: string, refusal: SshAnswer<never>): Promise<SshAnswer<SetupHereResult>> => {
      const enrolled = await enrolledResult(cause);
      if (enrolled) return enrolled;
      await runAudit("refused", cause);
      return refusal;
    };
    if (terminal.timedOut) {
      return await fail(
        "install-timeout",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_FAILED,
          "The install ran out of time on the connecting machine; nothing was enrolled by this act.",
        ),
      );
    }
    // The named causes, each from a phrase the rendered installer prints (the
    // script's OWN words are the parser's contract; none of them is echoed),
    // or from curl's own connect-failure shape when the script never ran.
    if (couldNotReachPlane(output, terminal.code)) {
      // §7's egress refusal: its own code, distinct from any key error, and
      // the pane keeps running untouched.
      return await fail(
        "egress",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_EGRESS,
          `The destination could not reach ${APP_BASE_URL}, so it cannot install Subshell. Nothing was enrolled; the connection and its pane are untouched.`,
        ),
      );
    }
    if (output.includes("setup key was rejected")) {
      return await fail(
        "enroll-key",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_FAILED,
          "The enrollment key was rejected during the install (invalid, expired, or already used); nothing was enrolled.",
        ),
      );
    }
    if (output.includes("could not provide a")) {
      return await fail(
        "artifact",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_FAILED,
          "This server had no node build for the destination's platform; supply it from the server's machine page and run the act again.",
        ),
      );
    }
    if (output.includes("tmux is still missing") || output.includes("refuse to enroll")) {
      return await fail(
        "preflight-tmux",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_FAILED,
          "The destination has no tmux, which every node needs; install it there and run the act again.",
        ),
      );
    }
    if (output.includes("already have a node named")) {
      return await fail(
        "enroll-name",
        coded(
          409,
          BackendErrorCodes.SSH_UPGRADE_FAILED,
          "You already own a node named for this destination; delete or rename that machine entry and run the act again.",
        ),
      );
    }
    return await fail(
      `install-exit-${terminal.code ?? "signal"}`,
      coded(
        409,
        BackendErrorCodes.SSH_UPGRADE_FAILED,
        "The install on the destination stopped before enrolling; nothing was enrolled by this act.",
      ),
    );
  }

  // Success is the new node's `ready`, not the installer's cheer. The setup
  // key's row learns the node id enrollment spent it for; the registry's
  // agent facts appear exactly when that node's `ready` frame lands.
  args.onProgress?.("connecting");
  const readyDeadline = deps.nowMs() + deps.readyBudgetMs;
  for (;;) {
    const spent = await keys.findById(keyRow.id);
    const newNodeId = spent?.consumedNodeId ?? null;
    if (newNodeId !== null && getLive(newNodeId)?.agent !== undefined) {
      await runAudit("enrolled", "ready", newNodeId);
      return { ok: true, value: { nodeId: newNodeId } };
    }
    if (deps.nowMs() > readyDeadline) break;
    await deps.sleepMs(deps.pollMs);
  }
  await revokeUnspentKey();
  const enrolled = await enrolledResult("ready-timeout");
  if (enrolled) return enrolled;
  await runAudit("refused", "enroll-missing");
  return coded(
    409,
    BackendErrorCodes.SSH_UPGRADE_FAILED,
    "The install finished without enrolling a machine with the key this act minted; nothing was enrolled.",
  );
}
