import { getSshRunSupervisor, type SshRunSupervisor } from "@internal/pane-runtime";
import {
  isNodeSubshellId,
  type JsonValue,
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
} from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { connectingHomeDir, resolveSshBin } from "./ssh-shared.js";

/**
 * The four structured-run executors (SSH-SUPPORT.md §3, Durable dispatch).
 *
 * These are deliberately THIN: every rule that has to hold — acceptance
 * before spawn, dedup by digest, the quotas the node can see, bounded
 * separate-stream output, exit-255 honesty, bounded-grace local cancellation
 * — lives in `@internal/pane-runtime`'s `SshRunSupervisor`, because the
 * server-hosted node runs the SAME runtime in-process against the same
 * command bodies, and two implementations of durable dedup is the pair that
 * drifts. What stays here is the agent's own posture: the id grammar gate
 * before any path composes, the ssh-binary ladder, and running every answer
 * back through the frozen wire validator on the way out (the four-site rule
 * the integration maps name — a malformed answer must never reach a frame).
 *
 * Refusals that the plane maps by EQUALITY ride the bare `SSH_ERROR_CODES`
 * spelling in `error`: `run_conflict`, `quota_runs`, `storage_full`, and
 * `run_unknown` for any id this node has no record of (an id that cannot even
 * compose a path is indistinguishable from an unknown one, and answering the
 * bare code keeps the plane's mapping in ONE branch — never a start-retry).
 *
 * RPC shape per the transport's rulebook: `ssh_run_start` records acceptance
 * and returns immediately (the run keeps executing in the background);
 * `ssh_run_read` may hold the answer open up to the caller's (parser-capped)
 * long-poll budget; `ssh_run_cancel` holds at most the cancel grace plus a
 * beat. None of them is a long task wearing an RPC costume.
 */

/** The supervisor for this daemon's data dir, built lazily (never at import). */
async function supervisor(ctx: CommandContext): Promise<SshRunSupervisor | { missing: true }> {
  const sshBin = await resolveSshBin();
  if (sshBin === null) return { missing: true } as const;
  return getSshRunSupervisor({ dataDir: ctx.config.dataDir, homeDir: connectingHomeDir(), sshBin, nowMs: ctx.nowMs });
}

function factsResult(facts: ReturnType<typeof parseNodeSshRunFacts>): CommandResult {
  if (facts === null) return { ok: false, error: "malformed run facts" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: facts as unknown as JsonValue };
}

/** Execute `ssh_run_start`. */
export async function execSshRunStart(ctx: CommandContext, cmd: Cmd<"ssh_run_start">): Promise<CommandResult> {
  // Path-composition gate FIRST (the `assertNodePathId` posture): the wire
  // id grammar is loose, the filesystem one is not, and the answer an id
  // this node can never store is `run_unknown` — never a second start, never
  // a composed path.
  if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const started = await sup.start({
    runId: cmd.runId,
    requestDigest: cmd.requestDigest,
    snapshot: cmd.snapshot,
    remoteDir: cmd.remoteDir,
    command: cmd.command,
    deadlineMs: cmd.deadlineMs,
  });
  if (started.kind === "refused") return { ok: false, error: started.code };
  return factsResult(parseNodeSshRunFacts(started.facts));
}

/** Execute `ssh_run_status`. */
export async function execSshRunStatus(ctx: CommandContext, cmd: Cmd<"ssh_run_status">): Promise<CommandResult> {
  if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const facts = sup.status(cmd.runId);
  if (facts === null) return { ok: false, error: "run_unknown" };
  return factsResult(parseNodeSshRunFacts(facts));
}

/** Execute `ssh_run_cancel`. */
export async function execSshRunCancel(ctx: CommandContext, cmd: Cmd<"ssh_run_cancel">): Promise<CommandResult> {
  if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const facts = await sup.cancel(cmd.runId);
  if (facts === null) return { ok: false, error: "run_unknown" };
  return factsResult(parseNodeSshRunFacts(facts));
}

/** Execute `ssh_run_read` (bounded window + facts; a timed-out long poll is an EMPTY window answer, not an error). */
export async function execSshRunRead(ctx: CommandContext, cmd: Cmd<"ssh_run_read">): Promise<CommandResult> {
  if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const result = await sup.read(cmd.runId, cmd.stdoutFromByte, cmd.stderrFromByte, cmd.maxBytes, cmd.waitMs);
  if (result === null) return { ok: false, error: "run_unknown" };
  const validated = parseNodeSshRunReadResult(result);
  if (validated === null) return { ok: false, error: "malformed run read result" };
  return { ok: true, data: validated as unknown as JsonValue };
}
