import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  buildSshInvocation,
  classifySshFailure,
  ensureSshDirs,
  renderSshConfigContents,
  runSshProcess,
  sshChildEnv,
} from "@internal/pane-runtime";
import { parseNodeSshTestOutcome, SSH_PROBE_DEADLINE_MS } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { connectingHomeDir, resolveSshBin } from "./ssh-shared.js";

/**
 * The `ssh_test_connection` executor (SSH-SUPPORT.md §3: "Connection testing
 * uses a fixed benign probe, not caller-supplied command text").
 *
 * The probe is the string `true`, compiled in here — NOTHING in this contract
 * lets a caller name the remote command under the probe's identity. It is
 * also NOT a run: no run id, no dedup record, no output store; a throwaway
 * rendered config file under `<dataDir>/ssh/probes/` (0600, O_EXCL,
 * O_NOFOLLOW on open, deleted before the answer goes out) is the only disk
 * it touches. The §3 table's 30-second overall deadline is the whole budget:
 * connect, run `true`, exit.
 *
 * Failure honesty: `passed:false` must name a code (the wire validator
 * refuses a nameless failure), the classifier's `connection_failed` fallback
 * is the frozen "no more specific reason" code, and a timed-out probe is a
 * failed probe — never a retry, the no-automatic-replay rule applies to the
 * human pressing the button too.
 */

/** The one probe command. Not a parameter, by contract. */
const FIXED_PROBE_COMMAND = "true";

export async function execSshTestConnection(
  ctx: CommandContext,
  cmd: Cmd<"ssh_test_connection">,
): Promise<CommandResult> {
  const sshBin = await resolveSshBin();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  ensureSshDirs(ctx.config.dataDir);
  const probeDir = join(ctx.config.dataDir, "ssh", "probes");
  const dirExisted = existsSync(probeDir);
  mkdirSync(probeDir, { recursive: true });
  // mkdir's mode option is umask-masked: re-tighten after a fresh create.
  if (!dirExisted) chmodSync(probeDir, 0o700);
  const configPath = join(probeDir, `${randomUUID()}.config`);
  // O_EXCL + O_NOFOLLOW + 0600: the probe file cannot pre-exist as anything,
  // cannot be a symlink, and cannot be readable by the machine's other eyes.
  const fd = openSync(
    configPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, renderSshConfigContents(cmd.snapshot));
  } finally {
    closeSync(fd);
  }
  try {
    const argv = buildSshInvocation({
      sshBin,
      snapshot: cmd.snapshot,
      configPath,
      remoteCommand: FIXED_PROBE_COMMAND,
    });
    const env = await sshChildEnv(cmd.snapshot, connectingHomeDir());
    const run = await runSshProcess(argv, env, SSH_PROBE_DEADLINE_MS);
    const outcome =
      run.code === 0
        ? { passed: true }
        : {
            passed: false as const,
            code: (run.timedOut ? null : classifySshFailure(run.stderr)) ?? ("connection_failed" as const),
          };
    const validated = parseNodeSshTestOutcome(outcome);
    if (validated === null) return { ok: false, error: "malformed test outcome" };
    return { ok: true, data: validated };
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // the probe file is transient by construction; a lingering 0600
      // rendered config is swept with the ssh subtree by retention.
    }
  }
}
