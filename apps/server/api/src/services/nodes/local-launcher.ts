import { chmodSync, existsSync, type FSWatcher, mkdirSync, unlinkSync, watch } from "node:fs";
import { homedir } from "node:os";
import { stripAnsi } from "@internal/backend-errors";
import { buildHarnessCommand, type HarnessPlugin, TmuxRunner, validateWorkingDir } from "@internal/pane-runtime";
import { logger } from "@/utils/logger.js";
import { readLogTailFrom, TAIL_BACKSTOP_MS } from "./log-tail.js";
import type { LaunchPlan, NodeLauncher } from "./node-launcher.js";
import { subshellLogDir, subshellLogPath } from "./subshell-paths.js";

/** Today's exact tmux/fs behavior behind the launcher seam (spec §6.3). */
export class LocalLauncher implements NodeLauncher {
  readonly #tmux: TmuxRunner;

  constructor(deps: { tmux?: TmuxRunner } = {}) {
    this.#tmux = deps.tmux ?? new TmuxRunner();
    // The log dir must exist before ANY pipe-pane: tmux runs `cat >> <path>`
    // once, and a missing parent dir makes it die silently — every pane
    // output from then on is lost. launch() re-ensures it per spawn (a wipe
    // between construction and launch), but constructing a launcher is also
    // what direct consumers (attach, tests seeding panes) rely on.
    try {
      ensureLogDirMode(subshellLogDir());
    } catch {
      // best-effort; launch()'s mkdir is the one that gates real spawns
    }
  }

  /** Validates + resolves the working directory (package function, machine-local). */
  async validateWorkingDir(raw: string): Promise<string> {
    return validateWorkingDir(raw);
  }

  /** Resolves the harness binary on THIS machine (plugin lookup). */
  async resolveBinary(harness: HarnessPlugin): Promise<string | null> {
    return harness.findBinary();
  }

  /**
   * One harness start, verbatim from the pre-seam `createSubshell` sequence:
   * compose the pane command (throws on a bad env key — before anything
   * spawns), create the detached subshell, make sure the log dir exists, then
   * pipe-pane the output log. With {@link LaunchPlan.bestEffortLog} set, only
   * the LOG ATTACH (dir mkdir + pipe-pane) degrades — a failure there is
   * logged (debug) and swallowed, exactly like the pre-seam revive did.
   */
  async launch(plan: LaunchPlan): Promise<void> {
    const cmd = buildHarnessCommand(
      plan.harness,
      plan.binary,
      plan.cwd,
      plan.profile,
      plan.subshellName,
      plan.subshellEnv,
      plan.mcp,
      plan.harnessSession,
    );
    this.#tmux.newSubshell(plan.socket, plan.id, plan.cwd, cmd);
    // Stream all pane output to a per-subshell log file for attach replay.
    const logFile = subshellLogPath(plan.id);
    if (plan.bestEffortLog) {
      // Revive-only (see LaunchPlan.bestEffortLog): the pane is live and the
      // row must come back even when the replay log refuses to attach — and
      // "attach" is BOTH steps: a mkdir throw (log dir wiped mid-flight and
      // the re-create refused) escapes a revive just as fatally as a pipe-pane
      // throw, so the guarded region wraps mkdir + pipePane together.
      // buildHarnessCommand/newSubshell above stay strict by design.
      try {
        this.#ensureLogDir(logFile);
        this.#tmux.pipePane(plan.socket, plan.id, logFile);
      } catch (err) {
        // The pre-seam revive swallowed this silently; one quiet debug line is
        // the improvement — loud enough to find, too soft to alarm a sweep.
        logger.withError(err).debug(`log attach (dir/pipe-pane) failed for ${plan.id}; reviving without the log pipe`);
      }
    } else {
      this.#ensureLogDir(logFile);
      this.#tmux.pipePane(plan.socket, plan.id, logFile);
    }
  }

  /**
   * Ensure the pane log's parent dir exists before pipe-pane: tmux runs
   * `cat >> <path>` once, and a missing parent dir makes it die silently —
   * every pane output from then on is lost. Single home for the strict and
   * best-effort ({@link LaunchPlan.bestEffortLog}) attach paths so they can
   * never drift apart.
   */
  #ensureLogDir(logFile: string): void {
    const logDir = logFile.slice(0, Math.max(0, logFile.lastIndexOf("/")));
    if (logDir && logDir !== ".") ensureLogDirMode(logDir);
  }

  /**
   * Kills the subshell, THROWING when tmux refuses (unlike {@link killSubshell},
   * which swallows "already gone") — the strict form the interface owes a
   * caller that must learn the kill failed.
   */
  async terminate(socket: string, id: string): Promise<void> {
    this.#tmux.run(["-L", socket, "kill-session", "-t", id], {});
  }

  /** Kills the subshell, swallowing "already gone" (TmuxRunner.killSubshell semantics). */
  async killSubshell(socket: string, id: string): Promise<void> {
    this.#tmux.killSubshell(socket, id);
  }

  async hasSubshell(socket: string, id: string): Promise<boolean> {
    return this.#tmux.hasSubshell(socket, id);
  }

  /**
   * Sync fast path for the tmux liveness probe (the underlying call is
   * synchronous). Not on {@link NodeLauncher} — remote liveness is async by
   * nature; this exists so the local manager's sync `isAlive` can keep its
   * boolean signature.
   */
  hasSubshellSync(socket: string, id: string): boolean {
    return this.#tmux.hasSubshell(socket, id);
  }

  async paneExitCode(socket: string, id: string): Promise<number | null> {
    return this.#tmux.paneExitCode(socket, id);
  }

  async paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null> {
    return this.#tmux.paneTitle(socket, id);
  }

  async capture(socket: string, id: string, scrollbackLines?: number): Promise<string> {
    return this.#tmux.capturePane(socket, id, scrollbackLines);
  }

  async resize(socket: string, id: string, cols: number, rows: number): Promise<void> {
    this.#tmux.resizeWindow(socket, id, cols, rows);
  }

  async paneSize(socket: string, id: string): Promise<{ cols: number; rows: number } | null> {
    return this.#tmux.paneSize(socket, id);
  }

  /**
   * `SIGWINCH` to the pane's process group WITHOUT resizing anything — the
   * no-reflow repaint the attach path prefers over the ±1-column nudge (see
   * `NodeLauncher.signalPaneWinch`). tmux runs each pane in its own process
   * group with the pane pid as leader, so `-pid` reaches the harness AND its
   * children exactly like a real resize's terminal-driven signal would; the
   * bare pid is the fallback for a pane that is not its own group leader.
   */
  async signalPaneWinch(socket: string, id: string): Promise<boolean> {
    const pid = this.#tmux.panePid(socket, id);
    if (!pid) return false;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGWINCH");
        return true;
      } catch {
        // ESRCH/EPERM — try the next target
      }
    }
    return false;
  }

  async sendInput(socket: string, id: string, input: string): Promise<void> {
    this.#tmux.sendInput(socket, id, input);
  }

  async pressEnter(socket: string, id: string): Promise<void> {
    this.#tmux.pressEnter(socket, id);
  }

  /**
   * Types `text` into a freshly-spawned pane once it shows output, then
   * submits with Enter — the verbatim pre-seam `#deliverPrompt` sequence:
   * poll `capture-pane` (a blank pane = harness still booting) up to the
   * settle window; never settled, or an input failure, reports delivery as
   * false rather than typing blind. No throws, no side effects on timeout.
   */
  async deliverPrompt(
    socket: string,
    id: string,
    text: string,
    settleTimeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + settleTimeoutMs;
    let settled = false;
    while (Date.now() < deadline) {
      try {
        if (stripAnsi(await this.capture(socket, id)).trim()) {
          settled = true;
          break;
        }
      } catch {
        // pane not queryable yet; keep polling
      }
      await Bun.sleep(pollMs);
    }
    if (!settled) return false;
    try {
      await this.sendInput(socket, id, text);
      await this.pressEnter(socket, id);
      return true;
    } catch {
      return false;
    }
  }

  logPath(id: string): string {
    return subshellLogPath(id);
  }

  async readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }> {
    return readLogTailFrom(this.logPath(id));
  }

  /**
   * Reads up to `maxBytes` of the log starting at `fromByte`, with the offset
   * a sequential reader should request next. A missing/unreadable log (or an
   * offset at/after EOF) reads as empty — the same rule as
   * {@link readLogTailFrom}, so a tailer never has to special-case the race
   * between "pane died" and "log unlinked".
   */
  async readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }> {
    const file = Bun.file(this.logPath(id));
    const empty = { bytes: new Uint8Array(0), next: fromByte };
    const size = file.size;
    if (size === undefined || fromByte >= size) return empty;
    const end = Math.min(size, fromByte + maxBytes);
    try {
      const bytes = await file.slice(fromByte, end).bytes();
      return { bytes, next: fromByte + bytes.byteLength };
    } catch {
      return empty;
    }
  }

  /**
   * Streams log appends from `fromByte` onward to `onChunk`, seeded by an
   * immediate catch-up read. Port of the WS attach pump (`startLogTail` in
   * `ws/subshell-ws.ts`): `fs.watch` (inotify on Linux) delivers the moment
   * pipe-pane appends, and a slow interval covers lost watch events; both
   * paths share the size-based read so delivery is identical either way.
   * The returned disposer closes the watcher and clears the timer, and is
   * idempotent. `subId` only names the stream for remote implementations —
   * locally one watcher per call suffices.
   */
  async tailStart(
    id: string,
    _subId: string,
    fromByte: number,
    onChunk: (bytes: Uint8Array, next: number) => void,
  ): Promise<() => void> {
    const logFile = this.logPath(id);
    // Watch events and the backstop can land together; `pumping`/`again`
    // serialize the reads so a byte is never sliced twice.
    let pumping = false;
    let again = false;
    let last = fromByte;
    let stopped = false;

    async function pump(): Promise<void> {
      if (stopped) return;
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      do {
        again = false;
        try {
          const size = (await Bun.file(logFile).stat()).size;
          if (size > last) {
            const bytes = await Bun.file(logFile).slice(last, size).bytes();
            if (stopped) return; // disposed mid-read: the bytes belong to the next subscriber
            last = size;
            onChunk(bytes, last);
          }
        } catch {
          // file gone
        }
      } while (again && !stopped);
      pumping = false;
    }

    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(logFile, () => void pump());
      // If the inode dies the watcher is dead weight; the backstop still delivers.
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    const timer = setInterval(() => void pump(), TAIL_BACKSTOP_MS);
    await pump(); // ship anything written before the subscription attached
    return () => {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      clearInterval(timer);
    };
  }

  /**
   * Resume, twin of {@link RemoteLauncher.canResume} (spec 2026-09-10 §5):
   * the plugin's PURE `resumePath` computes where the transcript would be,
   * this process stats it. Here the "target machine" is this one, so the
   * HostEnv is honestly this process's own home and environment — the values
   * `claudeConfigDir` used to read directly from inside the plugin. One
   * computation both sides of the wire; the difference is only whose
   * filesystem answers.
   */
  async canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean> {
    const resume = harness.resume;
    if (!resume) return false;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    return existsSync(resume.resumePath(storedId, cwd, { homeDir: homedir(), env }));
  }

  /**
   * The local machine owns exactly one per-subshell file: the pipe-pane replay
   * log (the MCP config under `subshellMcpConfigPath` is a control-plane file —
   * `deleteSubshell` unlinks it directly for local and remote rows alike).
   */
  subshellArtifacts(id: string): string[] {
    return [this.logPath(id)];
  }

  /** Best-effort unlink of artifact paths (absent files are not errors). */
  async removeArtifacts(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        unlinkSync(p);
      } catch {
        // nothing to remove
      }
    }
  }
}

/**
 * Creates the pane-log directory if absent and pins it to 0700.
 *
 * The mode is asserted unconditionally rather than passed to `mkdirSync`,
 * for the two reasons this codebase has already met elsewhere (see
 * `apps/node/agent/src/identity.ts` and `commands/configure.ts`): mkdir's `mode`
 * is clamped by the umask, and it applies only to segments mkdir actually
 * creates — so a directory that predates this fix keeps whatever mode the old
 * bare `mkdirSync(recursive)` gave it, which was 0755.
 *
 * 0700 matters because of what is inside: pane logs are the verbatim
 * transcript of everything the terminal rendered, typed secrets included.
 * The files themselves are created 0600 by `TmuxRunner.pipePane`'s umask;
 * this is the other half of the same guarantee.
 */
function ensureLogDirMode(logDir: string): void {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  chmodSync(logDir, 0o700);
}

let defaultLauncher: LocalLauncher | null = null;

/**
 * The shared default launcher (mirrors the constructor default; used by
 * readSubshellLogTail and `launcherFor(LOCAL_NODE_ID)`), created on first
 * call. LAZY on purpose: the constructor mkdirs the log dir, and
 * `subshell-server mcp` evaluates the whole entry graph while it suspends —
 * an eager module-level `new` littered `data/subshells/` into the cwd of
 * every pane that spawned the shim (cli.ts invariant 3: no IO at import).
 * First real use is a launch/attach/read path on the boot side, where the
 * mkdir belongs.
 */
export function getDefaultLocalLauncher(): LocalLauncher {
  defaultLauncher ??= new LocalLauncher();
  return defaultLauncher;
}

/**
 * Resets the lazy singleton. Only use in tests.
 * @internal
 */
export function resetDefaultLocalLauncher(): void {
  defaultLauncher = null;
}
