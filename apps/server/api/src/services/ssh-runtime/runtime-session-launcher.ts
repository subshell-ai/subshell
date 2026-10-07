import { stripAnsi } from "@internal/backend-errors";
import type { HarnessPlugin } from "@internal/pane-runtime";
import {
  HARNESS_BINARY_PLACEHOLDER,
  type NodeCommandBody,
  parseNodeCaptureResult,
  parseNodeFsLsResult,
  parseNodeLogReadResult,
  parseNodePaneCursorResult,
  parseNodePaneSizeResult,
  parseNodeProbeEntries,
  parseNodeStatDirResult,
  SSH_SESSION_LOG_WINDOW_BYTES,
} from "@internal/subshell-protocol";
import { tailLinesFromWindowText } from "@/services/nodes/log-tail.js";
import type { LaunchPlan, NodeLauncher } from "@/services/nodes/node-launcher.js";
import { assertNodePathId } from "@/services/nodes/node-path-id.js";
import { logger } from "@/utils/logger.js";
import type { SshRuntimeSession } from "./session.js";

/**
 * The launcher for panes carried by an SSH runtime session (design 2026-10-05
 * §4): the same {@link NodeLauncher} interface the whole pane plumbing calls,
 * with every operation serialized through the session's framed byte channel
 * instead of signed WS commands. `RemoteLauncher` is untouched (the design
 * says so); this file is its sibling, and the method bodies mirror its
 * semantics deliberately - a caller must not be able to tell, from anything
 * it is allowed to observe, which machine class it is talking to.
 *
 * The deliberate differences, each with its reason:
 * - `cleanSocket` refuses to unlink and does nothing: a runtime's panes SHARE
 *   one destination socket (design §6's reconciliation), so the per-pane
 *   socket-file reclaim the node link does would unlink a live server out from
 *   under its other panes.
 * - `canResume` is false: the runtime has no resume probe. Initial prompts
 *   use the existing capture/input frames and the ordinary launch settle rule.
 * - `resolveBinary` answers null: the RUNTIME resolves the binary on the
 *   destination (the inversion's late binding, one layer closer to the
 *   machine); the plane never needs the path to compose the frame.
 */

/** Command deadlines; the runtime answers locally on the destination, so the node-link's budgets fit with headroom. */
const COMMAND_TIMEOUT_MS = 10_000;
const LOG_READ_TIMEOUT_MS = 10_000;
const TAIL_START_TIMEOUT_MS = 10_000;

export class RuntimeSessionLauncher implements NodeLauncher {
  readonly #session: SshRuntimeSession;

  constructor(session: SshRuntimeSession) {
    this.#session = session;
  }

  /** `stat_dir` (10 s): the same `ENOENT:`/`ENOTDIR:` answer classes the node link gives (the shared executor produces them identically). */
  async validateWorkingDir(raw: string): Promise<string> {
    const data = await this.#session.command(
      { type: "stat_dir", ref: crypto.randomUUID(), path: raw },
      COMMAND_TIMEOUT_MS,
    );
    const parsed = parseNodeStatDirResult(data);
    if (parsed === null) throw new Error(`validateWorkingDir: malformed runtime answer for ${raw}`);
    return parsed.path;
  }

  /** Not a plane-side question for a runtime (see the module doc). */
  async resolveBinary(_harness: HarnessPlugin): Promise<string | null> {
    return null;
  }

  /**
   * The node link's launch body, composed the same way {@link RemoteLauncher}
   * composes it (argv with the placeholder, `resolve` from the harness's
   * detect spec) - the runtime's frame carries that body VERBATIM and the
   * runtime's `execLaunch` is the same executor a node runs, which is the
   * whole reuse story of design §2. The task-25 addition is parity for a PRESET
   * plan: the `mcp` registration (the caller baked it with
   * `planRemoteSubshellMcp` against the hello facts - dataDir from the runtime,
   * spawn command from the reported self-invoke), the `harnessSession` resume
   * pin, and the reporter half of the ARGV (baked by `buildCommand` from the
   * plan's `reporter`, the runtime's self-invoke of `report` - the hooks run
   * against the pane's callback door, see mcp-core's report.ts).
   *
   * What does NOT ride, by design and load-bearing (design §5, task 25): the
   * plan's `subshellEnv` for a runtime pane is composed by the CALLER without
   * `SUBSHELL_API_KEY`/plane reachability - the id, the display name, the pane
   * door (`SUBSHELL_RUNTIME_CALLBACK_SOCK`) and the destination data dir. The
   * pane's REAL bearer token stays in `#paneTokens` on the plane; the MCP
   * child and every hook route through the door, where the plane executes them
   * AS the pane. A frame or pane env that ever carries a minted token is the
   * invariant breaking - pinned by test, scanning both.
   */
  async launch(plan: LaunchPlan): Promise<void> {
    if (!plan.harness.detectSpec) throw new Error(`harness binary missing: ${plan.harness.id}`);
    if (plan.mcp && !plan.mcpConfigPath) {
      // The frame grammar's own requirement (RemoteLauncher's identical local
      // refusal): content without a write target is a caller bug, and nothing
      // reaches the wire.
      throw new Error(`runtime launch of "${plan.id}": LaunchPlan.mcpConfigPath is required when mcp is set`);
    }
    const argv = plan.harness.buildCommand({
      binary: HARNESS_BINARY_PLACEHOLDER,
      cwd: plan.cwd,
      preset: plan.preset,
      subshellName: plan.subshellName,
      mcp: plan.mcp,
      harnessSession: plan.harnessSession,
      reporter: plan.reporter,
    });
    const cmd: NodeCommandBody = {
      type: "launch",
      subshellId: plan.id,
      socket: plan.socket,
      cwd: plan.cwd,
      harnessId: plan.harness.id,
      preset: plan.preset,
      subshellEnv: plan.subshellEnv,
      mcp: plan.mcp
        ? {
            path: plan.mcpConfigPath as string,
            fileContent: plan.mcp.fileContent,
            // Conditional spreads (the RemoteLauncher rule, kept verbatim):
            // an absent half of a dialect stays ABSENT on the object, not
            // undefined-on-it, because the frame parser refuses explicit
            // undefined optionals.
            ...(plan.mcp.args ? { args: plan.mcp.args } : {}),
            ...(plan.mcp.env ? { env: plan.mcp.env } : {}),
          }
        : undefined,
      harnessSession: plan.harnessSession,
      subshellName: plan.subshellName,
      ...(plan.bestEffortLog !== undefined ? { bestEffortLog: plan.bestEffortLog } : {}),
      argv,
      resolve: plan.harness.detectSpec,
    };
    await this.#session.command({ type: "launch", ref: crypto.randomUUID(), cmd }, 20_000);
  }

  /** Strict terminate (the runtime's executor mirrors `LocalLauncher.terminate`'s throwing kill-session). */
  async terminate(_socket: string, id: string): Promise<void> {
    await this.#session.command({ type: "terminate", ref: crypto.randomUUID(), subshellId: id }, COMMAND_TIMEOUT_MS);
  }

  /** Best-effort kill; the runtime's executor already swallows "already gone". */
  async killSubshell(_socket: string, id: string): Promise<void> {
    try {
      await this.#session.command({ type: "kill", ref: crypto.randomUUID(), subshellId: id }, COMMAND_TIMEOUT_MS);
    } catch {
      // already gone is the answer
    }
  }

  /**
   * Deliberately a no-op (module doc): a runtime's panes share the one
   * destination socket, so there is no per-pane socket file to reclaim, and
   * unlinking the shared name would kill every other pane's server out from
   * under them (design §6 coexistence).
   */
  async cleanSocket(_socket: string): Promise<void> {}

  /** One-entry probe. */
  async #probeEntry(subshellId: string) {
    const data = await this.#session.command(
      { type: "probe", ref: crypto.randomUUID(), subshellIds: [subshellId] },
      COMMAND_TIMEOUT_MS,
    );
    const entries = parseNodeProbeEntries(data);
    if (!entries) throw new Error("probe: malformed runtime answer");
    return entries[0];
  }

  async hasSubshell(_socket: string, id: string): Promise<boolean> {
    return (await this.#probeEntry(id))?.alive === true;
  }

  async paneExitCode(_socket: string, id: string): Promise<number | null> {
    return (await this.#probeEntry(id))?.exitCode ?? null;
  }

  async paneTitle(_socket: string, id: string): Promise<{ title: string; command: string } | null> {
    const entry = await this.#probeEntry(id);
    return entry?.alive && entry.title != null ? { title: entry.title, command: entry.command ?? "" } : null;
  }

  async capture(_socket: string, id: string, scrollbackLines?: number): Promise<string> {
    const data = await this.#session.command(
      scrollbackLines && scrollbackLines > 0
        ? { type: "capture", ref: crypto.randomUUID(), subshellId: id, lines: scrollbackLines }
        : { type: "capture", ref: crypto.randomUUID(), subshellId: id },
      COMMAND_TIMEOUT_MS,
    );
    const text = parseNodeCaptureResult(data);
    if (typeof text !== "string") throw new Error("capture: malformed runtime answer");
    return text;
  }

  async resize(_socket: string, id: string, cols: number, rows: number): Promise<void> {
    await this.#session.command(
      { type: "resize", ref: crypto.randomUUID(), subshellId: id, cols, rows },
      COMMAND_TIMEOUT_MS,
    );
  }

  async paneSize(_socket: string, id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      return parseNodePaneSizeResult(
        await this.#session.command(
          { type: "pane_size", ref: crypto.randomUUID(), subshellId: id },
          COMMAND_TIMEOUT_MS,
        ),
      );
    } catch (err) {
      if (err instanceof Error) logger.debug(`pane_size failed for ${id}: ${err.message}`);
      return null;
    }
  }

  async paneCursor(_socket: string, id: string): Promise<{ x: number; y: number } | null> {
    try {
      return parseNodePaneCursorResult(
        await this.#session.command(
          { type: "pane_cursor", ref: crypto.randomUUID(), subshellId: id },
          COMMAND_TIMEOUT_MS,
        ),
      );
    } catch (err) {
      if (err instanceof Error) logger.debug(`pane_cursor failed for ${id}: ${err.message}`);
      return null;
    }
  }

  /** The node link says false for the same reason (no winch relay in this frame set); false routes the attach to its ±1 nudge fallback. */
  async signalPaneWinch(): Promise<boolean> {
    return false;
  }

  async sendInput(_socket: string, id: string, input: string): Promise<void> {
    await this.#session.command(
      { type: "input", ref: crypto.randomUUID(), subshellId: id, data: input },
      COMMAND_TIMEOUT_MS,
    );
  }

  /** Wait for initial output, then deliver once through the existing capture/input frames. */
  async deliverPrompt(
    socket: string,
    id: string,
    text: string,
    settleTimeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline) {
      let ready = false;
      try {
        ready = Boolean(stripAnsi(await this.capture(socket, id)).trim());
      } catch {
        /* still starting */
      }
      if (ready) {
        try {
          await this.sendInput(socket, id, text);
          await this.sendInput(socket, id, "\r");
          return true;
        } catch {
          return false;
        } // Never replay text after an uncertain write.
      }
      await Bun.sleep(pollMs);
    }
    return false;
  }

  /**
   * The pane log's path ON THE DESTINATION, composed from the hello's
   * `dataDir` (the same `<dataDir>/subshells/<id>.log` template the node
   * link's `factsPath` uses, one layer closer to the machine). Throws for a
   * non-conforming id before composing, the `assertNodePathId` posture.
   */
  logPath(id: string): string {
    assertNodePathId(id);
    return `${this.#session.hello.dataDir}/subshells/${id}.log`;
  }

  async readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }> {
    const { size } = await this.#readLogSized(id, 0, 1);
    // The tail window is the SESSION budget, not the node link's
    // LOG_TAIL_BYTES: a 256 KiB raw answer base64s past the session frame
    // cap and `encodeSshSessionFrame` throws (review C1a). The display cap
    // is 200 lines either way; 128 KiB of tail text reaches it with room.
    const start = Math.max(0, size - SSH_SESSION_LOG_WINDOW_BYTES);
    const { bytes } = await this.#readLogSized(id, start, SSH_SESSION_LOG_WINDOW_BYTES);
    return tailLinesFromWindowText(Buffer.from(bytes).toString("utf8"), start === 0);
  }

  /**
   * The one frame-composing seam for every log read (tail, cursor, window,
   * tail-relay backfill): `maxBytes` is CLAMPED to the runtime transfer
   * budget before the frame is built, so no caller's node-link-sized ask can
   * compose a frame the session codec refuses (review C1a). A smaller ask
   * passes through untouched; the answer's `next`/`size` come back verbatim,
   * so a clamped read just means a reader pages again.
   */
  async #readLogSized(
    id: string,
    fromByte: number,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; next: number; size: number }> {
    const windowBytes = Math.min(Math.max(1, Math.trunc(maxBytes)), SSH_SESSION_LOG_WINDOW_BYTES);
    const data = await this.#session.command(
      { type: "log_read", ref: crypto.randomUUID(), subshellId: id, fromByte, maxBytes: windowBytes },
      LOG_READ_TIMEOUT_MS,
    );
    const r = parseNodeLogReadResult(data);
    if (!r) throw new Error("log_read: malformed runtime answer");
    return { bytes: Buffer.from(r.bytes_b64, "base64"), next: r.next, size: r.size };
  }

  async readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }> {
    const { bytes, next } = await this.#readLogSized(id, fromByte, maxBytes);
    return { bytes, next };
  }

  async readLogWindow(
    id: string,
    fromByte: number,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; next: number; size: number }> {
    return await this.#readLogSized(id, fromByte, maxBytes);
  }

  /**
   * The RemoteLauncher's tail relay, re-homed on the session's own output
   * bus: subscribe before the round trip, gap-backfill through `log_read`,
   * dup-slice, disposer idempotent and fire-and-forget on `tail_stop`
   * (the twin's ordering promises are the contract, and this is deliberately
   * the same shape so a viewer sees one streaming behavior across machine
   * classes).
   */
  async tailStart(
    id: string,
    subId: string,
    fromByte: number,
    onChunk: (bytes: Uint8Array, next: number) => void,
  ): Promise<() => void> {
    let cursor = fromByte;
    let disposed = false;
    let queue: Promise<void> = Promise.resolve();
    const unsubscribe = this.#session.subscribeOutput(subId, id, (bytes, next) => {
      queue = queue
        .then(async () => {
          if (disposed) return;
          const expected = cursor + bytes.byteLength;
          if (next > expected) {
            const backfill = await this.readLog(id, cursor, next - cursor).catch(() => ({
              bytes: new Uint8Array(0),
              next: cursor,
            }));
            if (disposed) return;
            if (backfill.bytes.byteLength > 0 && backfill.next > cursor) {
              cursor = backfill.next;
              onChunk(backfill.bytes, cursor);
            }
          }
          let slice = bytes;
          const delta = cursor - (next - bytes.byteLength);
          if (delta > 0) slice = slice.subarray(Math.min(delta, slice.byteLength));
          if (slice.byteLength === 0) return;
          if (disposed) return;
          cursor = next;
          onChunk(slice, cursor);
        })
        .catch((err: unknown) => logger.withError(err).warn(`runtime tail relay failed for ${id}`));
    });
    try {
      await this.#session.command(
        { type: "tail_start", ref: crypto.randomUUID(), subshellId: id, subId, fromByte },
        TAIL_START_TIMEOUT_MS,
      );
    } catch (err) {
      unsubscribe();
      throw err;
    }
    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      void this.#session.command({ type: "tail_stop", ref: crypto.randomUUID(), subId }, 5_000).catch(() => undefined);
    };
  }

  /** No resume surface on a runtime pane in this slice (module doc). */
  async canResume(): Promise<boolean> {
    return false;
  }

  /** The two files a runtime pane leaves (log + meta record; a runtime pane has no MCP registration file). */
  subshellArtifacts(id: string): string[] {
    return [
      `${this.#session.hello.dataDir}/subshells/${id}.log`,
      `${this.#session.hello.dataDir}/subshells/${id}.meta.json`,
    ];
  }

  async removeArtifacts(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.#session.command({ type: "remove_paths", ref: crypto.randomUUID(), paths }, COMMAND_TIMEOUT_MS);
    } catch (err) {
      logger.withError(err).debug(`runtime session ${this.#session.id.slice(0, 8)}: remove_paths failed (best-effort)`);
    }
  }

  /** `fs_ls` (design §2's `list_dirs`): the same answer shape the node link's picker read returns. */
  async listDirs(path: string): Promise<unknown> {
    const data = await this.#session.command({ type: "list_dirs", ref: crypto.randomUUID(), path }, COMMAND_TIMEOUT_MS);
    const parsed = parseNodeFsLsResult(data);
    if (parsed === null) throw new Error("list_dirs: malformed runtime answer");
    return parsed;
  }
}
