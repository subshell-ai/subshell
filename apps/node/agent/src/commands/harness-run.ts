import { runBounded, summarizeBoundedRun } from "@internal/pane-runtime";

/**
 * One harness CLI line, run on this machine under the installer bounds.
 *
 * Shared by `harness_update` (protocol 28) and `harness_install` (protocol 29):
 * an update is the same kind of package-manager run as an install, so both get
 * the identical environment, deadline and answer shape.
 *
 * The line arrives from the control plane because the node has held no plugin
 * manifests since the inversion (spec 2026-09-10 §6). An update line is the
 * manifest's `subshell.update.command`, or its `install.command` when the
 * installer doubles as the updater; an install line is the built-in manifest's
 * `install.command`. The manifest parser refuses a line that needs privileges,
 * and the host has no terminal to answer a password prompt anyway.
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
 * failure: the run happened and said no, which is what the person pressing
 * the button needs to see. Only a transport/infrastructure throw surfaces as
 * the dispatch layer's `{ ok: false }`.
 */

/** The installer budget, reused: an install and an update are the same kind of run. */
const HARNESS_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs one harness line and shapes its answer.
 * @param harnessId - the harness plugin id, echoed back to the plane
 * @param command - the manifest's shell line
 * @param label - what timed out ("update", "installer"), for the marker's wording
 */
export async function runHarnessLine(harnessId: string, command: string, label: "update" | "installer") {
  const result = await runBounded(["sh", "-c", command], { timeoutMs: HARNESS_RUN_TIMEOUT_MS });
  return {
    ok: true as const,
    data: { harnessId, ...summarizeBoundedRun(result, HARNESS_RUN_TIMEOUT_MS, label) },
  };
}
