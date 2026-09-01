import { existsSync, type FSWatcher, mkdirSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripAnsi } from "@internal/backend-errors";
import { buildHarnessCommand, type HarnessPlugin, TmuxRunner, validateWorkingDir } from "@internal/harnesses";
import { sessionMcpConfigPath } from "@/services/mcp-launch.js";
import { readLogTailFrom, TAIL_BACKSTOP_MS } from "./log-tail.js";
import type { LaunchPlan, NodeLauncher } from "./node-launcher.js";
import { sessionLogDir, sessionLogPath } from "./session-paths.js";

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
      mkdirSync(sessionLogDir(), { recursive: true });
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
   * One harness start, verbatim from the pre-seam `createSession` sequence:
   * compose the pane command (throws on a bad env key — before anything
   * spawns), create the detached session, make sure the log dir exists, then
   * pipe-pane the output log.
   */
  async launch(plan: LaunchPlan): Promise<void> {
    const cmd = buildHarnessCommand(
      plan.harness,
      plan.binary,
      plan.cwd,
      plan.profile,
      plan.sessionName,
      plan.moteEnv,
      plan.mcp,
      plan.harnessSession,
    );
    this.#tmux.newSession(plan.socket, plan.id, plan.cwd, cmd);
    // Stream all pane output to a per-session log file for attach replay.
    const logFile = sessionLogPath(plan.id);
    const logDir = logFile.slice(0, Math.max(0, logFile.lastIndexOf("/")));
    if (logDir && logDir !== "." && !existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    this.#tmux.pipePane(plan.socket, plan.id, logFile);
  }

  /**
   * Kills the session, THROWING when tmux refuses (unlike {@link killSession},
   * which swallows "already gone") — the strict form the interface owes a
   * caller that must learn the kill failed.
   */
  async terminate(socket: string, id: string): Promise<void> {
    this.#tmux.run(["-L", socket, "kill-session", "-t", id], {});
  }

  /** Kills the session, swallowing "already gone" (TmuxRunner.killSession semantics). */
  async killSession(socket: string, id: string): Promise<void> {
    this.#tmux.killSession(socket, id);
  }

  async hasSession(socket: string, id: string): Promise<boolean> {
    return this.#tmux.hasSession(socket, id);
  }

  /**
   * Sync fast path for the tmux liveness probe (the underlying call is
   * synchronous). Not on {@link NodeLauncher} — remote liveness is async by
   * nature; this exists so the local manager's sync `isAlive` can keep its
   * boolean signature.
   */
  hasSessionSync(socket: string, id: string): boolean {
    return this.#tmux.hasSession(socket, id);
  }

  async paneExitCode(socket: string, id: string): Promise<number | null> {
    return this.#tmux.paneExitCode(socket, id);
  }

  async paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null> {
    return this.#tmux.paneTitle(socket, id);
  }

  async capture(socket: string, id: string): Promise<string> {
    return this.#tmux.capturePane(socket, id);
  }

  async resize(socket: string, id: string, cols: number, rows: number): Promise<void> {
    this.#tmux.resizeWindow(socket, id, cols, rows);
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
    return sessionLogPath(id);
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
   * `ws/session-ws.ts`): `fs.watch` (inotify on Linux) delivers the moment
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

  /** Trusts the plugin's transcript probe (machine-local state dir). */
  async canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean> {
    return harness.resume ? harness.resume.canResume(storedId, cwd) : false;
  }

  /**
   * Writes a per-session artifact and returns its path. `mcp-config` mirrors
   * where `registerSessionMcp` writes today (`mcp-launch.ts`) — one shared
   * path definition so a phase-2 agent and the local writer cannot drift.
   * Content holds no secrets, but the file stays 0600 — least exposure is
   * free (same rule as `registerSessionMcp`).
   */
  async writeArtifact(id: string, _kind: "mcp-config", content: string): Promise<string> {
    const file = sessionMcpConfigPath(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o600 });
    return file;
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

/** Module-level default (mirrors the constructor default; used by readSessionLogTail). */
export const defaultLocalLauncher = new LocalLauncher();
