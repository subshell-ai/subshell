import { getSshSessionSupervisor, peekSshSessionSupervisor } from "@internal/pane-runtime";
import {
  isSshSessionRef,
  type JsonValue,
  parseNodeSshSessionOpenResult,
  SSH_SESSION_PUMP_CHUNK_BYTES,
  SSH_SESSION_UNKNOWN,
  type SshSessionOpenResultWire,
} from "@internal/subshell-protocol";
import { log } from "../log.js";
import type { Cmd, CommandContext, CommandLinkGate, CommandResult } from "./context.js";
import { connectingHomeDir, resolveSshBin } from "./ssh-shared.js";
import { TAIL_BACKPRESSURE_BYTES, TAIL_BACKPRESSURE_POLL_MS } from "./tail.js";

/**
 * The three brokered-session executors (design 2026-10-05 §3).
 *
 * Thin by the same contract the run family follows: every rule lives in
 * `@internal/pane-runtime`'s `SshSessionSupervisor` (policy render, probe,
 * hello gate, pump bounds, group-kill, boot reconcile) and these functions
 * only (a) reach the supervisor for this daemon's data dir, (b) hand it the
 * transport's pump seam, and (c) answer the frozen wire shapes - the open
 * result re-validated on the way out, the equality-mapped refusal codes
 * verbatim in `result{error}`.
 *
 * The pump seam is the one piece with real logic here, and it is a port of
 * tail.ts's backpressure: await `bufferedAmount` back under the threshold
 * before sealing each chunk into a `session_frame` event. The runtime's
 * stdout is the destination program's output and can outrun the socket; a
 * broker that buffered without bound would turn a chatty pane into the
 * daemon's memory exhaustion, which is the bounded-pump promise in §2 made
 * concrete.
 *
 * Refusals the plane maps by EQUALITY ride the bare codes (`runtime_missing`,
 * `session_quota`, `session_protocol`, `run_conflict`, `session_unknown`, and
 * the classified transport codes); an ssh binary missing entirely answers
 * like every other ssh arm ("ssh binary missing: ssh").
 */

/**
 * Split one stdout read into `≤ maxBytes` raw pieces for the `session_frame`
 * pump (the node-frames arm's own claim: "raw stdout content in ≤ 192 KiB
 * pieces"). A read at or under the bound passes through as ONE piece, byte-
 * identical; longer reads are cut on exact offsets, and concatenating the
 * pieces reproduces the input (pinned by test). This is the bound the node-
 * link's frame-size discipline and the plane's ingest accounting were sized
 * for; before it, one 64 KiB high-water-mark read spliced with a saturated
 * pipe could ship a larger single event than the claim promised.
 */
export function pumpChunks(chunk: Uint8Array, maxBytes: number): Uint8Array[] {
  if (chunk.byteLength <= maxBytes) return [chunk];
  const parts: Uint8Array[] = [];
  for (let off = 0; off < chunk.byteLength; off += maxBytes) {
    parts.push(chunk.subarray(off, Math.min(off + maxBytes, chunk.byteLength)));
  }
  return parts;
}

/** The supervisor for this daemon's data dir, or the named absence. */
async function supervisor(ctx: CommandContext) {
  const sshBin = await resolveSshBin();
  if (sshBin === null) return { missing: true } as const;
  return getSshSessionSupervisor({
    dataDir: ctx.config.dataDir,
    homeDir: connectingHomeDir(),
    sshBin,
    nowMs: ctx.nowMs,
  });
}

/**
 * Execute `ssh_session_open`: probe the runtime, spawn the child, wait for
 * the hello, answer the parsed open facts. The daemon's serial command chain
 * makes one open-at-a-time per node the enforced shape; the plane's RPC
 * timeout must outlast {@link SSH_SESSION_OPEN_DEADLINE_MS} (the ssh-node
 * client's open sends 45 s for exactly that).
 */
export async function execSshSessionOpen(
  ctx: CommandContext,
  cmd: Cmd<"ssh_session_open">,
  link?: CommandLinkGate,
): Promise<CommandResult> {
  if (!isSshSessionRef(cmd.ref)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const outcome = await sup.open(
    { ref: cmd.ref, target: cmd.target, runtimeCommand: cmd.runtimeCommand ?? "subshell" },
    {
      emitBytes: async (chunk): Promise<void> => {
        // Backpressure mirrors the tail pump: throttle BEFORE sealing each
        // chunk, and a dead socket (send throws) stops the session the same
        // way it stops a tail - the child's group goes with it. One stdout
        // read can return more than the node-frames promise ("in ≤ 192 KiB
        // pieces"), so the read is SPLIT here before sealing: the session's
        // codec reassembles frames across pushes, so a chunk boundary costs
        // the stream nothing but an event, and the plane's ingest never sees
        // one fat event at a time it must buffer.
        for (const part of pumpChunks(chunk, SSH_SESSION_PUMP_CHUNK_BYTES)) {
          let attempts = 0;
          while ((ctx.ws.bufferedAmount ?? 0) > TAIL_BACKPRESSURE_BYTES && attempts < 600) {
            await Bun.sleep(TAIL_BACKPRESSURE_POLL_MS);
            attempts += 1;
          }
          try {
            ctx.ws.send({ type: "session_frame", ref: cmd.ref, data_b64: Buffer.from(part).toString("base64") });
          } catch {
            sup.close(cmd.ref);
            return; // the session is over mid-read; the rest of the bytes go with it
          }
        }
      },
      emitDiag: (line): void => {
        // The child's stderr to the daemon's OWN log, uninterpreted (design
        // §2): the session record for why an open or run died is here.
        log(`ssh-session ${cmd.ref.slice(0, 8)} stderr: ${line}`);
      },
      onLost: ({ exitCode }): void => {
        // The close report (design §6 Disconnect): the plane marks the
        // session `lost` and its panes unavailable from this one event.
        ctx.ws.send({
          type: "error",
          code: "ssh_session_lost",
          message: JSON.stringify({ ref: cmd.ref, exitCode }),
        });
      },
    },
  );
  if (outcome.kind === "refused") return { ok: false, error: outcome.code };
  // The late-open reclaim (review m-B): this command's probe + hello gate
  // can outlast its own link. A ref enters the supervisor's live map only
  // at hello, so the link-close drain's snapshot could not have included
  // it - answering `open` now would hand the plane a session whose RPC died
  // with the old socket (its row already unrolled), an orphan holding a
  // quota slot and the destination's door for every future open there.
  // Reclaim through the supervisor's own close (group-kill, `closed`
  // recorded, the `stopping` latch keeps the death quiet) and refuse.
  if (link && !link.isCurrent()) {
    log(`ssh-session ${cmd.ref.slice(0, 8)} opened after its link died: reclaimed, refused`);
    sup.close(cmd.ref);
    return { ok: false, error: "connection_failed" };
  }
  const validated = parseNodeSshSessionOpenResult(outcome.result as unknown as SshSessionOpenResultWire);
  if (validated === null) return { ok: false, error: "malformed session open result" };
  return { ok: true, data: validated as unknown as JsonValue };
}

/**
 * Drain every brokered session this process supervises for `dataDir`
 * (review M1). The daemon's link-close path calls it, and the reason is the
 * PLANE's semantics, not a leak cleanup: a link close is terminal for the
 * sessions riding it (`markSessionsLostForNode` - design §6: a lost session
 * is never resumable), so a child that outlives the socket is an orphan
 * holding a quota slot AND the destination-deterministic callback door every
 * future open to that `host:port:user` needs. Each ref goes through the
 * supervisor's own `close`: the GROUP dies first (the record write is bare
 * sync fs and a disk fault must never spare the kill - round-4 review
 * MINOR2), and the death on the way down is then never reported as a loss
 * through a socket that could not deliver it anyway (the `stopping` latch
 * is what keeps it quiet, not the record; the `emitBytes` catch is the only
 * self-heal this transport had, and `commandWs.send` swallows into a log
 * line while no socket is attached, so an idle session could never fire
 * it); the `closed` record is best-effort after. The destination's tmux
 * server and its panes are untouched (the
 * runtime-serve's own shutdown stops tails and doors only, design §6); the
 * door paths free with the serve, so the next open can bind. Never BUILDS a
 * supervisor: a node that never brokered pays nothing here.
 *
 * @returns how many sessions were drained (0 is the common no-SSH answer)
 */
export function drainBrokeredSessions(dataDir: string): number {
  const sup = peekSshSessionSupervisor(dataDir);
  if (sup === undefined) return 0;
  let drained = 0;
  // ONE ref's throw costs ONE close (review m-A): `close` writes a record
  // file, and ENOSPC/EROFS/EACCES are ordinary on a real disk. This runs on
  // the daemon's reconnect path, so aborting the loop here would strand
  // every remaining child AND (with the caller's guard) the node's link.
  for (const ref of sup.liveRefs()) {
    try {
      sup.close(ref);
      drained += 1;
    } catch (err) {
      log(`ssh-session ${ref.slice(0, 8)} drain close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return drained;
}

/** Execute `ssh_session_send`: one base64 write to the child's stdin. */
export async function execSshSessionSend(ctx: CommandContext, cmd: Cmd<"ssh_session_send">): Promise<CommandResult> {
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const bytes = Buffer.from(cmd.data_b64, "base64");
  const answer = sup.send(cmd.ref, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return answer === "ok" ? { ok: true } : { ok: false, error: SSH_SESSION_UNKNOWN };
}

/** Execute `ssh_session_close`: bounded-grace group stop, `closed` recorded. */
export async function execSshSessionClose(ctx: CommandContext, cmd: Cmd<"ssh_session_close">): Promise<CommandResult> {
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const answer = sup.close(cmd.ref);
  return answer === "ok" ? { ok: true } : { ok: false, error: SSH_SESSION_UNKNOWN };
}
