import type { HarnessPlugin } from "@internal/pane-runtime";
import {
  HARNESS_BINARY_PLACEHOLDER,
  type NodeCommandBody,
  type NodeProbeEntry,
  parseNodeCaptureResult,
  parseNodeLogReadResult,
  parseNodePaneSizeResult,
  parseNodePathExistsResult,
  parseNodeProbeEntries,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
} from "@internal/subshell-protocol";
import type { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { logger } from "@/utils/logger.js";
import { detectOnNodeBestEffort, readAgentInventory } from "./inventory.js";
import { LOG_TAIL_BYTES, tailLinesFromWindowText } from "./log-tail.js";
import { subscribeOutput } from "./node-events.js";
import type { LaunchPlan, NodeLauncher } from "./node-launcher.js";
import { getLive, type NodeAgentFacts } from "./node-registry.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, NodeRpcError, sendCommand } from "./node-rpc.js";

/**
 * `NodeLauncher` over the signed command RPC (spec 2026-08-31 §6.3) — every
 * machine-local operation a subshell needs, executed by the node's agent as
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
/**
 * Deadline for `pane_size` — shorter still than the cheap reads above.
 *
 * It sits on two hot paths: the resize queue holds its entry `busy` across
 * this round trip, and the attach waits on it AHEAD of the replay paint. The
 * default 10s would stall a viewer's first frame behind a wedged node for the
 * whole window; a missed readback merely costs the confirmation.
 */
const PANE_SIZE_TIMEOUT_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const LOG_READ_TIMEOUT_MS = 10_000;
const TAIL_START_TIMEOUT_MS = 10_000;
const TAIL_STOP_TIMEOUT_MS = 5_000;
const REMOVE_PATHS_TIMEOUT_MS = 10_000;
/** `deliverPrompt` waits for the agent's whole settle loop: its budget plus RPC slack. */
const PROMPT_DELIVER_SLACK_MS = 30_000;

/**
 * "Already gone" answers the agent gives for a dead pane (kill swallow class).
 * The alternatives match TMUX's own stderr VERBATIM — a `kill-session`/
 * `has-session` against a dead target prints "no session: <name>" or
 * "can't find session: <name>". This is third-party output: NEVER rename it
 * along with the product entity.
 */
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
  /**
   * Launch-driven detection kick (default {@link detectOnNodeBestEffort}).
   * Test seam: production passes nothing. Synchronous-throwing seams are
   * caught by the caller — the kick is total.
   */
  detect?: (nodeId: string) => void;
}

/**
 * Thrown synchronously when a facts-dependent method runs with no live
 * connection — the RPC-path twin is `NodeRpcError("offline")`; both classes
 * mean §5.6 NODE_OFFLINE to callers. Exported as the sentinel the create-path
 * mapper checks (`instanceof`, never the message text) so Task 10 may reword
 * the message without breaking the 409 mapping.
 */
export class NoLiveConnectionError extends Error {}

/**
 * True for either sentinel class of "that node has no live agent connection":
 * {@link NoLiveConnectionError} (the sync throw the facts guard raises) and the
 * RPC-path twin `NodeRpcError("offline")`. Both are §5.6 NODE_OFFLINE to
 * callers; the two mappers import this instead of re-spelling the predicate —
 * `subshells.service.rethrowUnlessNodeOffline` (create/restart/log-tail →
 * structured 409) and `subshell-manager.terminateSubshell` (the kill step
 * swallows ONLY these, retiring the row `killUnverified`). `instanceof` only —
 * the mapping is deliberately not text-coupled, so either message may be
 * reworded without breaking the 409 mapping.
 */
export function isNodeOfflineError(err: unknown): boolean {
  return err instanceof NoLiveConnectionError || (err instanceof NodeRpcError && err.code === "offline");
}

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

  /**
   * Fire-and-forget DETECTION kick (spec 2026-09-10 §4, rewired from the
   * `inventory` command by Task 7): never awaited, errors go to debug.
   *
   * The old refresh sent `{type:"inventory"}`. Since the agent lost its
   * plugin concept (inversion §6), that command's only write-back is the
   * empty `harnesses: []` claim the `/ws/node` handler rightly refuses to
   * apply (the H2 guard), so the round trip stored NOTHING — the kick here
   * is what actually refreshes the snapshot now: the plane ships its detect
   * rules, the node probes, and the answer merges over the cache. What feeds
   * `inventory_json` freshness: node-page load, Re-check, and these
   * launch-driven kicks (a launch IS a human request — spec §4's trigger).
   * The agent's 5-min inventory push stays on the wire but carries nothing,
   * and Task 8 removes it.
   */
  #kickDetect(): void {
    try {
      (this.#deps.detect ?? detectOnNodeBestEffort)(this.#nodeId);
    } catch (err: unknown) {
      // Only a throwing seam can land here; the default never throws. The
      // kick is fire-and-forget — nothing that observes it may learn it broke.
      logger.withError(err).debug(`node ${this.#nodeId}: on-demand detection kick failed`);
    }
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
   * kicks an unawaited detection pass ({@link #kickDetect}) so the next
   * launch sees fresh data. Absent node row / absent entry read as null
   * (not installed).
   */
  async resolveBinary(harness: HarnessPlugin): Promise<string | null> {
    const nodes = this.#deps.nodes ?? getRequestlessContext().repos.nodes;
    const node = await nodes.findById(this.#nodeId);
    if (!node) return null;
    const inv = readAgentInventory(node);
    if (inv.stale) this.#kickDetect();
    return inv.entries.get(harness.id)?.binaryPath ?? null;
  }

  /**
   * One `launch` command (60 s) carrying the structured plan (spec §6.4), plus
   * the inversion's three additive fields (spec 2026-09-10 §5) — every one of
   * them optional, so today's agent ignores them and composes the pane command
   * with ITS env and ITS harness plugin exactly as before; the consumer switch
   * is Task 4:
   * - `argv`: the complete command line, built HERE from the plugin's
   *   `buildCommand` with {@link HARNESS_BINARY_PLACEHOLDER} in the binary
   *   slot. The plan's `binary` is deliberately NOT used: an inventory can be
   *   minutes old and predate an upgrade, so the node substitutes its own
   *   freshly resolved path at the moment of spawn.
   * - `resolve`: the plugin manifest's `subshell.detect` block passed straight
   *   through — the rule for that lookup, the same data the node's own
   *   detection reads. Absent for a plugin that declares no binary.
   * - `mcp`: `{ path, fileContent }` as today, now plus the `args`/`env`
   *   dialect `plan.mcp` already holds, so the node stops recomputing them
   *   once Task 4 lands. The caller composes `path` from the node's
   *   `ready.dataDir`.
   * A `binary missing` failure means our cached path was stale: kick the
   * detection pass (unawaited, {@link #kickDetect}) before rethrowing
   * (spec §6.2, detection-shaped by Task 7).
   */
  async launch(plan: LaunchPlan): Promise<void> {
    if (plan.mcp && !plan.mcpConfigPath) {
      // The frozen wire needs a target path; shipping content without one is
      // a caller bug — fail locally rather than send a frame the agent rejects.
      throw new Error(`remote launch of "${plan.id}": LaunchPlan.mcpConfigPath is required when mcp is set`);
    }
    const argv = plan.harness.buildCommand({
      binary: HARNESS_BINARY_PLACEHOLDER,
      cwd: plan.cwd,
      profile: plan.profile,
      subshellName: plan.subshellName,
      mcp: plan.mcp,
      harnessSession: plan.harnessSession,
    });
    const cmd: NodeCommandBody = {
      type: "launch",
      subshellId: plan.id,
      socket: plan.socket,
      cwd: plan.cwd,
      harnessId: plan.harness.id,
      profile: plan.profile,
      subshellEnv: plan.subshellEnv,
      mcp: plan.mcp
        ? {
            path: plan.mcpConfigPath as string,
            fileContent: plan.mcp.fileContent,
            // Conditional spreads, never bare `args: plan.mcp.args`: the
            // frame's parser refuses an explicit-undefined optional, and an
            // absent half of a dialect must stay absent on the object too, not
            // just survive the JSON.stringify the RPC does.
            ...(plan.mcp.args ? { args: plan.mcp.args } : {}),
            ...(plan.mcp.env ? { env: plan.mcp.env } : {}),
          }
        : undefined,
      harnessSession: plan.harnessSession,
      subshellName: plan.subshellName,
      bestEffortLog: plan.bestEffortLog,
      argv,
      ...(plan.harness.detectSpec ? { resolve: plan.harness.detectSpec } : {}),
    };
    try {
      await this.#send(cmd, LAUNCH_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof NodeRpcError && err.code === "failed" && BINARY_MISSING_RE.test(err.message)) {
        this.#kickDetect();
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
    await this.#send({ type: "terminate", subshellId: id });
  }

  /**
   * Best-effort `kill`. The agent's own executor already swallows tmux's
   * "already gone"; a `failed` whose message matches the tmux-verbatim
   * {@link ALREADY_GONE_RE} is the same class arriving through older/other
   * paths — mapped to a no-op. Anything else rethrows.
   */
  async killSubshell(_socket: string, id: string): Promise<void> {
    try {
      await this.#send({ type: "kill", subshellId: id });
    } catch (err) {
      if (err instanceof NodeRpcError && err.code === "failed" && ALREADY_GONE_RE.test(err.message)) return;
      throw err;
    }
  }

  /** One-entry `probe` (5 s) → the row for `id` (the agent echoes subshellId). */
  async #probeEntry(subshellId: string): Promise<NodeProbeEntry | undefined> {
    const data = await this.#send({ type: "probe", subshellIds: [subshellId] }, PROBE_TIMEOUT_MS);
    const entries = parseNodeProbeEntries(data);
    if (!entries) throw this.#malformed("probe");
    return entries[0];
  }

  /** `probe` row liveness (spec §6.3 reconcile shape). */
  async hasSubshell(_socket: string, id: string): Promise<boolean> {
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

  /**
   * `capture` (10 s) → the pane's visible grid (plus up to `scrollbackLines`
   * reflowed history rows when asked) as a bare string. The field is optional
   * on the wire: an agent predating it strips the unknown key and answers
   * with the visible grid only — a graceful degrade to the old replay.
   */
  async capture(_socket: string, id: string, scrollbackLines?: number): Promise<string> {
    const data = await this.#send(
      scrollbackLines && scrollbackLines > 0
        ? { type: "capture", subshellId: id, lines: scrollbackLines }
        : { type: "capture", subshellId: id },
    );
    const text = parseNodeCaptureResult(data);
    if (text === null) throw this.#malformed("capture");
    return text;
  }

  /** `resize` verbatim — the agent fits the pane window like tmux does. */
  async resize(_socket: string, id: string, cols: number, rows: number): Promise<void> {
    await this.#send({ type: "resize", subshellId: id, cols, rows });
  }

  /**
   * The pane's REAL grid, from the agent's `pane_size` command.
   *
   * Null means the pane is gone — never an echo of the requested size, which
   * would be indistinguishable from a real readback and would defeat the
   * point of confirming.
   */
  async paneSize(_socket: string, id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      return parseNodePaneSizeResult(await this.#send({ type: "pane_size", subshellId: id }, PANE_SIZE_TIMEOUT_MS));
    } catch (err) {
      // Null is read by the caller as "the pane died", so a wedged-but-
      // connected node would silently stop every geometry announcement for
      // that pane with nothing in the journal. The answer stays null — there
      // is nothing honest to announce — but it is visible. Debug, not warn: a
      // node dropping mid-question is ordinary, and this runs on every resize.
      if (err instanceof NodeRpcError) {
        logger.debug(`pane_size failed for ${id} on node ${this.#nodeId}: ${err.message}`);
      } else {
        logger.withError(err).warn(`pane_size failed unexpectedly for ${id}`);
      }
      return null;
    }
  }

  /**
   * Not yet deliverable on a node: there is no `winch` command in the agent
   * protocol (spec §6.4), so this honestly answers "no" — the attach path
   * falls through to the ±1-column resize nudge, the pre-2026-09-04 behavior,
   * for remote panes. Adding the command means a client release (protocol +
   * agent); the local path needed the fix first because that is where the
   * minute-scale phone reattaches hammer the pane's history.
   */
  // No `winch` command in the agent protocol yet (and no local pid on the
  // node's caller side): false routes the attach back to its ±1 nudge fallback.
  async signalPaneWinch(): Promise<boolean> {
    return false;
  }

  /** `input` verbatim, byte for byte (the agent's `send-keys -l --`). */
  async sendInput(_socket: string, id: string, input: string): Promise<void> {
    await this.#send({ type: "input", subshellId: id, data: input });
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
        { type: "prompt_deliver", subshellId: id, text, settleTimeoutMs, pollMs },
        settleTimeoutMs + PROMPT_DELIVER_SLACK_MS,
      );
      return parseNodePromptDeliver(data)?.promptDelivered ?? false;
    } catch {
      return false;
    }
  }

  /**
   * The pane log's path ON THE NODE (`<agentDataDir>/subshells/<id>.log`,
   * spec §6.4) — composed from the `ready` facts, no round-trip. Throws
   * {@link NoLiveConnectionError} when the node has no live `ready` (sync
   * member; there is no honest path to answer without facts).
   */
  logPath(id: string): string {
    return factsPath(this.#requireFacts(), `subshells/${id}.log`);
  }

  /**
   * The agent's per-subshell record ON THE NODE:
   * `<agentDataDir>/subshells/<id>.meta.json` — the twin of
   * `apps/node/agent/src/subshell-meta.ts` (`SubshellMetaStore.metaPath` =
   * `join(dataDir, "subshells", `${id}${".meta.json"}`); pinned equal by test).
   * A deliberate kill leaves this file behind on purpose: the manager feeds it
   * into the delete-time `remove_paths` (with the log and the MCP config), so
   * a deleted subshell unlinks all three artifacts it left on the node.
   * Class-local (not on {@link NodeLauncher}) — the concept is agent-side
   * only; {@link LocalLauncher} has no meta file. Throws
   * {@link NoLiveConnectionError} offline (sync member, same shape as
   * {@link logPath}).
   */
  metaArtifactPath(id: string): string {
    return factsPath(this.#requireFacts(), `subshells/${id}.meta.json`);
  }

  /**
   * The subshell's MCP registration ON THE NODE: `<agentDataDir>/mcp/<id>.json`
   * (spec §6.4) — the delete-side twin of the launch-side path
   * `mcp-launch.ts`'s `planRemoteSubshellMcp` composes into the `launch`
   * command from the same facts. The template is deliberately duplicated, not
   * imported: `mcp-launch → remote-launcher → lib/context → subshells.service →
   * subshell-manager → mcp-launch` is a cycle (pinned pair — change one, change
   * both). Throws {@link NoLiveConnectionError} offline (sync member, same
   * shape as {@link logPath}).
   */
  mcpArtifactPath(id: string): string {
    return factsPath(this.#requireFacts(), `mcp/${id}.json`);
  }

  /**
   * The three files a subshell leaves on the node — log + MCP config + the
   * agent's own meta record, in the order the pre-seam `deleteSubshell` block
   * pushed them (spec §6.4). Empty when the node has no live `ready` facts:
   * no facts, no layout to name paths from, and the artifacts age out with
   * the node — the same offline skip every pre-seam path made individually.
   */
  subshellArtifacts(id: string): string[] {
    if (!this.#facts()) return [];
    return [this.logPath(id), this.mcpArtifactPath(id), this.metaArtifactPath(id)];
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
    const data = await this.#send({ type: "log_read", subshellId: id, fromByte, maxBytes }, LOG_READ_TIMEOUT_MS);
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
   * (5 s, fire-and-forget). Idempotent — a second call is a no-op, so a
   * double cleanup (close after an error-path teardown) never sends a
   * duplicate `tail_stop` (local-twin parity, {@link LocalLauncher.tailStart}).
   * @throws whatever the `tail_start` round-trip rejects with — after first
   * unsubscribing the bus handler (the disposer is the only unsubscribe path,
   * and a rejecting send means the caller never receives one).
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
      if (ev.subshellId !== id) return;
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
    try {
      await this.#send({ type: "tail_start", subshellId: id, subId, fromByte }, TAIL_START_TIMEOUT_MS);
    } catch (err) {
      // The disposer below is the ONLY unsubscribe path — a rejecting
      // round-trip means the caller never gets one, so drop the bus handler
      // here (bytes queued for this subId go unread; the next attach
      // replays). Worst case the agent DID process `tail_start` and its
      // result died mid-drop: it then tails a sub nobody reads — the caller
      // owns that concern (its teardown closes the socket); this guard at
      // least never leaks the handler into the connection's lifetime.
      unsubscribe();
      throw err;
    }
    return () => {
      if (disposed) return; // idempotent: a double cleanup must not re-send tail_stop
      disposed = true;
      unsubscribe();
      void this.#send({ type: "tail_stop", subId }, TAIL_STOP_TIMEOUT_MS).catch(() => undefined);
    };
  }

  /**
   * Resume, inverted (spec 2026-09-10 §5): the path is computed HERE with the
   * plugin's pure `resumePath` — from the node's `ready`-reported `homeDir`
   * and manifest-declared `env` — and the node only stats the finished path
   * (`path_exists`). The node holds no plugin code to ask, and the local and
   * remote paths now run the SAME plugin code, one on each side of "does this
   * file exist".
   *
   * A plugin without `resume` never reaches the wire (the question cannot be
   * phrased); facts are NOT required — a node that reported no env computes
   * the plugin's default path anyway, which probes honestly. Any rpc error
   * or malformed answer is `false`: a dead/unreachable node can't resume, so
   * the caller falls back to a fresh id — exactly the local "transcript
   * gone" behavior.
   */
  async canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean> {
    const resume = harness.resume;
    if (!resume) return false;
    try {
      const facts = this.#facts();
      const path = resume.resumePath(storedId, cwd, { homeDir: facts?.homeDir ?? "", env: facts?.env ?? {} });
      const data = await this.#send({ type: "path_exists", path });
      return parseNodePathExistsResult(data)?.exists ?? false;
    } catch {
      return false;
    }
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
