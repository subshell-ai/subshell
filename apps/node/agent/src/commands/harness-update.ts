import { runBounded, summarizeBoundedRun } from "@internal/pane-runtime";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `harness_update` (protocol 28): run one harness CLI's own update line on
 * this machine.
 *
 * The line arrives from the control plane because the node has held no plugin
 * manifests since the inversion (spec 2026-09-10 §6). What the plane may send
 * is the manifest's `subshell.update.command`, or its `install.command` when
 * the installer doubles as the updater; the manifest parser refuses a line
 * that needs privileges, and the host has no terminal to answer a password
 * prompt anyway.
 *
 * The bounds are `runBounded`'s, the same ones every installer gets: an
 * allowlisted environment (never this process's, which holds the node's
 * bearer token and secrets), a login-shell PATH, closed stdin so a prompt
 * hits the deadline rather than hanging, a ten-minute deadline with reader
 * cancellation so a pipeline's orphans cannot hold it open, and a 64 KiB
 * capture cap per stream. `sh -c` because the manifest's command is a shell
 * LINE (`curl … | sh`, `npm i -g …`) and not an argv.
 *
 * A non-zero exit is a RESULT (`ok:false` inside `data`), not a command
 * failure: the update ran and said no, which is what the person pressing the
 * button needs to see. Only a transport/infrastructure throw surfaces as the
 * dispatch layer's `{ ok: false }`.
 */

/** The installer budget, reused: an update is the same kind of run. */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export async function execHarnessUpdate(_ctx: CommandContext, cmd: Cmd<"harness_update">): Promise<CommandResult> {
  const result = await runBounded(["sh", "-c", cmd.command], { timeoutMs: UPDATE_TIMEOUT_MS });
  return {
    ok: true,
    data: { harnessId: cmd.harnessId, ...summarizeBoundedRun(result, UPDATE_TIMEOUT_MS, "update") },
  };
}
