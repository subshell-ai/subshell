import { existsSync } from "node:fs";
import { runSshProcess, sshChildPath } from "@internal/pane-runtime";
import { type JsonValue, parseNodeSshHostKey, type SshHostKeyCommand } from "@internal/subshell-protocol";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext, CommandResult } from "./context.js";
import { knownHostsPath, resolveSshKeygenBin, SSH_GATE_REFUSAL } from "./ssh-shared.js";

/**
 * `ssh_host_key` (spec 2026-10-08 §9, Task 12): answer with the
 * `known_hosts` entries this machine has recorded for ONE resolved
 * destination, so the plane can capture the pin that later rides the
 * relay-open to B.
 *
 * The evaluator is OpenSSH's own `ssh-keygen -F`, not a hand-rolled parse.
 * known_hosts matching (pattern globs, the `[host]:port`
 * spelling, hashed entries) is OpenSSH's own logic; anything less is the
 * loose re-parse the design refuses. The `-F` query uses the destination
 * port's exact lookup name, and the answer is deduped by line - A's
 * recorded trust, verbatim, never a reconstruction of it.
 *
 * The three rules this arm keeps, shared with the roster read:
 * - **The gate speaks first.** Reading the account's trust file is an SSH
 *   act; a machine whose mirror is not ON refuses {@link SSH_GATE_REFUSAL}
 *   before any lookup or spawn.
 * - **Fail closed, never fabricate.** No ssh-keygen, an unreadable file, a
 *   timeout, or an answer the grammar rejects each answer `ok:false` with a
 *   named error. The ABSENT case is the one `ok:true` answer that carries
 *   nothing: no `known_hosts` file, or a file with no entry for this
 *   destination, is the honest fact "A has recorded nothing" - and the
 *   capture service fails grant creation closed on exactly that empty
 *   answer, which is why the emptiness is reported as a fact and never as
 *   an error the caller might paper over.
 * - **No audit row, no logging of the bytes.** The durable record of a pin
 *   is the `node.ssh_host_pin.create` row the CAPTURE ACT writes, naming the
 *   destination and a fingerprint only; this command is the question, and a
 *   question writes nothing. The key bytes are public material, but they
 *   belong in the pin row and the relay command, not in this machine's log.
 */

/** Test seams for {@link execSshHostKey} (production omits all three). */
export interface HostKeySeams {
  /** Where ssh-keygen is; defaults to this machine's own lookup ladder. */
  resolveKeygenBin?: () => Promise<string | null>;
  /** The trust file to read; defaults to the connecting account's `~/.ssh/known_hosts`. */
  trustFile?: () => string;
  /** One ssh-keygen run; defaults to {@link runSshProcess}. The seam's contract: absolute argv[0], full child env, deadline. */
  runProcess?: typeof runSshProcess;
}

/**
 * OpenSSH records host trust independently of the login account. Port 22
 * uses the bare hostname (unbracketed IPv6); other ports use `[host]:port`.
 * Looking up the bare host as well at a non-default port can capture another
 * sshd's key or reject two valid services as ambiguous.
 */
export function sshHostKeyCandidates({ host, port }: SshHostKeyCommand): string[] {
  const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return [port === 22 ? hostname : `[${hostname}]:${port}`];
}

/**
 * One ssh-keygen -F run against one candidate, stdout split into entry lines.
 * ssh-keygen precedes each found entry with a `# Host x found: line N`
 * comment; those and blanks are the only lines the file's OWN entries are
 * not, and both are dropped here. Non-zero exit with no output is OpenSSH's
 * spelling of "this candidate matched nothing" (and of an unreadable file -
 * the caller distinguishes those by whether ANY candidate produced bytes
 * and by the stderr it reports); non-zero with output still yields its
 * entries.
 */
function entryLines(stdout: string): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    lines.push(line);
  }
  return lines;
}

/** Execute `ssh_host_key` for one destination. */
export async function execSshHostKey(
  ctx: CommandContext,
  cmd: SshHostKeyCommand,
  seams?: HostKeySeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  const keygen = await (seams?.resolveKeygenBin ?? resolveSshKeygenBin)();
  if (keygen === null) return { ok: false, error: "ssh-keygen binary missing: ssh-keygen" };
  const trustFile = (seams?.trustFile ?? knownHostsPath)();
  // An absent trust file is not an error to throw around - it is the common
  // honest case (a machine that has never connected anywhere), reported as
  // the empty fact so the capture's fail-closed branch, not a transport
  // failure, is what the operator's screen names.
  if (!existsSync(trustFile)) {
    const validated = parseNodeSshHostKey({ lines: [] });
    if (validated === null) return { ok: false, error: "malformed host-key answer" };
    return { ok: true, data: validated as unknown as JsonValue };
  }
  const runProcess = seams?.runProcess ?? runSshProcess;
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    PATH: await sshChildPath(),
  };
  const found = new Set<string>();
  let sawReadFailure = false;
  for (const candidate of sshHostKeyCandidates(cmd)) {
    // `-f <file>` (NOT `-F file`): the search target spelled as OpenSSH's
    // own usage prints, so the read never depends on whose HOME the daemon
    // was launched under. stdin ignored, streams captured - runSshProcess's
    // short-RPC posture, the same one `ssh -G` resolution runs under.
    const run = await runProcess([keygen, "-f", trustFile, "-F", candidate], env, 10_000);
    if (run.spawnError) return { ok: false, error: "ssh-keygen could not be started on this machine" };
    if (run.timedOut) return { ok: false, error: "ssh-keygen did not finish within the deadline" };
    if (run.code !== 0 && run.stdout.trim() === "") {
      // Non-zero AND silent: "no match" (normal, keep looking) is
      // indistinguishable from "cannot read the file" only by stderr, and
      // the file's readability was not claimed - so an unreadable file must
      // not read as "A recorded nothing". No log line is written here: the
      // refusal below names the cause to the plane, which is the whole
      // record this arm keeps.
      sawReadFailure = sawReadFailure || run.stderr.trim() !== "";
      continue;
    }
    for (const line of entryLines(run.stdout)) found.add(line);
  }
  if (found.size === 0 && sawReadFailure) {
    return { ok: false, error: "the known_hosts trust file could not be read on this machine" };
  }
  const validated = parseNodeSshHostKey({ lines: [...found] });
  if (validated === null) return { ok: false, error: "malformed host-key answer" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: validated as unknown as JsonValue };
}
