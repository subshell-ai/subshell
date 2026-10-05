import { getSshSessionSupervisor } from "@internal/pane-runtime";
import {
  isSshSessionRef,
  type JsonValue,
  parseNodeSshSessionOpenResult,
  SSH_SESSION_UNKNOWN,
  type SshSessionOpenResultWire,
} from "@internal/subshell-protocol";
import { log } from "../log.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
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
export async function execSshSessionOpen(ctx: CommandContext, cmd: Cmd<"ssh_session_open">): Promise<CommandResult> {
  if (!isSshSessionRef(cmd.ref)) return { ok: false, error: "run_unknown" };
  const sup = await supervisor(ctx);
  if ("missing" in sup) return { ok: false, error: "ssh binary missing: ssh" };
  const outcome = await sup.open(
    { ref: cmd.ref, target: cmd.target, runtimeCommand: cmd.runtimeCommand ?? "subshell" },
    {
      emitBytes: async (chunk): Promise<void> => {
        // Backpressure mirrors the tail pump: throttle BEFORE sealing each
        // chunk, and a dead socket (send throws) stops the session the same
        // way it stops a tail - the child's group goes with it.
        let attempts = 0;
        while ((ctx.ws.bufferedAmount ?? 0) > TAIL_BACKPRESSURE_BYTES && attempts < 600) {
          await Bun.sleep(TAIL_BACKPRESSURE_POLL_MS);
          attempts += 1;
        }
        try {
          ctx.ws.send({ type: "session_frame", ref: cmd.ref, data_b64: Buffer.from(chunk).toString("base64") });
        } catch {
          sup.close(cmd.ref);
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
  const validated = parseNodeSshSessionOpenResult(outcome.result as unknown as SshSessionOpenResultWire);
  if (validated === null) return { ok: false, error: "malformed session open result" };
  return { ok: true, data: validated as unknown as JsonValue };
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
