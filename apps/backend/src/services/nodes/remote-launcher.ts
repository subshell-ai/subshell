import type { HarnessPlugin } from "@internal/harnesses";
import {
  type NodeCommandBody,
  type NodeProbeEntry,
  parseNodeCaptureResult,
  parseNodeLogReadResult,
  parseNodeProbeEntries,
  parseNodeProbeResume,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
} from "@internal/session-protocol";
import type { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { logger } from "@/utils/logger.js";
import { readAgentInventory } from "./inventory.js";
import { LOG_TAIL_BYTES, tailLinesFromWindowText } from "./log-tail.js";
import { subscribeOutput } from "./node-events.js";
import type { LaunchPlan, NodeLauncher } from "./node-launcher.js";
import { getLive, type NodeAgentFacts } from "./node-registry.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, NodeRpcError, sendCommand } from "./node-rpc.js";

/**
 * `NodeLauncher` over the signed command RPC (spec 2026-08-31 §6.3) — every
 * machine-local operation a session needs, executed by the node's agent as
 * one `sendCommand` round-trip per call. The behavior twin of
 * {@link LocalLauncher}: where a command's answer is ambiguous this class does
 * what local does for the same call (empty-log reads, swallow classes,
 * never-throw members).
 *
 * Two agent-side semantics pinned by the agent's own tests shape the relay
 * code here:
 * - `tail_start` resolves BEFORE the agent's initial catch-up pump delivers
 *   bytes, so {@link RemoteLauncher.tailStart} subscribes to the output bus
 *   FIRST and only then sends — events racing the result otherwise drop into
 *   the void.
 * - `log_read` clamps `next` to the file size on an empty read, so a gap
 *   backfill with `next <= cursor` means "nothing to deliver"; the triggering
 *   event's payload is still emitted after it.
 *
 * All live state (facts, pendings, seq) lives on the connection record —
 * instances of this class are stateless besides their `nodeId` and safe to
 * share per id (see `launcher-registry.ts`).
 */

/** Per-command deadlines (spec §6.3 table); anything unlisted uses the RPC default. */
const STAT_DIR_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const LOG_READ_TIMEOUT_MS = 10_000;
const TAIL_START_TIMEOUT_MS = 10_000;
const TAIL_STOP_TIMEOUT_MS = 5_000;
const WRITE_FILE_TIMEOUT_MS = 30_000;
const REMOVE_PATHS_TIMEOUT_MS = 10_000;
/** `deliverPrompt` waits for the agent's whole settle loop: its budget plus RPC slack. */
const PROMPT_DELIVER_SLACK_MS = 30_000;

/**
 * Uuid-ish session-id guard mirroring the agent's `isSessionId`
 * (`apps/agent/src/session-meta.ts`): the backend mints uuids, so hex +
 * hyphen ≤ 64 chars is all a legitimate id ever contains. Checked locally
 * before composing a path — an empty/garbage `path` must never reach
 * `write_file` (the agent echoes it and the result validator rejects).
 */
const SESSION_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/** "Already gone" answers the agent gives for a dead pane (kill swallow class). */
const ALREADY_GONE_RE = /no session|can't find session/i;

/** Agent-side launch failure that means "our inventory cache is stale" (spec §6.2). */
const BINARY_MISSING_RE = /binary missing/i;

/** Injectable seams — defaults are the real RPC, the requestless repo, and the live registry. */
export interface RemoteLauncherDeps {
  /** Wire seam (default `sendCommand`). */
  send?: typeof sendCommand;
  /** Node-row lookup seam (default: `repos.nodes` off the requestless context). */
  nodes?: Pick<NodesRepository, "findById">;
  /** Agent-facts seam (default `getLive(nodeId)?.agent` — offline reads as undefined). */
  facts?: (nodeId: string) => NodeAgentFacts | undefined;
}

/**
 * Thrown synchronously when a facts-dependent method runs with no live
 * connection — the RPC-path twin is `NodeRpcError("offline")`; both classes
 * mean §5.6 NODE_OFFLINE to callers. Exported as the sentinel the create-path
 * mapper checks (`instanceof`, never the message text) so Task 10 may reword
 * the message without breaking the 409 mapping.
 */
export class NoLiveConnectionError extends Error {}

/** Resolve one agent-facts-derived absolute path (spec §6.4 composes). */
function factsPath(facts: NodeAgentFacts, rel: string): string {
  return `${facts.dataDir}/${rel}`;
}

export class RemoteLauncher implements NodeLauncher {
  readonly #nodeId: string;
  readonly #deps: RemoteLauncherDeps;

  /**
   * @param nodeId - the enrolled node every command is aimed at
   * @param deps - seams for tests (see {@link RemoteLauncherDeps}); production uses the defaults
   */
  constructor(nodeId: string, deps: RemoteLauncherDeps = {}) {
    this.#nodeId = nodeId;
    this.#deps = deps;
  }

  /** The one wire call: `sendCommand` for this launcher's node with an explicit deadline. */
  #send(cmd: NodeCommandBody, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS): Promise<unknown> {
    const send = this.#deps.send ?? sendCommand;
    return send(this.#nodeId, cmd, timeoutMs);
  }

  /** This node's live agent facts (undefined when offline or pre-`ready`). */
  #facts(): NodeAgentFacts | undefined {
    const read = this.#deps.facts ?? ((id: string) => getLive(id)?.agent);
    return read(this.#nodeId);
  }

  /** Facts or {@link NoLiveConnectionError} — the sync twin of the offline throw `sendCommand` gives with no socket. */
  #requireFacts(): NodeAgentFacts {
    const facts = this.#facts();
    if (!facts) throw new NoLiveConnectionError(`node "${this.#nodeId}" has no live connection`);
    return facts;
  }

  /** Protocol violation: the agent answered `ok:true` with a payload we cannot read. */
  #malformed(command: string): Error {
    return new Error(`node "${this.#nodeId}" returned a malformed ${command} result`);
  }

  /** Fire-and-forget inventory refresh (spec §6.2): never awaited, errors go to debug. */
  #refreshInventory(): void {
    this.#send({ type: "inventory" }, DEFAULT_COMMAND_TIMEOUT_MS).catch((err: unknown) => {
      logger.withError(err).debug(`node ${this.#nodeId}: on-demand inventory refresh failed`);
    });
  }

  /**
   * `stat_dir` on the node (5 s); returns the AGENT's realpath — parity with
   * the local return. The agent answers `ok:false` with `ENOENT:`/`ENOTDIR:`
   * prefixes; that class surfaces as a plain `Error(message)` so callers see
   * the same throw SHAPE as {@link LocalLauncher.validateWorkingDir}
   * ("Path does not exist: …"). Offline/timeout keep their `NodeRpcError`.
   */
  async validateWorkingDir(raw: string): Promise<string> {
    let data: unknown;
    try {
      data = await this.#send({ type: "stat_dir", path: raw }, STAT_DIR_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof NodeRpcError && err.code === "failed") throw new Error(err.message);
      throw err;
    }
    const parsed = parseNodeStatDirResult(data);
    if (!parsed) throw this.#malformed("stat_dir");
    return parsed.path;
  }

  /**
   * Cached-inventory lookup ONLY — never blocks on the network (spec §6.2).
   * A stale (aged or never-reported) snapshot still answers from cache, and
   * kicks an unawaited `inventory` command so the next launch sees fresh
   * data. Absent node row / absent entry read as null (not installed).
   */
  async resolveBinary(harness: HarnessPlugin): Promise<string | null> {
    const nodes = this.#deps.nodes ?? getRequestlessContext().repos.nodes;
    const node = await nodes.findById(this.#nodeId);
    if (!node) return null;
    const inv = readAgentInventory(node);
    if (inv.stale) this.#refreshInventory();
    return inv.entries.get(harness.id)?.binaryPath ?? null;
  }

  /**
   * One `launch` command (60 s) carrying the structured plan — the agent
   * composes the pane command with ITS env and ITS harness plugin. MCP ships
   * as `{ path: plan.mcpConfigPath, fileContent }`; the caller composed that
   * path from the node's `ready.dataDir` (spec §6.4). A `binary missing`
   * failure means our inventory cache lied: refresh it (unawaited) before
   * rethrowing (spec §6.2).
   */
  async launch(plan: LaunchPlan): Promise<void> {
    if (plan.mcp && !plan.mcpConfigPath) {
      // The frozen wire needs a target path; shipping content without one is
      // a caller bug — fail locally rather than send a frame the agent rejects.
      throw new Error(`remote launch of "${plan.id}": LaunchPlan.mcpConfigPath is required when mcp is set`);
    }
    const cmd: NodeCommandBody = {
      type: "launch",
      sessionId: plan.id,
      socket: plan.socket,
      cwd: plan.cwd,
      harnessId: plan.harness.id,
      profile: plan.profile,
      moteEnv: plan.moteEnv,
      mcp: plan.mcp ? { path: plan.mcpConfigPath as string, fileContent: plan.mcp.fileContent } : undefined,
      harnessSession: plan.harnessSession,
      sessionName: plan.sessionName,
      bestEffortLog: plan.bestEffortLog,
    };
    try {
      await this.#send(cmd, LAUNCH_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof NodeRpcError && err.code === "failed" && BINARY_MISSING_RE.test(err.message)) {
        this.#refreshInventory();
      }
      throw err;
    }
  }

  /**
   * Strict `terminate` — an `ok:false` (tmux refusal) throws the
   * {@link NodeRpcError}, mirroring {@link LocalLauncher.terminate}'s throwing
   * `kill-session`.
   */
  async terminate(_socket: string, id: string): Promise<void> {
    await this.#send({ type: "terminate", sessionId: id });
  }

  /**
   * Best-effort `kill`. The agent's own executor already swallows tmux's
   * "already gone"; a `failed` whose message matches
   * `/no session|can't find session/i` is the same class arriving through
   * older/other paths — mapped to a no-op. Anything else rethrows.
   */
  async killSession(_socket: string, id: string): Promise<void> {
    try {
      await this.#send({ type: "kill", sessionId: id });
    } catch (err) {
      if (err instanceof NodeRpcError && err.code === "failed" && ALREADY_GONE_RE.test(err.message)) return;
      throw err;
    }
  }

  /** One-entry `probe` (5 s) → the row for `id` (the agent echoes sessionId). */
  async #probeEntry(sessionId: string): Promise<NodeProbeEntry | undefined> {
    const data = await this.#send({ type: "probe", sessionIds: [sessionId] }, PROBE_TIMEOUT_MS);
    const entries = parseNodeProbeEntries(data);
    if (!entries) throw this.#malformed("probe");
    return entries[0];
  }

  /** `probe` row liveness (spec §6.3 reconcile shape). */
  async hasSession(_socket: string, id: string): Promise<boolean> {
    const entry = await this.#probeEntry(id);
    return entry?.alive === true;
  }

  /** The dead pane's exit code from `probe`; null while alive or never seen. */
  async paneExitCode(_socket: string, id: string): Promise<number | null> {
    const entry = await this.#probeEntry(id);
    return entry?.exitCode ?? null;
  }

  /** The `probe` row's title+command while the pane is alive, null when gone. */
  async paneTitle(_socket: string, id: string): Promise<{ title: string; command: string } | null> {
    const entry = await this.#probeEntry(id);
    return entry?.alive && entry.title != null ? { title: entry.title, command: entry.command ?? "" } : null;
  }

  /** `capture` (10 s) → the pane's visible grid as a bare string. */
  async capture(_socket: string, id: string): Promise<string> {
    const data = await this.#send({ type: "capture", sessionId: id });
    const text = parseNodeCaptureResult(data);
    if (text === null) throw this.#malformed("capture");
    return text;
  }

  /** `resize` verbatim — the agent fits the pane window like tmux does. */
  async resize(_socket: string, id: string, cols: number, rows: number): Promise<void> {
    await this.#send({ type: "resize", sessionId: id, cols, rows });
  }

  /** `input` verbatim, byte for byte (the agent's `send-keys -l --`). */
  async sendInput(_socket: string, id: string, input: string): Promise<void> {
    await this.#send({ type: "input", sessionId: id, data: input });
  }

  /**
   * Submits the pending line. The wire has no `press_enter`; this sends a
   * literal CR through `input`, which is BEHAVIOR-equivalent at the pane
   * (raw-mode TUIs read CR as Enter; canonical shells map CR to NL via
   * ICRNL) rather than byte-identical to tmux's `send-keys Enter` mapping.
   * Today the only production path that presses Enter is local
   * {@link LocalLauncher.deliverPrompt}; the remote prompt consumer,
   * {@link RemoteLauncher.deliverPrompt}, rides the one-round-trip
   * `prompt_deliver` instead.
   */
  async pressEnter(_socket: string, id: string): Promise<void> {
    await this.#send({ type: "input", sessionId: id, data: "\r" });
  }

  /**
   * The agent-side settle loop as ONE round-trip (`prompt_deliver`), with the
   * RPC deadline set to the settle budget + 30 s slack. Never throws —
   * mirrors {@link LocalLauncher.deliverPrompt}: any rpc error or malformed
   * answer reports `false`, letting the caller keep the pane anyway.
   */
  async deliverPrompt(
    _socket: string,
    id: string,
    text: string,
    settleTimeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    try {
      const data = await this.#send(
        { type: "prompt_deliver", sessionId: id, text, settleTimeoutMs, pollMs },
        settleTimeoutMs + PROMPT_DELIVER_SLACK_MS,
      );
      return parseNodePromptDeliver(data)?.promptDelivered ?? false;
    } catch {
      return false;
    }
  }

  /**
   * The pane log's path ON THE NODE (`<agentDataDir>/sessions/<id>.log`,
   * spec §6.4) — composed from the `ready` facts, no round-trip. Throws
   * {@link NoLiveConnectionError} when the node has no live `ready` (sync
   * member; there is no honest path to answer without facts).
   */
  logPath(id: string): string {
    return factsPath(this.#requireFacts(), `sessions/${id}.log`);
  }

  /**
   * The agent's per-session record ON THE NODE:
   * `<agentDataDir>/sessions/<id>.meta.json` — the twin of
   * `apps/agent/src/session-meta.ts` (`SessionMetaStore.metaPath` =
   * `join(dataDir, "sessions", `${id}${".meta.json"}`); pinned equal by test).
   * A deliberate kill leaves this file behind on purpose: the manager feeds it
   * into the delete-time `remove_paths` (with the log and the MCP config), so
   * a deleted session unlinks all three artifacts it left on the node.
   * Not on the {@link NodeLauncher} interface — the concept is agent-side
   * only; {@link LocalLauncher} has no meta file and its delete path stays
   * untouched. Throws {@link NoLiveConnectionError} offline (sync member,
   * same shape as {@link logPath}).
   */
  metaArtifactPath(id: string): string {
    return factsPath(this.#requireFacts(), `sessions/${id}.meta.json`);
  }

  /**
   * `log_read` (10 s) as the raw triple: the window, the resume offset, and
   * the whole-file size. Not on the frozen interface — the sanctioned
   * class-local shape for the tail-window math (Task 11's remote replay reads
   * `size` in one round-trip). {@link RemoteLauncher.readLog} stays the
   * interface's narrowed wrapper.
   */
  async readLogSized(
    id: string,
    fromByte: number,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; next: number; size: number }> {
    const data = await this.#send({ type: "log_read", sessionId: id, fromByte, maxBytes }, LOG_READ_TIMEOUT_MS);
    const r = parseNodeLogReadResult(data);
    if (!r) throw this.#malformed("log_read");
    return { bytes: Buffer.from(r.bytes_b64, "base64"), next: r.next, size: r.size };
  }

  /**
   * Byte-range read of the node's pane log; `next` is where a sequential
   * reader resumes. Reads AT EOF match {@link LocalLauncher.readLog} exactly
   * (empty, `next == fromByte`); BEYOND EOF the answer differs by agent
   * design — the agent clamps `next` to `size`, so a relay cursor parked
   * past the end can step back once on its first read.
   */
  async readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }> {
    const { bytes, next } = await this.readLogSized(id, fromByte, maxBytes);
    return { bytes, next };
  }

  /**
   * Last-window tail identical to {@link LocalLauncher.readLogTail}: one
   * `log_read(0, 1)` to learn `size`, one windowed read of the last
   * {@link LOG_TAIL_BYTES}, then the shared pure helper for line math. A
   * missing/empty log answers size 0 and reads as `{ lines: [], truncated:
   * false }`, same as local.
   */
  async readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }> {
    const { size } = await this.readLogSized(id, 0, 1);
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const { bytes } = await this.readLogSized(id, start, LOG_TAIL_BYTES);
    return tailLinesFromWindowText(Buffer.from(bytes).toString("utf8"), start === 0);
  }

  /**
   * Relay the agent's `output` frames for `subId` to `onChunk` as an ordered,
   * gap-free byte stream (spec §3.3). Order of operations is load-bearing:
   * subscribe FIRST, then send `tail_start` — the agent's `tail_start` result
   * resolves before its initial catch-up pump delivers, so a late subscribe
   * would drop those bytes. Events queue through an internal promise chain
   * (handlers may `await` a backfill without reordering later events):
   * - GAP (`ev.fromByte > cursor`): a scripted-window `log_read` backfills the
   *   missing span BEFORE the event's own bytes; a backfill delivering nothing
   *   (`next <= cursor` — the agent clamps empty reads to `size`) still lets
   *   the event through.
   * - DUP (`ev.fromByte < cursor`): the already-delivered prefix is sliced
   *   off (a redelivery after a partial backfill is not a restart).
   *
   * Once the disposer runs, `onChunk` never fires again — a task parked
   * mid-backfill when disposal lands discards its bytes on resume (local's
   * "disposed mid-read: the bytes belong to the next subscriber",
   * {@link LocalLauncher.tailStart}).
   *
   * @returns disposer: unsubscribes, disarms the relay, and fires `tail_stop`
   * (5 s, fire-and-forget)
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
    // Subscribe before the round-trip: the agent starts pumping as soon as
    // tail_start lands, and its result may arrive after the first frames.
    const unsubscribe = subscribeOutput(subId, (ev) => {
      if (ev.sessionId !== id) return;
      queue = queue
        .then(async () => {
          if (disposed) return; // already disposed: queued bytes belong to the next subscriber
          if (ev.fromByte > cursor) {
            const backfill = await this.readLog(id, cursor, ev.fromByte - cursor).catch(() => ({
              bytes: new Uint8Array(0),
              next: cursor,
            }));
            if (disposed) return; // disposed mid-backfill
            // Empty/clamped backfill ⇒ nothing to deliver; the event below still is.
            if (backfill.bytes.byteLength > 0 && backfill.next > cursor) {
              cursor = backfill.next;
              onChunk(backfill.bytes, cursor);
            }
          }
          let bytes: Uint8Array = Buffer.from(ev.data_b64, "base64");
          if (ev.fromByte < cursor) bytes = bytes.subarray(Math.max(0, cursor - ev.fromByte));
          if (bytes.byteLength === 0) return;
          if (disposed) return; // last gate before the event-delivery onChunk
          cursor = ev.toByte;
          onChunk(bytes, cursor);
        })
        .catch((err: unknown) => logger.withError(err).warn(`remote tail relay failed for ${id}`));
    });
    await this.#send({ type: "tail_start", sessionId: id, subId, fromByte }, TAIL_START_TIMEOUT_MS);
    return () => {
      disposed = true;
      unsubscribe();
      void this.#send({ type: "tail_stop", subId }, TAIL_STOP_TIMEOUT_MS).catch(() => undefined);
    };
  }

  /**
   * `probe_resume` — the agent runs the harness plugin's OWN transcript probe
   * on its machine (identical code to local). Any rpc error or malformed
   * answer is `false`: a dead/unreachable node can't resume, so the caller
   * falls back to a fresh id — exactly the local "transcript gone" behavior.
   */
  async canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean> {
    try {
      const data = await this.#send({ type: "probe_resume", harnessId: harness.id, harnessSessionId: storedId, cwd });
      return parseNodeProbeResume(data)?.canResume ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Ships one artifact (the MCP config) as a SINGLE `write_file` chunk
   * (chunk 0, eof) to `<agentDataDir>/mcp/<id>.json` (spec §6.4) — 30 s,
   * returns the path on the target machine. The agent's path policy admits
   * anything under its dataDir. The id is uuid-checked LOCALLY first
   * (mirroring the agent's `isSessionId`): an empty or traversal-y path must
   * never reach `write_file`, whose result validator echoes it back.
   */
  async writeArtifact(id: string, _kind: "mcp-config", content: string): Promise<string> {
    if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id "${id}"`);
    const path = factsPath(this.#requireFacts(), `mcp/${id}.json`);
    await this.#send(
      { type: "write_file", path, chunk_b64: Buffer.from(content, "utf8").toString("base64"), chunk: 0, eof: true },
      WRITE_FILE_TIMEOUT_MS,
    );
    return path;
  }

  /**
   * Best-effort `remove_paths` (10 s). The agent already swallows per-path
   * misses; every rpc error is caught here too — artifact cleanup must never
   * fail the flow that owns it (local's per-path try, same posture).
   */
  async removeArtifacts(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.#send({ type: "remove_paths", paths }, REMOVE_PATHS_TIMEOUT_MS);
    } catch (err) {
      logger.withError(err).debug(`node ${this.#nodeId}: remove_paths(${paths.length}) failed (best-effort)`);
    }
  }
}
