import { readCommandBounded } from "./bounded-exec.js";

/**
 * Reading a harness's version without letting it wedge the caller.
 *
 * Every plugin's `getVersion` spawned `<binary> --version` and, until this
 * existed, none had a deadline. The surfaces that call it are polled (the
 * harness list refetches; a node re-check probes every plugin), so one binary
 * that blocks on a prompt, a lock or a network call held a request open
 * indefinitely. A version is a nice-to-have, so the right answer to a slow one
 * is to stop asking. {@link readCommandBounded} is what makes the deadline
 * real, and its docstring records why the obvious spelling is not.
 *
 * **The exit code is deliberately ignored**, because the five implementations
 * this replaced ignored it. A tool that prints `1.2.3` and exits non-zero is
 * odd, but its version is still the best answer available, and tightening that
 * would be a silent behaviour change riding along with a timeout fix.
 */

/** How long a version probe may take before it is abandoned. */
export const VERSION_PROBE_TIMEOUT_MS = 4000;

/**
 * How much a version probe may print before it is abandoned.
 *
 * The size twin of the timeout (final review R15): a real version string is a
 * line or two, so 4 KiB is orders past anything legitimate, and printing
 * more means the tool is not answering the question. Without the cap, the
 * raw text rides a `detect` answer inside one result frame — and the node
 * link caps every frame at 1 MiB, so a megabyte-scale `--version` is a lost
 * detect round trip (the answer is dropped or refused, the node's socket is
 * the thing at stake) paid for by a fact that is a nice-to-have. The choice
 * made here: on exceed, the CHILD IS KILLED and the probe answers `null` —
 * the truncation boundary could cut a version string in half, and a half a
 * version is not a version worth storing.
 */
export const VERSION_PROBE_MAX_BYTES = 4096;

/**
 * Runs `<binary> <args>` and returns its trimmed stdout.
 *
 * Total: a missing binary, empty output, a timeout, and an over-cap answer
 * all answer `null`. The caller has already established the binary exists,
 * so there is nothing here an operator would act on.
 * @param binary - absolute path to the executable
 * @param args - version arguments (default `["--version"]`)
 * @param timeoutMs - deadline (default {@link VERSION_PROBE_TIMEOUT_MS})
 */
export async function probeVersion(
  binary: string,
  args: string[] = ["--version"],
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const result = await readCommandBounded([binary, ...args], timeoutMs, VERSION_PROBE_MAX_BYTES);
  if (!result || result.truncated) return null;
  return result.text.trim() || null;
}
