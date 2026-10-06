import { parseNodeStatDirResult } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SshRuntimeCommandError, type SshRuntimeSession } from "./session.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";
import { SshRuntimeRefusal } from "./sessions.service.js";

/**
 * The F3 launch-directory gate (design 2026-10-05 §7): both launch verbs
 * stat-verify their `cwd` ON THE DESTINATION through this one function before
 * any plane write, so "terminal" and "harness" can never disagree about what
 * a valid working directory means. Extracted from `sessions-lifecycle.ts`;
 * the verbs own everything after the gate (the row/token/frame order).
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);

/**
 * Stat-verify a launch `cwd` ON THE DESTINATION before any plane write
 * (design §7: an invalid directory names the remedy). The node-link's own
 * pre-launch rule (`validateWorkingDir` -> the shared `stat_dir` executor),
 * run through the session's framed channel: a missing path or a non-directory
 * refuses `dir_missing` with 409 BEFORE the row exists, so no launch ever
 * writes a row whose workingDir the shell silently fell back from (the tmux
 * fallback to `~` was F3's lying 200). On success the REALPATH returns, and
 * the row and the launch frame carry it - the manager's resolved-dir rule,
 * one layer across the SSH hop.
 *
 * @throws SshRuntimeRefusal 409 `dir_missing` (refused value), 502 (a
 *         malformed answer); anything else (a dead session, a timeout) rides
 *         out as the command error it is, like every other framed verb.
 */
export async function resolveDestinationDir(session: SshRuntimeSession, cwd: string): Promise<string> {
  let resolved: string;
  try {
    const data = await session.command({ type: "stat_dir", ref: crypto.randomUUID(), path: cwd }, 10_000);
    const parsed = parseNodeStatDirResult(data);
    if (parsed === null) {
      throw new SshRuntimeRefusal(502, "the runtime answered the directory check with a malformed payload");
    }
    resolved = parsed.path;
  } catch (err) {
    if (
      err instanceof SshRuntimeCommandError &&
      (err.detail.startsWith("ENOENT:") || err.detail.startsWith("ENOTDIR:"))
    ) {
      throw new SshRuntimeRefusal(
        409,
        `${cwd} does not exist on the destination (or is not a directory). Choose an existing folder on the destination disk.`,
        "dir_missing",
      );
    }
    throw err;
  }
  void sessionsRepo.touch(session.id).catch(() => {});
  return resolved;
}
