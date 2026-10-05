import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { SSH_OUTPUT_WINDOW_MAX_BYTES, SSH_READ_LONG_POLL_MAX_MS } from "@internal/subshell-protocol";
import type { SshRunTable } from "@/db/types/ssh-runs.db-types.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type {
  SshRunCancelView,
  SshRunListView,
  SshRunOutputQuery,
  SshRunOutputView,
  SshRunView,
} from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { bestEffortRunCancel, nodeSshRunRead, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import {
  clamp,
  requireRow,
  requireRunRow,
  settleIfUnresolved,
  sshRunsRepo,
  toRunView,
} from "@/services/ssh/ssh-run-mirror.js";

/**
 * The runs READ side (review fix M-2 split it from the start/dispatch service
 * `ssh-runs.service.ts`): output relay, facts, list, and cancel. The
 * storage rule it exists to express: the server stores run METADATA and
 * relays the node's bounded window; output lives on the connecting runtime
 * and nowhere near this process.
 */

/** The list tail every runs list answers with (a bounded recent window, not a cursor). */
export const SSH_RUNS_LIST_TAIL = 100;

/**
 * `GET /api/ssh/runs/:id/output`: gated, bounded RELAY of the node-retained
 * output. A closing browser or a timed-out wait answers normally and cancels
 * NOTHING (spec §3, verbatim); an offset past retained output answers
 * `cursorExpired` - the caller restarts from 0, never silently reuses the
 * dead cursor (the explicit-reset rule §3's rotation paragraph demands).
 */
export async function sshRunRead(
  caller: SshCaller,
  runId: string,
  query: SshRunOutputQuery,
): Promise<SshRunOutputView> {
  const runs = sshRunsRepo();
  const row = await requireRunRow(caller, runId, "relay");
  if (row.nodeId === null) {
    // The node is gone; its output store went with it. The facts stay, the
    // window cannot be answered, and the honest cursor state is "expired".
    const settled = await settleIfUnresolved(row, "unknown");
    return emptyWindow(settled, true);
  }
  const maxBytes = clamp(query.maxBytes ?? SSH_OUTPUT_WINDOW_MAX_BYTES, 1, SSH_OUTPUT_WINDOW_MAX_BYTES);
  const waitMs = clamp(query.waitMs ?? 0, 0, SSH_READ_LONG_POLL_MAX_MS);
  const stdoutFromByte = Math.max(0, Math.floor(query.stdoutFromByte ?? 0));
  const stderrFromByte = Math.max(0, Math.floor(query.stderrFromByte ?? 0));
  try {
    const result = await nodeSshRunRead(row.nodeId, { runId, stdoutFromByte, stderrFromByte, maxBytes, waitMs });
    await runs.applyFacts(runId, result);
    return {
      run: toRunView(await requireRow(runId)),
      stdout: decode(result.stdoutB64),
      stderr: decode(result.stderrB64),
      stdoutNext: result.stdoutNext,
      stderrNext: result.stderrNext,
      stdoutTotal: result.stdoutTotal,
      stderrTotal: result.stderrTotal,
      truncated: result.truncated,
      cursorExpired: stdoutFromByte > result.stdoutTotal || stderrFromByte > result.stderrTotal,
    };
  } catch (err) {
    if (err instanceof SshNodeRefusal && err.code === "run_unknown") {
      // The node has no record: the history expired or the acceptance crashed
      // before it. `unknown` is the honest settle - never failed, never
      // successful, and the window is whatever is retained: nothing.
      const settled = await settleIfUnresolved(row, "unknown");
      return emptyWindow(settled, true);
    }
    if (err instanceof SshNodeRefusal && err.transport) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "the connecting node cannot answer an output read right now",
        doNotLog: true,
      });
    }
    throw err;
  }
}

/** `GET /api/ssh/runs/:id`: the mirror's facts, no dispatch. */
export async function sshRunGet(caller: SshCaller, runId: string): Promise<SshRunView> {
  return toRunView(await requireRunRow(caller, runId, "facts"));
}

/**
 * `GET /api/ssh/runs`: the caller's recent runs, newest first, tail bounded.
 * Human: their own rows. Pane: rows its CURRENT credential initiated (runs a
 * pane started under an old key are not its recovery list - no
 * grandfathering, §2). No policy gate dispatches here because no act
 * dispatches: visibility is row-ownership on the caller's own identity, the
 * same projection the subshell list gives a bearer.
 */
export async function sshRunList(caller: SshCaller): Promise<SshRunListView> {
  const runs = sshRunsRepo();
  if (caller.actor === "cookie") {
    return { runs: (await runs.listRecentByOwner(caller.userId, SSH_RUNS_LIST_TAIL)).map(toRunView) };
  }
  if (caller.actor !== "subshell-key" || caller.apiKeyId === null) return { runs: [] };
  return { runs: (await runs.listRecentByCredential(caller.apiKeyId, SSH_RUNS_LIST_TAIL)).map(toRunView) };
}

/**
 * `POST /api/ssh/runs/:id/cancel`: the REQUEST is the local fact (recorded
 * first, always); the DISPATCH is best-effort. An offline node keeps the
 * cancellation pending, and the reconnect pass dispatches it before any new
 * work (spec §2's offline rule) - this call answers the mirror either way,
 * with `cancelLocalConfirmed` saying what the node actually confirmed.
 */
export async function sshRunCancel(caller: SshCaller, runId: string): Promise<SshRunCancelView> {
  const runs = sshRunsRepo();
  const row = await requireRunRow(caller, runId, "cancel");
  await runs.markCancelRequested(runId);
  await auditSsh(caller.userId, "ssh.run.cancel", "ssh_run", runId, { nodeId: row.nodeId });
  if (row.nodeId !== null && getLive(row.nodeId)) {
    const facts = await bestEffortRunCancel(row.nodeId, runId);
    if (facts) await runs.applyFacts(runId, facts);
  }
  return toRunView(await requireRunRow(caller, runId, "cancel"));
}

/* ------------------------------------------------------------------ */
/* window plumbing                                                     */
/* ------------------------------------------------------------------ */

/** UTF-8 LOSSY decode: output is data for a terminal, and a partial sequence must not 400 a read. */
function decode(b64: string): string {
  return b64 === "" ? "" : Buffer.from(b64, "base64").toString("utf8");
}

function emptyWindow(row: SshRunTable, cursorExpired: boolean): SshRunOutputView {
  return {
    run: toRunView(row),
    stdout: "",
    stderr: "",
    stdoutNext: 0,
    stderrNext: 0,
    stdoutTotal: 0,
    stderrTotal: 0,
    truncated: false,
    cursorExpired,
  };
}
