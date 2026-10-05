import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { tmuxSocketFor } from "@internal/pane-runtime";
import { NODE_RESULT_SSH_GENERATION_STALE } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { isNodeOfflineError } from "@/services/nodes/remote-launcher.js";
import { SshGateFailure, type SshPaneHooks } from "@/services/pane-ssh-gate.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { readStoredSnapshot } from "@/services/ssh/ssh-connections.service.js";
import { nodeSshInputControl, nodeSshTerminalLaunch, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import { refuseSshErrorCode } from "@/services/ssh/ssh-refusal.js";

/**
 * The registered {@link SshPaneHooks} (Gate B): the EFFECTS the generic pane
 * surfaces cannot perform locally - every one of them is a signed command to
 * the pane's CONNECTING node, never a local-shell act.
 *
 * **The fence stamp.** The plane's `ssh_panes.controlGeneration` is the whole
 * input-fence story: {@link ManagedPaneHooks.sendManagedInput} rides the
 * ORDINARY plane->node `input` command (the same wire verb
 * `remote-launcher.sendInput` emits), but ALWAYS stamped with the generation
 * frozen at gate time - the node's InputGenerationStore answers a missing or
 * lower value with the bare {@link NODE_RESULT_SSH_GENERATION_STALE}, which
 * this module matches by EQUALITY on `NodeRpcError.detail` and frames as the
 * named refusal (AGENTS.md: node refusals map by equality, never substring).
 * `unsupported` therefore means ONLY "the connected binary predates the fence"
 * (503, update the node): it never arises from a restart that lost the mirror,
 * because the node's InputGenerationStore fails OPEN for a pane it has no
 * record of (`current()` null -> `check()` ok -> the write is ACCEPTED as an
 * ordinary pane, C's deliberate design), so a restart un-fences rather than
 * producing a stale 403. The 403 below is a real mid-write generation move.
 *
 * **No local fallback, ever** (SSH-SUPPORT.md §3): a missing subshell row,
 * connecting node, `ssh_panes` marker, or connection row is a refusal - never
 * a degraded pass onto the control-plane host. While this module is not
 * registered (before boot, or a composition that omits it) the gate's own
 * deny default answers 503; registration replaces the deny, never the guard.
 */

const subshells = new SubshellsRepository(db);
const panes = new SshPanesRepository(db);
const connections = new SshConnectionsRepository(db);

/** The refusing answer for a pane the SSH machinery no longer knows about: the surface's invisibility 404. */
function refuseGone(): never {
  throwApiError({
    code: BackendErrorCodes.NOT_FOUND_ERROR,
    message: "Subshell not found",
    doNotLog: true,
  });
}

/** One `input` frame on the ordinary transport, generation-stamped. */
function typeFrame(nodeId: string, subshellId: string, data: string, inputGeneration: number): Promise<unknown> {
  return sendCommand(
    nodeId,
    { type: "input", subshellId, data, inputGeneration },
    { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
  );
}

/**
 * Map a raw node failure on an input frame. Stale is the fence speaking:
 * a takeover or a revocation raised the pane's generation between the gate
 * and this write, so the machine refused it - the visibility 403 class
 * (`SSH_ACCESS_DENIED`, the same code the policy's refusals give), with no
 * named `sshCode` riding: which arm moved the generation is a fact the node
 * answer does not carry, and inventing one would mis-name a revocation as a
 * takeover. Offline/timeout are the create path's NODE_OFFLINE 409; an agent
 * too old for the fence is a backend refusal (503). Anything else is a
 * broken node and re-thrown raw.
 */
function rethrowInputRefusal(err: unknown): never {
  if (err instanceof NodeRpcError && err.code === "failed" && err.detail === NODE_RESULT_SSH_GENERATION_STALE) {
    throwApiError({
      code: BackendErrorCodes.SSH_ACCESS_DENIED,
      message:
        "This terminal's input generation moved on (a takeover or a revocation fenced the write at the machine).",
      doNotLog: true,
    });
  }
  if (isNodeOfflineError(err) || (err instanceof NodeRpcError && err.code === "timeout")) {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "The subshell's node has no live connection; it may still be running the subshell there",
      doNotLog: true,
    });
  }
  if (err instanceof NodeRpcError && err.code === "unsupported") {
    throwApiError({
      code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE,
      message: "The connecting node predates SSH input fencing; update the node",
      doNotLog: true,
    });
  }
  throw err;
}

class ManagedPaneHooks implements SshPaneHooks {
  /**
   * Type into a managed pane: the ordinary `input` command over the ordinary
   * `sendCommand` transport, EVERY frame carrying the generation the service
   * froze at gate time (a lower or missing value is fenced node-side). With
   * `submit` the Enter is a SECOND stamped frame - ordered but non-atomic,
   * exactly the posture the REST input path documents for ordinary panes.
   * @throws ApiError 404 when the pane or its connecting node is gone, 403
   *         `SSH_ACCESS_DENIED` when the machine refused the stamp (stale),
   *         409 NODE_OFFLINE / 503 SSH_BACKEND_UNAVAILABLE for transport
   *         refusals. A refusal never falls through to a local shell.
   */
  async sendManagedInput(req: {
    subshellId: string;
    text: string;
    submit: boolean;
    inputGeneration: number;
  }): Promise<void> {
    const row = await subshells.findById(req.subshellId);
    const nodeId = row?.nodeId ?? null;
    if (nodeId === null) refuseGone();
    try {
      await typeFrame(nodeId, req.subshellId, req.text, req.inputGeneration);
      if (req.submit) await typeFrame(nodeId, req.subshellId, "\r", req.inputGeneration);
    } catch (err) {
      rethrowInputRefusal(err);
    }
  }

  /**
   * Relay a takeover/return to the node - the SAME `ssh_input_control` call
   * `sshControlTransition` makes, carrying the generation the PLANE just
   * raised so queued writes below it fence machine-side. Called BEFORE the
   * plane row moves (pane-ssh-gate's ordering rule: the mirror never trails
   * the claim), so a refusal here leaves both sides untouched: a node
   * transport/unsupported/malformed refusal surfaces as `backend_unavailable`
   * (C maps it to the 503), a node-side stale (a takeover at the machine won
   * the race) as `forbidden` (the 403 arm), and a vanished pane row as
   * `gone` (the invisibility 404).
   */
  async applyControlTransition(req: {
    subshellId: string;
    mode: "agent" | "human";
    generation: number;
  }): Promise<void> {
    const row = await subshells.findById(req.subshellId);
    if (!row || row.nodeId === null) throw new SshGateFailure("gone", "Subshell not found");
    try {
      await nodeSshInputControl(row.nodeId, { subshellId: req.subshellId, mode: req.mode, generation: req.generation });
    } catch (err) {
      if (!(err instanceof SshNodeRefusal)) throw err;
      if (err.transport || err.unsupported || err.malformed) {
        throw new SshGateFailure("backend_unavailable", "The SSH backend needed for this pane action is not available");
      }
      throw new SshGateFailure(
        "forbidden",
        "The connecting node refused the input-control change",
        err.code ?? undefined,
      );
    }
  }

  /**
   * Re-launch the pane's SSH session: one `ssh_terminal_launch` built from
   * the connection row's STORED snapshot and `remoteDir` at the current
   * revision (fresh authorization was already rechecked by the policy gate -
   * this is effect, not a second gate). No local-shell fallback exists here:
   * a missing pane marker, connection row, or connecting node refuses 404,
   * and a node refusal maps like the create path's (named code, or the
   * offline 409). Returns the pane's socket so the restart path answers with
   * the same view shape as the ordinary revive.
   */
  async restartManagedPane(req: { subshellId: string }): Promise<{ tmuxSocket: string }> {
    const row = await subshells.findById(req.subshellId);
    const pane = await panes.findBySubshell(req.subshellId);
    if (!row || row.nodeId === null || !pane) refuseGone();
    const conn = await connections.findById(pane.connectionId);
    if (!conn) refuseGone();
    const snapshot = readStoredSnapshot(conn);
    const socket = row.tmuxSocket ?? tmuxSocketFor(req.subshellId);
    try {
      await nodeSshTerminalLaunch(row.nodeId, {
        subshellId: req.subshellId,
        socket,
        snapshot,
        remoteDir: conn.remoteDir,
      });
    } catch (err) {
      if (err instanceof SshNodeRefusal) {
        if (err.code !== null) refuseSshErrorCode(err.code);
        if (err.transport) {
          throwApiError({
            code: BackendErrorCodes.NODE_OFFLINE,
            message: "the connecting node could not open the terminal",
            doNotLog: true,
          });
        }
      }
      throw err;
    }
    return { tmuxSocket: socket };
  }
}

/** The boot-registered hooks instance (index.ts calls `registerSshPaneHooks`). */
export const sshPaneHooks: SshPaneHooks = new ManagedPaneHooks();
