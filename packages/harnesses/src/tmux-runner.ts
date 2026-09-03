import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "bun";
import { shellQuote } from "./shell.js";

/**
 * Thin wrapper around the `tmux` binary.
 *
 * Each subshell gets its own tmux server via a unique socket (`-L`), so
 * subshell commands never collide and a crash of one tmux server can't take
 * down another. We use `-L <name>` (default socket dir under /tmp), which
 * keeps cleanup simple (killing the last subshell removes the socket dir).
 */
/** Attempts {@link TmuxRunner.newSubshell} adds when it loses the server-shutdown race. */
const NEW_SESSION_RACE_RETRIES = 3;
/** Pause between those attempts — long enough for the dying server to release its socket. */
const NEW_SESSION_RACE_BACKOFF_MS = 60;

/**
 * Whether a failed tmux command is the "the server was shutting down as I
 * connected" race rather than a real refusal (see
 * {@link TmuxRunner.newSubshell}). Matched on tmux's own wording, which covers
 * both the server dying mid-request and the socket going stale under it.
 */
function isServerShutdownRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /server exited unexpectedly|error connecting to .*(No such file|Connection refused)/i.test(message);
}

export class TmuxRunner {
  readonly #tmuxBinary: string;

  constructor(tmuxBinary = "tmux") {
    this.#tmuxBinary = tmuxBinary;
  }

  /** Runs a tmux command, throwing with stderr on non-zero exit. */
  run(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; input?: string } = {},
  ): { stdout: string; stderr: string } {
    // Array-form spawnSync (the object form's generics don't accept a
    // `string | undefined` stdin under TS 7/bun-types).
    const proc = spawnSync([this.#tmuxBinary, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.input as never,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout?.toString() ?? "";
    const stderr = proc.stderr?.toString() ?? "";
    if (proc.exitCode !== 0) {
      throw new TmuxError(stderr.trim() || `tmux ${args[0]} failed (exit ${proc.exitCode})`);
    }
    return { stdout, stderr };
  }

  /** True if a subshell with the given name exists on the socket. */
  hasSubshell(socket: string, subshellName: string): boolean {
    try {
      this.run(["-L", socket, "has-session", "-t", subshellName], {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lists every subshell name on the socket in ONE spawn. KEPT as a public
   * `TmuxRunner` API with no production caller (tests only): the agent's
   * shared exit watcher batches through {@link listSubshellsChecked} — the
   * same probe with the failure kept — and the connect-time `subshells_report`
   * census probes per recorded row via {@link hasSubshell}.
   *
   * Swallows errors like {@link hasSubshell}: a socket whose server died (or
   * never existed) simply has no live subshells, so `[]` — callers reading it
   * as "everything on this socket is gone" get exactly the answer a failed
   * `has-session` would give. Subshell names cannot contain newlines, so the
   * line split is unambiguous.
   */
  listSubshellNames(socket: string): string[] {
    try {
      const out = this.run(["-L", socket, "list-sessions", "-F", "#{session_name}"], {});
      return out.stdout.split("\n").filter((line) => line !== "");
    } catch {
      return [];
    }
  }

  /**
   * {@link listSubshellNames} with the failure kept: the SAME `list-sessions`
   * probe, but the answer is tri-state — `{ ok: true; names }` only when tmux
   * actually answered, `{ ok: false; detail }` on spawn failure, signal, or
   * non-zero exit (`detail` carries tmux's stderr, or an exit-code summary
   * when stderr was empty).
   *
   * WHY it exists (design 2026-09-02 §1): swallowing errors into `[]` makes a
   * probe BLIP (fork failure, EINTR, overloaded server) indistinguishable
   * from a dead server, and the exit watcher cannot tell a live pane from a
   * gone one on that answer alone — a blip used to report live panes dead.
   * The watcher counts consecutive `ok:false` ticks instead. `listSubshellNames`
   * stays as a public API (its only callers are tests); the connect-time
   * census is not a list probe — `buildSubshellsReport` checks each recorded
   * row via {@link hasSubshell}.
   */
  listSubshellsChecked(socket: string): { ok: true; names: string[] } | { ok: false; detail: string } {
    try {
      const out = this.run(["-L", socket, "list-sessions", "-F", "#{session_name}"], {});
      return { ok: true, names: out.stdout.split("\n").filter((line) => line !== "") };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Reads the main pane's exit status; null when not dead/unknown.
   *
   * tmux 3.6 exposes the dead-pane exit status as `#{pane_dead_status}`
   * (with `#{pane_dead}` = 1). Panes that exited fully without remain-on-exit
   * cause the server to exit, so `run` throws and we return null.
   */
  paneExitCode(socket: string, subshellName: string): number | null {
    try {
      // Query the subshell's own pane explicitly (-t) so the read is
      // well-defined even if the socket ever hosts more than one subshell.
      const out = this.run(
        ["-L", socket, "display-message", "-t", subshellName, "-p", "#{pane_dead}:#{pane_dead_status}"],
        {},
      );
      const [dead, status] = out.stdout.trim().split(":");
      if (dead !== "1") return null;
      // Preserve a clean exit (code 0) as a real code rather than collapsing
      // it to null; empty status stays null (unknown).
      return status === "" ? null : Number(status);
    } catch {
      return null;
    }
  }

  /**
   * Reads the pane's terminal-reported title and the command running in it.
   *
   * `#{pane_title}` is what an inner program sets via OSC 0/2 (Claude Code
   * titles the pane after the current task). When nobody has set a title,
   * tmux reports the running command (or the host name) instead — so the
   * pair is returned and callers compare them to tell "the harness published
   * a title" from "no title yet". Read as TWO separate `display-message`
   * calls on purpose: a printable separator in one format string cannot be
   * trusted (a title may contain it), and tmux 3.5a escapes control chars in
   * format output while 3.6 does not — a real US-delimited probe was green
   * on the host and garbage in the container. Returns null when the pane is
   * gone or tmux errors.
   */
  paneTitle(socket: string, subshellName: string): { title: string; command: string } | null {
    const read = (field: string): string | null => {
      try {
        return this.run(["-L", socket, "display-message", "-t", subshellName, "-p", field], {}).stdout.replace(
          /\n$/,
          "",
        );
      } catch {
        return null;
      }
    };
    const title = read("#{pane_title}");
    if (title === null) return null;
    return { title, command: read("#{pane_current_command}") ?? "" };
  }

  /**
   * Creates a new detached subshell running `cmd` in `cwd`.
   *
   * Retries through the SERVER-SHUTDOWN RACE. Killing a socket's last subshell
   * makes its tmux server exit, but the socket file outlives the decision by
   * a moment: a `new-session` that connects in that window is answered by a
   * server already on its way out, which dies under the client — `tmux` exits
   * non-zero with "server exited unexpectedly" and NO subshell is created.
   * Nothing is wrong with the request; running it again a moment later starts
   * a fresh server and succeeds.
   *
   * This is the terminate-then-restart path (`restartSubshell` reuses the row's
   * socket, and the kill immediately precedes the spawn), where it is
   * reproducible rather than rare — a bare four-command tmux script hits it
   * 5/5. Left unhandled it surfaces as a restart that throws while the row
   * rolls back to `terminated`, i.e. a restart button that just fails.
   */
  newSubshell(socket: string, subshellName: string, cwd: string, cmd: string): void {
    const args = ["-L", socket, "new-session", "-d", "-s", subshellName, "-c", cwd, cmd];
    for (let attempt = 0; ; attempt++) {
      try {
        this.run(args, {});
        return;
      } catch (err) {
        // Only the shutdown race is retried, and only within the budget: any
        // other failure (bad cwd, duplicate name, tmux missing) is a real
        // answer the caller must see immediately, not after a stall.
        if (attempt >= NEW_SESSION_RACE_RETRIES || !isServerShutdownRace(err)) throw err;
        Bun.sleepSync(NEW_SESSION_RACE_BACKOFF_MS);
      }
    }
  }

  /** Redirects all pane output to a file (live streaming). */
  pipePane(socket: string, subshellName: string, outputFile: string): void {
    // The command runs in tmux's shell (`sh -c`), so the path must be
    // POSIX-single-quoted. The previous JSON.stringify-based escaping did
    // NOT neutralize `$`, backticks or `;` — JSON string escaping and shell
    // quoting are different languages. shellQuote is the same quoter the
    // pane commands are baked with (canonical source: @internal/harnesses).
    this.run(["-L", socket, "pipe-pane", "-t", subshellName, "-o", `cat >> ${shellQuote(outputFile)}`], {});
  }

  /**
   * Resizes the subshell's window to the client terminal's dimensions.
   *
   * Detached tmux subshells are created at 80×24; without this, the pane's
   * layout (and any full-screen TUI like Claude Code's welcome box) renders
   * at 80×24 even when the attached terminal is larger. Called on WS attach
   * and on every client-side resize.
   */
  resizeWindow(socket: string, subshellName: string, cols: number, rows: number): void {
    this.run(["-L", socket, "resize-window", "-t", subshellName, "-x", String(cols), "-y", String(rows)], {});
  }

  /**
   * Writes raw terminal input to the subshell's pane, byte for byte.
   *
   * This is a dumb pipe: the client's terminal already emits the exact bytes
   * the pane's process expects (`\r` for Enter, `\x1b[A` for arrow-up,
   * `\x04` for Ctrl-D), so nothing here may add, drop or translate a byte.
   * In particular no Enter is appended — input arrives one keystroke at a
   * time, and submitting each one would turn "hello" into five prompts.
   *
   * `-l` disables tmux's key-name lookup, so text that happens to look like
   * a key name ("Enter", "C-c") or an escape ("a\\nb") stays literal, and
   * `--` keeps input beginning with "-" from being read as a flag.
   */
  sendInput(socket: string, subshellName: string, input: string): void {
    if (!input) return;
    this.run(["-L", socket, "send-keys", "-t", subshellName, "-l", "--", input], {});
  }

  /** Presses Enter (submits whatever is at the prompt). */
  pressEnter(socket: string, subshellName: string): void {
    this.run(["-L", socket, "send-keys", "-t", subshellName, "Enter"], {});
  }

  /**
   * Captures the pane's current visible content with escape sequences.
   *
   * With `scrollbackLines`, also prepends up to that many rows of the pane's
   * history (`-S -N`) — tmux's own reflowed, already-rendered text, so the
   * rows carry the same SGR-only shape as the visible grid and replay cleanly
   * at ANY geometry. Without it, only the visible grid is captured (preview/
   * settle callers never wanted history bytes).
   */
  capturePane(socket: string, subshellName: string, scrollbackLines?: number): string {
    const args = ["-L", socket, "capture-pane", "-p", "-e", "-t", subshellName];
    if (scrollbackLines && scrollbackLines > 0) args.push("-S", `-${scrollbackLines}`);
    const res = this.run(args, {});
    return res.stdout;
  }

  /** Terminates a subshell (also kills the harness process tree). */
  killSubshell(socket: string, subshellName: string): void {
    try {
      this.run(["-L", socket, "kill-session", "-t", subshellName], {});
    } catch {
      // already gone
    }
  }

  /** Deletes the socket file for a dead subshell (best-effort). */
  cleanSocket(socket: string): void {
    const socketPath = join(process.env.TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? ""}`, socket);
    Bun.file(socketPath)
      .unlink()
      .catch(() => {});
  }
}

/** Derives a stable, unique tmux socket name for a subshell id. */
export function tmuxSocketFor(subshellId: string): string {
  const hash = createHash("sha1").update(subshellId).digest("hex").slice(0, 12);
  return `subshell-${hash}`;
}

class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}
