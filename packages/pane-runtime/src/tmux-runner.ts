import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "bun";
import { shellQuote } from "./shell.js";

/**
 * Thin wrapper around the `tmux` binary.
 *
 * Each subshell gets its own tmux server via a unique socket (`-L`), so
 * subshell commands never collide and a crash of one tmux server can't take
 * down another. We use `-L <name>` (default socket dir under /tmp), which
 * keeps cleanup simple (killing the last subshell removes the socket dir).
 */
/**
 * How long {@link TmuxRunner.runAsync} waits for a tmux command before killing
 * it and rejecting.
 *
 * A deadline is what the synchronous form never needed: `spawnSync` blocked
 * the process, so a wedged tmux was a hang somebody noticed immediately.
 * Asynchronously it is silent and much worse — the promise never settles, so
 * a keystroke is neither delivered nor reported, the pane's input chain never
 * drains, and every later keystroke for that pane queues behind it. One
 * pane's keyboard simply stops, with nothing in the log.
 *
 * 15 s is chosen to be far outside any honest tmux command (the pane path's
 * commands are single-digit milliseconds) while still bounding the failure:
 * this is the "tmux will never answer" case, not a slow one.
 */
export const TMUX_COMMAND_TIMEOUT_MS = 15_000;

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

  /**
   * Tail of each pane's in-flight input chain, keyed by socket + session.
   *
   * See {@link TmuxRunner.sendInput}: the pane-input commands are async, and
   * async spawns complete out of order, so "hello" typed as five frames can
   * reach tmux as "hlelo". One chain PER PANE — never one global lock — so a
   * pane whose tmux server is wedged cannot stall another's keystrokes, which
   * is the whole point of the commands being async in the first place.
   *
   * The stored promise is the SETTLED chain (never rejecting), so one failed
   * `send-keys` cannot poison every later keystroke on that pane; the promise
   * handed back to the caller still rejects. Entries delete themselves once
   * the pane's queue drains, so a long-lived server does not keep a chain per
   * pane it has ever touched.
   */
  readonly #inputChains = new Map<string, Promise<void>>();

  /** Deadline for every {@link runAsync} call on this instance. */
  readonly #timeoutMs: number;

  /**
   * @param tmuxBinary - the tmux executable (tests point this at a stub)
   * @param opts.timeoutMs - override {@link TMUX_COMMAND_TIMEOUT_MS}; only
   *   tests pass one, so a deadline case need not take 15 seconds to assert
   */
  constructor(tmuxBinary = "tmux", opts: { timeoutMs?: number } = {}) {
    this.#tmuxBinary = tmuxBinary;
    this.#timeoutMs = opts.timeoutMs ?? TMUX_COMMAND_TIMEOUT_MS;
  }

  /**
   * Runs a tmux command WITHOUT blocking the event loop, throwing with stderr
   * on non-zero exit — the async twin of {@link run}.
   *
   * Every tmux command used to be `Bun.spawnSync`, and on a loaded host that
   * is a whole-process stall: measured 2026-09-14 at 60-70 ms per spawn under
   * load average ~55, during which every attached pane's 50 ms tail pump,
   * every other viewer's frames and all HTTP were frozen. One person typing
   * therefore degraded everybody. The pane hot path (input, resize, capture,
   * grid readback) runs through here instead; the one-shot and boot-time
   * commands stay on {@link run} (see its doc for why).
   */
  async runAsync(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const proc = spawn([this.#tmuxBinary, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drained CONCURRENTLY with the exit wait: a tmux command that filled a
    // pipe buffer (a large `capture-pane`) would deadlock against a sequential
    // `await proc.exited` that never reads.
    const collected = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    // The deadline RACES that rather than gating on it, and the difference is
    // load-bearing: killing the child does not necessarily close the pipes.
    // Measured against a stub shell that had spawned `sleep` — SIGKILL ended
    // the shell while the grandchild kept stdout open, so waiting for the
    // drain after the kill hung exactly as long as doing nothing.
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // SIGKILL rather than a polite SIGTERM: this fires only once the
        // command is past a deadline no honest tmux call approaches, and
        // killing the CLIENT leaves the tmux server and its panes untouched.
        proc.kill("SIGKILL");
        reject(new TmuxError(`tmux ${args[0]} timed out after ${timeoutMs}ms and was killed`));
      }, timeoutMs);
      timer.unref?.();
    });
    // The losing side of the race is abandoned, and an abandoned rejection is
    // an unhandled one — a read that fails after we gave up must not crash the
    // process on its way out.
    collected.catch(() => {});
    deadline.catch(() => {});
    try {
      const [stdout, stderr, exitCode] = await Promise.race([collected, deadline]);
      if (exitCode !== 0) {
        throw new TmuxError(stderr.trim() || `tmux ${args[0]} failed (exit ${exitCode})`);
      }
      return { stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs a tmux command, throwing with stderr on non-zero exit.
   *
   * SYNCHRONOUS, and what is left on it is exactly the once-per-lifecycle-event
   * set: `newSubshell`, `killSubshell`, `pipePane`, the strict `kill-session`
   * its callers spell out, the agent CLI, and `listSubshellNames` (which has
   * no production caller at all). Nothing on a keystroke path and nothing on
   * a poll runs here any more — the pane hot path, the reconcile sweep's
   * probes, the agent's 2 s exit watch and the liveness check all went to
   * {@link runAsync}.
   *
   * `hasSubshell` was the last holdout, kept sync for
   * `SubshellManager.isAlive`; that method turned out to have no production
   * caller at all (only test assertions), so it and
   * `LocalLauncher.hasSubshellSync` were deleted rather than defended, and
   * with them the last blocking spawn on the WS attach path.
   *
   * New per-keystroke or per-poll code belongs on {@link runAsync}.
   */
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
  async hasSubshell(socket: string, subshellName: string): Promise<boolean> {
    try {
      await this.runAsync(["-L", socket, "has-session", "-t", subshellName], {});
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
  async listSubshellsChecked(socket: string): Promise<{ ok: true; names: string[] } | { ok: false; detail: string }> {
    try {
      const out = await this.runAsync(["-L", socket, "list-sessions", "-F", "#{session_name}"], {});
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
  async paneExitCode(socket: string, subshellName: string): Promise<number | null> {
    try {
      // Query the subshell's own pane explicitly (-t) so the read is
      // well-defined even if the socket ever hosts more than one subshell.
      const out = await this.runAsync(
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
  async paneTitle(socket: string, subshellName: string): Promise<{ title: string; command: string } | null> {
    const read = async (field: string): Promise<string | null> => {
      try {
        return (
          await this.runAsync(["-L", socket, "display-message", "-t", subshellName, "-p", field], {})
        ).stdout.replace(/\n$/, "");
      } catch {
        return null;
      }
    };
    const title = await read("#{pane_title}");
    if (title === null) return null;
    // Sequential, not `Promise.all`: the second read is pointless when the
    // first proved the pane gone, and these two spawns are the per-row cost
    // of a sweep over every running subshell.
    return { title, command: (await read("#{pane_current_command}")) ?? "" };
  }

  /**
   * The pid of the process tmux runs IN the pane, null when the pane is gone
   * or tmux errors.
   *
   * tmux's own `send-keys -X resize-pane`-family has no "force a redraw" verb,
   * and the repaint the attach path needs is a `SIGWINCH` to the pane's
   * process — so this is the handle for the one signal the server sends
   * directly (see `NodeLauncher.signalPaneWinch`). `#{pane_pid}` is a bare
   * integer, so unlike {@link paneTitle} a single read needs no separator.
   */
  async panePid(socket: string, subshellName: string): Promise<number | null> {
    try {
      const out = (
        await this.runAsync(["-L", socket, "display-message", "-t", subshellName, "-p", "#{pane_pid}"], {})
      ).stdout.trim();
      const pid = Number(out);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
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
    // Before the spawn, so an over-long TMUX_TMPDIR is reported as itself
    // rather than as tmux's bare "File name too long" — and so the retry loop
    // below does not spend its budget on a failure no retry can fix.
    assertSocketPathFits(socket);
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

  /**
   * Redirects all pane output to a file (live streaming).
   *
   * The file is created 0600. This is not incidental: the pane log is the
   * plaintext transcript of everything the terminal rendered, and a tty
   * echoes, so every key the operator typed — a pasted API token, an
   * `export SECRET=…` — is in it, alongside whatever the commands printed
   * back. tmux's shell is what CREATES the file (`cat >>`), so there is no
   * mode argument to pass and no post-hoc chmod that closes the window
   * between creation and tightening; `umask 077` in the command itself is
   * the only way the file is never world-readable, not even briefly.
   * Callers still own the DIRECTORY's mode (see LocalLauncher).
   */
  pipePane(socket: string, subshellName: string, outputFile: string): void {
    // The command runs in tmux's shell (`sh -c`), so the path must be
    // POSIX-single-quoted. The previous JSON.stringify-based escaping did
    // NOT neutralize `$`, backticks or `;` — JSON string escaping and shell
    // quoting are different languages. shellQuote is the same quoter the
    // pane commands are baked with (canonical source: @internal/pane-runtime).
    //
    // The subshell parentheses scope the umask to this `cat`, so nothing else
    // tmux's shell may go on to run inherits it.
    const append = `(umask 077; cat >> ${shellQuote(outputFile)})`;
    this.run(["-L", socket, "pipe-pane", "-t", subshellName, "-o", append], {});
  }

  /**
   * Resizes the subshell's window to the client terminal's dimensions.
   *
   * Detached tmux subshells are created at 80×24; without this, the pane's
   * layout (and any full-screen TUI like Claude Code's welcome box) renders
   * at 80×24 even when the attached terminal is larger. Called on WS attach
   * and on every client-side resize.
   */
  async resizeWindow(socket: string, subshellName: string, cols: number, rows: number): Promise<void> {
    await this.runAsync(
      ["-L", socket, "resize-window", "-t", subshellName, "-x", String(cols), "-y", String(rows)],
      {},
    );
  }

  /**
   * Reads the window's REAL grid back.
   *
   * {@link resizeWindow} is a request, not a guarantee, and a client that
   * believes it got a size the pane never took paints onto the wrong rows
   * from then on (the harness TUIs position frames with relative moves, so a
   * one-row disagreement corrupts every later frame until a reattach). This
   * is the readback that lets the server announce what actually happened
   * instead of echoing the request.
   *
   * Both fields are integers, so — unlike {@link paneTitle} — one read needs
   * no separator ambiguity handling; a `:` split is enough.
   *
   * @param socket - tmux socket name
   * @param subshellName - tmux session/window name
   * @returns The pane's grid, or null when the pane or socket is gone
   */
  async paneSize(socket: string, subshellName: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const out = (
        await this.runAsync(
          ["-L", socket, "display-message", "-t", subshellName, "-p", "#{window_width}:#{window_height}"],
          {},
        )
      ).stdout.trim();
      const [rawCols, rawRows] = out.split(":");
      const cols = Number(rawCols);
      const rows = Number(rawRows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
      return { cols, rows };
    } catch {
      return null;
    }
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
   *
   * ORDER IS PART OF THE CONTRACT, and it stopped being free when this became
   * async. The WS handler fires one of these per keystroke WITHOUT awaiting
   * (the browser socket must never wait on tmux), and concurrent `Bun.spawn`
   * calls finish in whatever order the OS schedules them — measured, not
   * feared. Every call is therefore appended to this pane's input chain
   * (the per-pane chain below) SYNCHRONOUSLY, so the order tmux sees is
   * the order the caller invoked in, whether or not anyone awaits the result.
   */
  sendInput(socket: string, subshellName: string, input: string): Promise<void> {
    if (!input) return Promise.resolve();
    return this.#enqueueInput(socket, subshellName, async () => {
      await this.runAsync(["-L", socket, "send-keys", "-t", subshellName, "-l", "--", input], {});
    });
  }

  /**
   * Presses Enter (submits whatever is at the prompt).
   *
   * Shares {@link sendInput}'s per-pane chain, which is what keeps the
   * prompt-delivery pair (type the text, then submit it) in that order: two
   * independent async spawns can otherwise submit an empty prompt and leave
   * the text sitting unsent.
   */
  pressEnter(socket: string, subshellName: string): Promise<void> {
    return this.#enqueueInput(socket, subshellName, async () => {
      await this.runAsync(["-L", socket, "send-keys", "-t", subshellName, "Enter"], {});
    });
  }

  /**
   * Appends one input command to `socket`/`subshellName`'s chain and returns
   * ITS outcome.
   *
   * The enqueue is synchronous up to the `then`, which is what makes call
   * order the delivery order for unawaited callers. The chain kept in the map
   * is the swallowed form: a rejected tail would reject every keystroke queued
   * behind it, so one dead pane frame would look like a broken keyboard.
   *
   * @param socket - tmux socket name
   * @param subshellName - tmux session/window name
   * @param send - the actual spawn, run once its turn comes
   * @returns Resolves/rejects with this command's own result
   */
  #enqueueInput(socket: string, subshellName: string, send: () => Promise<void>): Promise<void> {
    const key = `${socket} ${subshellName}`;
    // Never rejects (see below), so no rejection handler is needed here.
    const previous = this.#inputChains.get(key) ?? Promise.resolve();
    const result = previous.then(send);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#inputChains.set(key, settled);
    void settled.then(() => {
      // Only when nothing queued behind us — a later call has already replaced
      // the entry, and deleting it would unchain the keystrokes still waiting.
      if (this.#inputChains.get(key) === settled) this.#inputChains.delete(key);
    });
    return result;
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
  async capturePane(socket: string, subshellName: string, scrollbackLines?: number): Promise<string> {
    const args = ["-L", socket, "capture-pane", "-p", "-e", "-t", subshellName];
    if (scrollbackLines && scrollbackLines > 0) args.push("-S", `-${scrollbackLines}`);
    const res = await this.runAsync(args, {});
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

  /**
   * Deletes the socket file for a dead subshell (best-effort, but awaited:
   * the path rule is `tmuxSocketPath`'s, and the test needs the unlink to
   * have happened before it asserts). TMPDIR is NOT the variable tmux
   * consults - TMUX_TMPDIR is; reading TMPDIR silently missed every socket
   * on macOS, where TMPDIR is a per-user /var/folders path.
   */
  cleanSocket(socket: string): Promise<void> {
    return Bun.file(tmuxSocketPath(socket))
      .unlink()
      .catch(() => {});
  }
}

/** Derives a stable, unique tmux socket name for a subshell id. */
export function tmuxSocketFor(subshellId: string): string {
  const hash = createHash("sha1").update(subshellId).digest("hex").slice(0, 12);
  return `subshell-${hash}`;
}

/**
 * Longest path a unix domain socket may have: the `sun_path` field of
 * `sockaddr_un`, which is 104 bytes on the BSDs (macOS) and 108 on Linux.
 * The terminating NUL is included, so the usable length is one less.
 */
const SUN_PATH_MAX = process.platform === "darwin" ? 104 : 108;

/**
 * The filesystem path tmux will bind for `-L <socket>`.
 *
 * tmux resolves a socket NAME to `$TMUX_TMPDIR/tmux-<uid>/<name>`, falling
 * back to `/tmp` when the variable is unset.
 *
 * @param socket - The socket name (see {@link tmuxSocketFor})
 * @returns The absolute socket path
 */
export function tmuxSocketPath(socket: string): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return join(resolveExisting(base), `tmux-${process.getuid?.() ?? 0}`, socket);
}

/**
 * Resolves the symlinks in `path` as far as it actually exists, keeping the
 * not-yet-created remainder verbatim.
 *
 * The realpath is what matters: the kernel binds the RESOLVED path, so that is
 * the string `sun_path` has to hold — and on macOS `/tmp` is a symlink to
 * `/private/tmp`, 8 bytes the lexical form never shows. Measuring the lexical
 * path let a base whose sockets land at 96 lexical bytes pass the guard and
 * then fail inside tmux with the bare "File name too long" this exists to
 * replace. A blind `realpathSync` cannot be used instead: tmux creates its
 * `tmux-<uid>` directory itself, so the leaf rarely exists at check time, and
 * a throw there would fall back to the lexical string anyway.
 *
 * @param path - Absolute or relative path to resolve
 * @returns The path with every existing component symlink-resolved
 */
function resolveExisting(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return missing.length > 0 ? join(real, ...missing) : real;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute; // nothing along the path exists
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Throws before tmux is spawned when the socket path cannot fit in
 * `sun_path`.
 *
 * Without this the failure surfaces as tmux's bare "File name too long",
 * which reached the browser as an opaque `API 500` naming neither the path,
 * the limit, nor the variable that controls it — every subshell create failed
 * and nothing on screen said why.
 *
 * @param socket - The socket name about to be used
 * @throws When the resolved path is at or beyond the platform's limit
 */
export function assertSocketPathFits(socket: string): void {
  const socketPath = tmuxSocketPath(socket);
  // `sun_path` must hold the bytes AND a terminating NUL.
  if (Buffer.byteLength(socketPath) < SUN_PATH_MAX) return;
  const asked = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket);
  // Name BOTH spellings when they differ: the resolved one is what broke the
  // limit, but the operator only recognises the one they configured.
  const shown = asked === socketPath ? socketPath : `${socketPath} (from ${asked})`;
  throw new TmuxError(
    `tmux socket path is too long (${Buffer.byteLength(socketPath)} bytes; the kernel allows ${SUN_PATH_MAX - 1} on ` +
      `${process.platform}): ${shown}. Point TMUX_TMPDIR at a shorter directory, e.g. TMUX_TMPDIR=/tmp.`,
  );
}

class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}
