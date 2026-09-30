import { afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { TmuxRunner } from "../../tmux-runner.js";

/**
 * Shared fixture for the three files this suite was split into (issue #261
 * round 2): under `--parallel` one file is one worker, so the single 1195-line
 * file set the package's wall-clock floor. Every module here is per-file under
 * isolation, which is exactly right: each split file reaps its own sockets.
 */
export const runner = new TmuxRunner();

/**
 * Sockets of every server these files spawn. Tests historically tracked only the
 * most recent socket and killed only the SUBSHELL — a mid-test assertion failure
 * skipped the kill, and a pane blocked on `read` outlived the suite (the server
 * never exits while a subshell lives). `afterAll` now reaps WHOLE servers for
 * every socket spawned here, so a failing test cannot leak a daemon.
 */
const spawnedSockets = new Set<string>();

/** Per-file counter behind `freshSocket`'s uniqueness. Exported as a live
 * binding (read, never assigned) for the one test that names a temp file off
 * the same counter. */
export let socketSeq = 0;

/**
 * Returns a fresh unique socket name, already registered for the afterAll
 * reaper. mktemp `-u`-style uniqueness (pid + ms + per-file counter): two
 * suites running in parallel — or two `freshSocket` calls inside one
 * millisecond — can never collide on a live server.
 */
export function freshSocket(kind: string): string {
  socketSeq += 1;
  const socket = `subshell-test-${kind}-${process.pid}-${Date.now()}-${socketSeq}`;
  spawnedSockets.add(socket);
  return socket;
}

/**
 * Polls until `file` contains `needle`, returning its contents.
 *
 * Used instead of a fixed sleep for assertions that wait on tmux's
 * `pipe-pane` flushing through `cat >> file`: there is no interval worth
 * hardcoding, and on failure this reports what the file actually held.
 */
export async function waitForFileToContain(file: string, needle: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    if (last.includes(needle)) return last;
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} in ${file}; saw ${JSON.stringify(last)}`,
  );
}

/**
 * Writes an executable stub in a temp dir and returns both paths. The
 * caller `rmSync`s the directory; nothing real is spawned.
 */
export function writeStub(script: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "subshell-tmux-async-"));
  const path = join(dir, "tmux-stub");
  writeFileSync(path, script, { mode: 0o755 });
  return { dir, path };
}

/**
 * Issue #244 frames: [typed payload, argv element the fix must spawn]. Only
 * payloads ending in `;` change; the rest pass through byte-identical. The
 * `a\;` and `a\\;` rows are where the rule is load-bearing: the parser's
 * restore eats exactly ONE preceding backslash, so the encoder adds exactly
 * one — enough to shield the payload's own backslashes, never one too many.
 * Consumed by both the stub-argv pin and the real-tmux delivery test.
 */
export const semicolonFrames: Array<{ payload: string; encoded: string }> = [
  { payload: ";", encoded: "\\;" },
  { payload: ";;", encoded: ";\\;" },
  { payload: "x;", encoded: "x\\;" },
  { payload: "a\\;", encoded: "a\\\\;" },
  { payload: "a\\\\;", encoded: "a\\\\\\;" },
  { payload: "a;b", encoded: "a;b" },
  { payload: ";x", encoded: ";x" },
  { payload: "y;;z", encoded: "y;;z" },
];

afterAll(async () => {
  // kill-server (not kill-session) on every socket this file touched: tears
  // the daemon down even when a failed assertion skipped the per-test kill.
  // Already-dead sockets error out; that is expected and ignored.
  //
  // Then UNLINK, because killing the server does not remove its socket file —
  // that is the same leak `cleanSocket` exists to close in production, and
  // these suites have no throwaway `TMUX_TMPDIR` the way the server's does, so
  // their sockets land in the developer's real tmux dir and stayed there. A few
  // hundred had accumulated by 2026-09-15.
  const runner = new TmuxRunner();
  for (const socket of spawnedSockets) {
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    await runner.cleanSocket(socket);
  }
  spawnedSockets.clear();
});
