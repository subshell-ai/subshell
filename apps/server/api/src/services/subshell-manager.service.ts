import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { BackendErrorCodes, stripAnsi, throwApiError } from "@internal/backend-errors";
import {
  allHarnesses,
  getHarness,
  type HarnessPlugin,
  type McpRegistration,
  type ReporterSpec,
  type TmuxRunner,
  TmuxTimeoutError,
  tmuxSocketFor,
} from "@internal/pane-runtime";
import {
  dirAllowed,
  type NodeEvent,
  type NodeProbeEntry,
  normalizeLabel,
  parseNodeProbeEntries,
} from "@internal/subshell-protocol";
import { harnessUsable } from "@/api/harness-utils.js";
import type { PresetsRepository } from "@/db/repositories/presets.repository.js";
import type { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SubshellTable, SubshellUpdate } from "@/db/types/subshells.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import type { Access } from "@/lib/subshell-access.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { publishLive } from "@/services/live-bus.js";
import {
  nodeSelfInvoke,
  planRemoteSubshellMcp,
  registerSubshellMcp,
  subshellMcpConfigPath,
  subshellMcpEnv,
} from "@/services/mcp-launch.js";
import { probeReporterLaunch } from "@/services/mcp-resolve.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { getLive, isNodeOffline, type NodeFacts } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import {
  LOCAL_PREVIEW_TTL_MS,
  previewCacheDrop,
  previewCacheGet,
  previewCachePut,
} from "@/services/nodes/preview-cache.js";
import { isNodeOfflineError } from "@/services/nodes/remote-launcher.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { getNotifyService, type NotifyKind } from "@/services/notify.service.js";
import { EMPTY_PRESET, parsePreset } from "@/services/preset-definition.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";

/** The subshell-token lifecycle operations the manager triggers. Injectable
 * for test isolation; defaults to the real better-auth-backed functions. */
export interface SubshellTokenProvider {
  /** Mints the subshell's MCP API key; returns the plaintext (once). */
  issue(subshellId: string, userId: string): Promise<string>;
  /** Disables the subshell's token (no-op when absent). */
  revoke(subshellId: string): Promise<void>;
}

/** How long to wait for a fresh pane to show output before giving up typing. */
const PROMPT_SETTLE_TIMEOUT_MS = 15_000;
/** tmux's initial `pane_title` on an untouched pane is the host name. */
const HOST_NAME = hostname();
/** Poll interval while waiting for the pane to settle. */
const PROMPT_POLL_MS = 400;
/**
 * Subshell ids per `probe` command in the reconcile sweep (spec §6.3): one
 * round-trip probes this many panes (liveness + exit + title + opportunistic
 * capture). Sized under the agent's frame budget so captures ride along.
 */
const PROBE_BATCH_MAX = 24;
/** The sweep's probe deadline — wider than a single RPC (batched work on the node). */
const RECONCILE_PROBE_TIMEOUT_MS = 30_000;

const defaultTokens: SubshellTokenProvider = {
  issue: issueSubshellToken,
  revoke: revokeSubshellToken,
};

/**
 * In-flight manual restarts, shared process-wide by SUBSHELL ID.
 *
 * The HTTP request handler, the 60 s reconcile sweep (`index.ts`) and the
 * `subshell mcp` server each build their OWN `SubshellManagerService`, so a
 * per-instance map would be inert: two restart clicks (two tabs, list +
 * detail, web + MCP) would each spawn, and the sweep would see the parked row
 * and revoke the token the restart just minted. Living at module scope, every
 * instance JOINS the one in-flight revival, and `reconcileRows` skips any id
 * present here (its pane is deliberately absent mid-restart). The entry is
 * added synchronously before the first await and removed in `finally`.
 */
const restartInFlight = new Map<string, Promise<{ id: string; tmuxSocket: string } | null>>();

/** The app-wide push notifier, used when no sink is injected. */
const defaultNotify: (subshellId: string, kind: NotifyKind) => Promise<void> = async (id, kind) => {
  // Static import (module-level) — dynamic imports break `bun build --compile`.
  // The singleton resolves at CALL time, so suites that inject a spy never
  // construct the real notify service (and never load web-push).
  await getNotifyService().notifySubshell(id, kind);
};

/**
 * Orchestrates agent subshells: validate inputs, spawn a tmux-backed harness,
 * stream output to a per-subshell log file, and reconcile DB state with what
 * tmux reports.
 */
export class SubshellManagerService {
  readonly #subshells: SubshellsRepository;
  readonly #presets: PresetsRepository;
  /**
   * Constructor-injected launcher (or the deprecated `tmux` shim wrapped in
   * one). A TEST OVERRIDE: when set it answers for EVERY node id, so the
   * phase-0 subshell-manager suites keep working untouched.
   */
  readonly #testLauncher: NodeLauncher | undefined;
  readonly #audit: (event: AuditEventInput) => Promise<void>;
  readonly #tokens: SubshellTokenProvider;
  readonly #notify: (subshellId: string, kind: NotifyKind) => Promise<void>;
  /** The reconciler's node wire (default `sendCommand`); injectable for tests. */
  readonly #sendNode: typeof sendCommand;

  constructor({
    subshells,
    presets,
    tmux,
    audit = defaultAudit,
    tokens = defaultTokens,
    notify = defaultNotify,
    launcher,
    sendNode = sendCommand,
  }: {
    subshells: SubshellsRepository;
    presets: PresetsRepository;
    /**
     * @deprecated test-compat shim — wrapped in a {@link LocalLauncher} when
     * no `launcher` is given, so MockTmux-style injection keeps working.
     */
    tmux?: TmuxRunner;
    /** Audit sink (default: the app-wide best-effort recorder). Injectable for test isolation. */
    audit?: (event: AuditEventInput) => Promise<void>;
    /** Subshell-token lifecycle (default: better-auth api-keys). Injectable for tests. */
    tokens?: SubshellTokenProvider;
    /** Push sink fired on the alive→dead reconcile transition (default: the app-wide notify service). Injectable for test isolation. */
    notify?: (subshellId: string, kind: NotifyKind) => Promise<void>;
    /**
     * Machine interface for this manager's subshells. TEST OVERRIDE: when set
     * it answers for every node id (see {@link #testLauncher}); production
     * callers pass nothing and get per-node routing via `#launcherFor`.
     */
    launcher?: NodeLauncher;
    /**
     * Signed-command wire for the reconcile sweep's batched `probe` (default:
     * the real `sendCommand`). Injectable for test isolation — the ONLY
     * consumer is the sweep's agent branch.
     */
    sendNode?: typeof sendCommand;
  }) {
    this.#subshells = subshells;
    this.#presets = presets;
    this.#testLauncher = launcher ?? (tmux !== undefined ? new LocalLauncher({ tmux }) : undefined);
    this.#audit = audit;
    this.#tokens = tokens;
    this.#notify = notify;
    this.#sendNode = sendNode;
  }

  /**
   * The launcher for one node id: the injected test override wins for EVERY
   * node (phase-0 suites keep their scripted machine), otherwise the shared
   * registry resolves `local` to the LocalLauncher and agent ids to a cached
   * RemoteLauncher (spec §6.3).
   * @param nodeId - the row's node id (`local` = control-plane host)
   */
  #launcherFor(nodeId: string): NodeLauncher {
    return this.#testLauncher ?? launcherFor(nodeId);
  }

  /**
   * The machine for the paths that stay deliberately local: local view
   * previews and the LOCAL half of the reconcile
   * sweep. Agent rows NEVER probe through it — the sweep batches their
   * liveness into per-node `probe` commands (spec §6.3), so an online agent
   * row can never false-crash against a local tmux lookup. Exactly
   * `#launcherFor(LOCAL_NODE_ID)`: the test override wins, otherwise the
   * registry's shared default LocalLauncher.
   */
  get #localLauncher(): NodeLauncher {
    return this.#launcherFor(LOCAL_NODE_ID);
  }

  /**
   * Decides the conversation identity for one launch (restart-resume).
   * Returns undefined when the harness has no resume story — then nothing
   * is pinned and every launch starts a fresh conversation, as before.
   *
   * `storedId` is what an earlier launch of this lineage pinned. It is only
   * trusted when the launcher finds the transcript the plugin's pure
   * `resumePath` names actually present on the machine that runs the pane
   * (`canResume`): a resumed-but-never-used launch never wrote one, and a
   * wiped harness state dir removed it — handing Claude a dead id prints
   * "No conversation found" and exits, killing the pane. When the stored id
   * cannot be resumed a FRESH id is allocated (never the old one: pinning
   * `--session-id` on an id that exists somewhere would fail the launch),
   * and the caller persists it on the row being launched.
   */
  async #planHarnessSession(
    launcher: NodeLauncher,
    harness: HarnessPlugin,
    storedId: string | null,
    cwd: string,
  ): Promise<{ id: string; mode: "start" | "resume" } | undefined> {
    if (!harness.resume) return undefined;
    if (storedId && (await launcher.canResume(harness, storedId, cwd))) {
      return { id: storedId, mode: "resume" };
    }
    return { id: harness.resume.allocateHarnessSessionId(), mode: "start" };
  }

  /**
   * Compose the MCP registration for one launch on one node (spec §6.4).
   * Local rows keep today's write-the-file path; agent rows get the PURE
   * remote plan (dialect computed control-side, content shipped with the
   * launch command) — gated on the node advertising the `"mcp"` capability,
   * and on the node still having live `ready` facts (its connection dropped
   * between resolution and launch ⇒ the same offline-flavored throw
   * `sendCommand` produces, so rollback and the 409 mapping treat it alike).
   * @throws NodeRpcError code "offline" for an agent node with no live facts
   */
  #planMcp(
    harness: HarnessPlugin,
    subshellId: string,
    nodeId: string,
  ): { mcp?: McpRegistration; mcpConfigPath?: string; facts?: NodeFacts } {
    if (nodeId === LOCAL_NODE_ID) return { mcp: registerSubshellMcp(harness, subshellId) };
    const facts = getLive(nodeId)?.agent;
    if (!facts) throw new NodeRpcError("offline", `node "${nodeId}" has no live connection`, nodeId);
    if (!facts.capabilities.includes("mcp")) {
      logger.debug(
        `subshell ${subshellId}: node "${nodeId}" did not advertise the "mcp" capability; subshell mcp not registered for this launch`,
      );
      return { facts };
    }
    const planned = planRemoteSubshellMcp(harness, subshellId, facts);
    return planned ? { mcp: planned.reg, mcpConfigPath: planned.configPath, facts } : { facts };
  }

  /**
   * How a harness hook re-enters the subshell binary ON THE TARGET MACHINE.
   *
   * Resolved per target and never once for the process: `local` panes run
   * beside this binary, an agent's panes run beside the node's own — so the
   * plane's `execPath` is the right answer for exactly one of them, and the
   * wrong one everywhere else. Deliberately NOT gated on the `mcp` capability
   * that {@link #planMcp} checks: hooks report attention and conversation
   * identity, neither of which is an MCP feature, and an agent that
   * advertises no mcp still has the binary the plane is naming.
   *
   * Undefined means nothing resolved (an exotic local deployment, or a node
   * that reported no `selfInvoke`); the plugin then omits its hooks rather
   * than baking a command the pane cannot run.
   */
  #planReporter(nodeId: string, facts?: NodeFacts): ReporterSpec | undefined {
    if (nodeId === LOCAL_NODE_ID) return probeReporterLaunch().spec ?? undefined;
    return facts ? nodeSelfInvoke(facts, "report") : undefined;
  }

  /**
   * Creates a new subshell: validates the (optional) preset + working
   * directory, records the DB row, mints the subshell's MCP token, then
   * spawns the harness under tmux with a curated env (including the injected
   * SUBSHELL_* credentials). When `prompt` is given, it is typed into the
   * pane once the harness has settled.
   * @throws Error "Preset not found" (a given preset absent or foreign),
   *         "Preset harness mismatch" (the preset's harness ≠ `harnessId`),
   *         "Unknown harness: …" — the route gates these first; this is the
   *         same contract under a plain Error for every other caller.
   */
  async createSubshell({
    userId,
    harnessId,
    presetId,
    workingDir,
    name,
    prompt,
    promptSettleTimeoutMs,
    promptPollMs,
    resumeFromId,
    notify,
    nodeId,
  }: {
    userId: string;
    /** Harness plugin to launch — required, with or without a preset. */
    harnessId: string;
    /** Preset row to launch with; absent/null = the launch composes from EMPTY_PRESET. */
    presetId?: string | null;
    workingDir: string;
    name?: string;
    /** Optional task text typed into the pane after the harness settles. */
    prompt?: string;
    /** Settle-window overrides (tests; production uses the module defaults). */
    promptSettleTimeoutMs?: number;
    promptPollMs?: number;
    /**
     * Harness conversation id pinned by a predecessor subshell (restart
     * lineage). When the harness supports resume and the conversation still
     * exists, THIS subshell continues it instead of starting fresh.
     */
    resumeFromId?: string | null;
    /**
     * Ring the owner's devices for this subshell's attention events. Omitted
     * = the silent default; restart passes the source row's bell so operator
     * monitoring survives a restart.
     */
    notify?: boolean;
    /**
     * Node to launch on (§6.6 — already authorized by the caller's
     * `resolveLaunchNode`; absent = the control-plane host). Everything
     * machine-local below — cwd check, binary lookup, spawn, MCP compose —
     * runs against THIS node's launcher.
     */
    nodeId?: string;
  }): Promise<{ id: string; tmuxSocket: string; apiKey: string; promptDelivered: boolean }> {
    const presetRow = presetId ? await this.#presets.findById(presetId) : undefined;
    if (presetId && (!presetRow || presetRow.userId !== userId)) {
      throw new Error("Preset not found");
    }
    if (presetRow && presetRow.harnessId !== harnessId) {
      throw new Error("Preset harness mismatch");
    }
    const harness = getHarness(harnessId);
    if (!harness) {
      throw new Error(`Unknown harness: ${harnessId}`);
    }

    const targetNode = nodeId ?? LOCAL_NODE_ID;
    const launcher = this.#launcherFor(targetNode);
    const realPath = await launcher.validateWorkingDir(workingDir);
    await assertDirAllowed(targetNode, realPath);
    const preset = presetRow ? parsePreset(presetRow) : EMPTY_PRESET;
    const binary = await launcher.resolveBinary(harness);
    if (!binary) {
      throw new Error(`Harness "${harness.name}" is not installed on this machine.`);
    }

    const id = crypto.randomUUID();
    const socket = tmuxSocketFor(id);
    // Display name vs LAUNCH name (titling spec 2026-09-03): only a name a
    // HUMAN chose travels to the pane command — an unnamed create passes ""
    // so the plugins omit `--name`, the harness titles its own pane, and the
    // reconcile sweep adopts those titles into the row (whose displayed name
    // stays the agent's own until the first one lands).
    // The name goes through the SAME label rule every other human-chosen
    // string obeys (2026-09-23): this value is interpolated into the restart
    // journal line below, baked into the launch argv and the harness env, and
    // re-normalizing here is the choke point no caller can route around. A
    // name that normalizes to nothing is an UNNAMED create — the pre-existing
    // meaning of "", which `name?.trim()` already produced for "   ".
    const userNamed = normalizeLabel(name ?? "", 120);
    const subshellName = userNamed || defaultSubshellName(harness.name);
    // Restart-resume plan: continue the predecessor's conversation when it
    // survived, else pin a fresh id this subshell will be resumed by later.
    const harnessSession = await this.#planHarnessSession(launcher, harness, resumeFromId ?? null, realPath);

    // Record intent in the DB first so the row exists even if tmux errors.
    // The preset's auto-restart policy is inherited at creation time; a
    // presetless launch inherits nothing (0 = no auto-restart).
    await this.#subshells.create({
      id,
      userId,
      presetId: presetRow?.id ?? null,
      harnessId,
      name: subshellName,
      workingDir: realPath,
      tmuxSocket: socket,
      // The launch node rides on the row: every later per-row operation
      // (terminate, restart, delete, reconcile) routes its launcher from it.
      nodeId: targetNode,
      // A fresh subshell shows as active until real output lands.
      lastOutputAt: new Date().toISOString(),
      alive: 1,
      startedAt: new Date().toISOString(),
      restartOnExit: presetRow?.restartOnExit ?? 0,
      harnessSessionId: harnessSession?.id ?? null,
      // Default-silent unless explicitly requested (restart inherits the bell).
      notify: notify ? 1 : 0,
    });

    // The token is minted AFTER the row exists (issueSubshellToken writes the
    // api-key id back onto it) but BEFORE tmux starts, so the plaintext key is
    // baked into the harness env.
    const apiKey = await this.#tokens.issue(id, userId);

    let promptDelivered = false;
    try {
      // Register `subshell mcp` with the harness, in whatever dialect the plugin
      // speaks: claude gets --mcp-config argv, opencode a merged config layer
      // + OPENCODE_CONFIG (baked below); harnesses without a per-subshell
      // format (hermes, pi) register nothing — their SUBSHELL_* env still lands,
      // and the UI shows their one-time manual registration steps. Agent
      // rows get the PURE plan (no local file; content ships with the launch
      // command to the node's own path). INSIDE the try: an agent that
      // dropped offline between resolution and here must roll back too.
      const { mcp, mcpConfigPath, facts } = this.#planMcp(harness, id, targetNode);
      const reporter = this.#planReporter(targetNode, facts);
      const subshellEnv = subshellMcpEnv(apiKey, id, subshellName);
      if (facts) {
        // subshellMcpEnv bakes the BACKEND's SUBSHELL_SERVER_DATA_DIR — a path that
        // means nothing on the node; the agent's own dataDir is the truth there.
        subshellEnv.SUBSHELL_DATA_DIR = facts.dataDir;
      }
      // Command assembly happens INSIDE launch, which runs inside this try:
      // a rejected env key throws there, and the row + token must roll back
      // like any other spawn failure below.
      await launcher.launch({
        id,
        socket,
        harness,
        binary,
        cwd: realPath,
        preset,
        subshellName: userNamed,
        subshellEnv,
        mcp,
        mcpConfigPath,
        harnessSession,
        reporter,
      });
      if (prompt?.trim()) {
        promptDelivered = await this.#deliverPrompt(
          launcher,
          socket,
          id,
          prompt.trim(),
          promptSettleTimeoutMs ?? PROMPT_SETTLE_TIMEOUT_MS,
          promptPollMs ?? PROMPT_POLL_MS,
        );
      }
    } catch (err) {
      // A throw AFTER a successful newSubshell (the strict pipe-pane path, or
      // anything else past the spawn) would otherwise orphan a live harness
      // under the terminated row: best-effort kill FIRST. killSubshell
      // swallows "already gone", and the try/catch keeps any other kill
      // failure from masking the original error or skipping the rollback.
      try {
        await launcher.killSubshell(socket, id);
      } catch {
        // kill is best-effort; the row + token rollback below must still run
      }
      await this.#subshells.markTerminated(id, new Date().toISOString());
      await this.#revokeTokenOrUnlink(id);
      publishLive({ kind: "subshell.changed", id });
      throw err;
    }

    // Post-spawn re-read, the create-path twin of `#reviveRow`'s conditional
    // revival — which create never had. The row is written BEFORE the spawn,
    // so anything that retires rows in bulk between the two (a maintenance
    // window opening, which stops every running row on the node, or a plain
    // terminate) leaves a LIVE pane under a `terminated` row: the reconcile
    // sweep only walks `running` rows, so nothing would ever find it again.
    // Kill what we just started rather than return a success the database
    // contradicts.
    const settled = await this.#subshells.findById(id);
    if (settled?.status !== "running") {
      logger.warn(`subshell ${id} was retired during launch; killing the orphan pane and revoking its token`);
      try {
        await launcher.killSubshell(socket, id);
      } catch {
        // kill is best-effort; the token rollback below must still run
      }
      await this.#revokeTokenOrUnlink(id);
      // A 409, not the 500 a bare Error would produce: losing this race is a
      // legitimate concurrent act (a maintenance window, a terminate) rather
      // than a fault, and the caller's remedy is to try again. The cause is
      // deliberately NOT named — this path cannot tell a maintenance flip from
      // an ordinary terminate, and guessing would put the wrong reason in
      // front of whoever reads it.
      throwApiError({
        code: BackendErrorCodes.SUBSHELL_STOPPED_WHILE_STARTING,
        message: "The subshell was stopped while it was starting",
        doNotLog: true,
      });
    }

    logger.info(`subshell created: ${id} (${subshellName}) harness=${harnessId} cwd=${realPath} node=${targetNode}`);
    // Audit trail: best-effort sink (default app-wide recorder), never throws.
    await this.#audit({
      actorUserId: userId,
      action: "subshell.create",
      targetType: "subshell",
      targetId: id,
      metadataJson: JSON.stringify({
        name: subshellName,
        harnessId,
        presetId: presetId ?? null,
        workingDir: realPath,
        nodeId: targetNode,
      }),
    });
    // The launch SUCCEEDED: announce the act once, here, rather than at each
    // of the writes it made (row, token, post-spawn patch). The publisher
    // coalesces per id anyway, but announcing the act is what makes this a
    // domain event instead of a change-data feed.
    publishLive({ kind: "subshell.changed", id });
    return { id, tmuxSocket: socket, apiKey, promptDelivered };
  }

  /**
   * Types a creation prompt into a freshly-spawned pane once the harness has
   * produced output. The settle loop itself lives behind the launcher seam
   * ({@link NodeLauncher.deliverPrompt}) — it mirrors the phase-2
   * `prompt_deliver` command so a remote agent runs it as one round-trip.
   */
  async #deliverPrompt(
    launcher: NodeLauncher,
    socket: string,
    id: string,
    prompt: string,
    settleTimeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    return launcher.deliverPrompt(socket, id, prompt, settleTimeoutMs, pollMs);
  }

  /**
   * Revokes a subshell's MCP token, tolerating a failing token store: if the
   * revoke itself throws, the row's `apiKeyId` link is cleared instead, so
   * the auth guard's link check (the key's id must equal the row's
   * `apiKeyId`, see `api/auth-guard.ts`) rejects the credential — the
   * documented second layer. Logs loudly either way; never throws, because
   * every caller is a cleanup/teardown path that must finish.
   */
  async #revokeTokenOrUnlink(subshellId: string): Promise<void> {
    try {
      await this.#tokens.revoke(subshellId);
    } catch (err) {
      logger
        .withError(err)
        .error(`subshell token revoke FAILED for ${subshellId}; clearing apiKeyId so the auth guard rejects the key`);
      try {
        await this.#subshells.update(subshellId, { apiKeyId: null });
      } catch (unlinkErr) {
        logger.withError(unlinkErr).error(`could not clear apiKeyId for ${subshellId} after a failed revoke`);
      }
    }
  }

  /**
   * The subshell's current screen, for the preview on its card.
   *
   * Asks tmux what the pane looks like right now rather than tailing the
   * output log. The log is a byte stream of everything the harness ever
   * wrote, including the redraws of a full-screen TUI, so its last few lines
   * are fragments of a repaint rather than anything a person can read — which
   * is exactly what the old preview showed. `capture-pane` renders the screen
   * instead, so the card shows what the terminal shows.
   *
   * Costs one tmux invocation per running LOCAL subshell per call, which is
   * what makes the preview cheap enough to fan out over every card: no
   * socket, no terminal emulator and no WebGL context per tile.
   *
   * AGENT rows never hit the wire here: a capture per card would be a signed
   * round-trip on every list read, so their preview comes from the sweep's
   * probe-fed {@link previewCacheGet} — cache-only, absence simply means no
   * preview this tick.
   *
   * LOCAL rows read through the SAME cache, but as a cross-consumer dedupe
   * rather than the data's source: every open tab's SSE feed rebuilds this
   * list on its own 1.5 s tick, and one pane's capture must not become one
   * spawn per tab. A miss captures from tmux and fills the entry with the
   * short {@link LOCAL_PREVIEW_TTL_MS}; a hit returns the last capture of
   * this pane, at most that TTL old.
   */
  async #preview(row: {
    id: string;
    status: string;
    alive: number;
    tmuxSocket: string | null;
    nodeId: string;
  }): Promise<string[]> {
    if (row.status !== "running" || row.alive !== 1 || !row.tmuxSocket) return [];
    if (row.nodeId !== LOCAL_NODE_ID) return previewCacheGet(row.id) ?? [];
    const cached = previewCacheGet(row.id);
    if (cached !== undefined) return cached;
    try {
      const lines = screenTail(await this.#localLauncher.capture(row.tmuxSocket, row.id));
      previewCachePut(row.id, lines, LOCAL_PREVIEW_TTL_MS);
      return lines;
    } catch {
      // A pane that vanished between the liveness check and this call is a
      // normal race, not an error worth failing the whole list over.
      return [];
    }
  }

  /**
   * Maps already-fetched rows to client views (reconciled preview per row).
   * Exposed so a caller that resolved its OWN row set — e.g. the sharing-aware
   * visible list — can reuse the exact same preview/`#` capture path. Views
   * come back in the same order as `rows`, and default to `access: "owner"`.
   * Sequential on purpose: the capture-per-row is what keeps the fan-out one
   * tmux call at a time, exactly as the pre-seam sync loop was.
   */
  async toViews(
    rows: SubshellTable[],
    opts: { previews?: boolean } = {},
  ): Promise<ReturnType<typeof toSubshellView>[]> {
    // `previews: false` skips the per-row `capture-pane` entirely. The live
    // socket's snapshot passes it: a dashboard on any page other than the
    // cards renders no screens, and capturing every running pane for a page
    // that shows none was the last of the per-connect capture cost
    // (spec 2026-09-19 §4.4). REST keeps them — the mobile card renders the
    // last preview line and reads this list over HTTP.
    const withPreviews = opts.previews ?? true;
    const views: ReturnType<typeof toSubshellView>[] = [];
    for (const row of rows) {
      const preview = withPreviews ? await this.#preview(row) : [];
      views.push(toSubshellView(row, row.status, preview, "owner", isNodeOffline(row.nodeId)));
    }
    return views;
  }

  /**
   * Current screens for specific subshells — the on-demand half of previews.
   *
   * The caller has already decided the viewer may see these rows; this only
   * captures. Absent/dead rows answer with no entry rather than an empty one,
   * so a client can tell "nothing to show" from "not answered".
   *
   * @param rows - rows to capture, already access-checked by the caller
   */
  async previewsFor(rows: SubshellTable[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const lines = await this.#preview(row);
      if (lines.length > 0) out.set(row.id, lines);
    }
    return out;
  }

  /** Lists subshells for a user, reconciling liveness against tmux. */
  async listSubshells(userId: string): Promise<ReturnType<typeof toSubshellView>[]> {
    return await this.toViews(await this.#subshells.listByUser(userId));
  }

  /** Gets a single subshell view for a user (reconciled). */
  async getSubshell(userId: string, id: string): Promise<ReturnType<typeof toSubshellView> | undefined> {
    const row = await this.#subshells.findById(id);
    if (!row || row.userId !== userId) return undefined;
    return toSubshellView(row, row.status, await this.#preview(row), "owner", isNodeOffline(row.nodeId));
  }

  /**
   * Renames a subshell AND locks the name: a hand-picked name is exactly the
   * signal that the pane-title sweep must stop overwriting it — renaming IS
   * the pin (spec 2026-09-03); there is deliberately no unlock path. The
   * caller must pass a non-blank trimmed name (the route enforces it); every
   * subshell keeps a name.
   * @returns false when the subshell is absent or not the caller's
   */
  async updateName(userId: string, id: string, name: string): Promise<boolean> {
    const row = await this.#subshells.findById(id);
    if (!row || row.userId !== userId) return false;
    await this.#subshells.update(id, { name, nameLocked: 1 });
    publishLive({ kind: "subshell.changed", id });
    return true;
  }

  /**
   * Restart the subshell IN PLACE: same row, same id, same name. Kills the
   * pane (live or already dead), parks the row in the exact crashed shape
   * (`running` / `alive: 0`) the auto path revives from, and runs the shared
   * `#reviveRow` — token rotated, MCP re-registered, harness conversation
   * RESUMED when its transcript survived (`planHarnessSession` decides; the
   * pane is dead by the time we resume, so the clone-era "live source starts
   * fresh" hazard is gone). The auto-restart ladder resets: operator intent
   * supersedes backoff state.
   *
   * The whole kill→park→respawn runs under a process-wide lease (`restartInFlight`,
   * keyed by id and shared across every manager instance), so the reconcile
   * sweep skips the row while it is deliberately pane-less and concurrent
   * restarts — from any tab, the MCP server, or a second route — JOIN this
   * one revival instead of double-spawning. The park is CONDITIONAL
   * (`parkForRestart`): a terminate that lands between the ownership read and
   * the park is honored (the restart backs off) rather than resurrected.
   * @returns the restarted id + tmuxSocket (unchanged by definition), or null
   *          when the subshell is absent/not the caller's, was deleted, or a
   *          terminate won the race (so the caller converges on "gone")
   * @throws Error when the relaunch cannot be composed (preset/harness/
   *         binary gone, working dir unlinked, tmux refused the spawn) — or
   *         when the row's agent node is offline, in the offline-flavored
   *         shape (`NodeRpcError("offline")` / "has no live connection")
   *         that {@link SubshellsService.restartSubshell} maps to the 409
   *         NODE_OFFLINE of spec §5.6. The parked row is rolled back to
   *         `terminated` + token revoked on the way out, so a failed restart
   *         leaves a dead-and-restartable row, never a `running` zombie the
   *         sweep would auto-revive.
   */
  async restartSubshell(userId: string, sourceId: string): Promise<{ id: string; tmuxSocket: string } | null> {
    // Ownership is checked BEFORE consulting the lease, so a foreign caller
    // can never ride another principal's in-flight restart for the id's info.
    const source = await this.#subshells.findById(sourceId);
    if (!source || source.userId !== userId) return null;
    const existing = restartInFlight.get(sourceId);
    if (existing) return existing; // same owner, already restarting — join it
    const run = (async (): Promise<{ id: string; tmuxSocket: string } | null> => {
      if (source.alive === 1 && source.tmuxSocket) {
        // killSubshell swallows "already gone"; the tree dies with its baked
        // key, which #reviveRow then rotates off the same row anyway.
        // Row-based launcher: a restart kills where the pane actually lives
        // (an offline agent answers NodeRpcError("offline"), which the
        // service maps to the 409 NODE_OFFLINE of spec §5.6).
        await this.#launcherFor(source.nodeId).killSubshell(source.tmuxSocket, source.id);
      }
      // Conditional park: succeeds only if the row is still where we read it.
      // A terminate/delete in the window flips status/alive, so this no-ops
      // and we honor the kill rather than resurrecting it.
      const parkedRows = await this.#subshells.parkForRestart(
        source.id,
        { status: source.status, alive: source.alive },
        { status: "running", alive: 0, exitCode: null, endedAt: null },
      );
      if (parkedRows === 0) {
        await this.#audit({
          actorUserId: userId,
          action: "subshell.restart",
          targetType: "subshell",
          targetId: source.id,
          metadataJson: JSON.stringify({ name: source.name, racedTerminate: true }),
        });
        logger.info(`subshell restart abandoned (terminate/delete raced): ${source.id}`);
        return null;
      }
      const parked = await this.#subshells.findById(source.id);
      if (!parked) return null; // deleted between park and re-read
      let revived: boolean;
      try {
        revived = await this.#reviveRow(parked, { backoffCount: 0 });
      } catch (err) {
        // Roll the parked `running` row back to a truthful dead state and
        // retire any token #reviveRow minted before failing, so the sweep
        // (which lists only `running`) neither auto-revives nor leaves a
        // zombie. Mirrors createSubshell's spawn-failure rollback.
        await this.#subshells.markTerminated(parked.id, new Date().toISOString());
        await this.#revokeTokenOrUnlink(parked.id);
        throw err;
      }
      // Audit trail: a restart is its own event on the SAME row (create
      // already logged subshell.create; terminate logged its own death).
      // `racedTerminate` marks the case where the operator killed the
      // subshell mid-restart and we honored it (no pane, no token).
      await this.#audit({
        actorUserId: userId,
        action: "subshell.restart",
        targetType: "subshell",
        targetId: parked.id,
        metadataJson: JSON.stringify({ name: parked.name, racedTerminate: !revived }),
      });
      if (!revived) {
        logger.info(`subshell restart honored a mid-flight terminate: ${parked.id} left dead`);
        return null; // finding: don't report success for a revival that spawned nothing
      }
      logger.info(`subshell restarted in place: ${parked.id} (${parked.name})`);
      publishLive({ kind: "subshell.changed", id: parked.id });
      return { id: parked.id, tmuxSocket: parked.tmuxSocket ?? tmuxSocketFor(parked.id) };
    })().finally(() => restartInFlight.delete(sourceId));
    restartInFlight.set(sourceId, run);
    return run;
  }

  /**
   * Terminates a subshell: kills its pane (on the row's node) and marks the DB
   * row. Best-effort against an unreachable node (O2 ruling): an OFFLINE kill
   * — anything {@link isNodeOfflineError} recognizes (the sync
   * `NoLiveConnectionError` or the RPC-path `NodeRpcError("offline")`) — is
   * swallowed at the kill step with a warn and an audit
   * `killUnverified: true`, and the row is retired anyway (the operator's
   * stop must never 500 over an unreachable node); the node's
   * reconnect census best-effort-kills the surviving pane (see
   * {@link applySubshellsReport}). Every other kill failure keeps the classic
   * semantics (throw, row untouched), and every other teardown step is
   * unchanged.
   *
   * @returns whether THIS call performed the alive→dead transition. A caller
   *   that owes somebody a notification cannot decide that from a read: the
   *   pane's own death may be travelling {@link applyRemoteExit} at the same
   *   moment, both would see `alive: 1`, and the owner would be told twice
   *   about one death. False also covers the rows this refuses outright
   *   (absent, or not the caller's) and the parked ones that were already
   *   dead.
   */
  async terminateSubshell(userId: string, id: string): Promise<boolean> {
    const row = await this.#subshells.findById(id);
    if (!row || row.userId !== userId) return false;
    let killUnverified = false;
    if (row.tmuxSocket) {
      // Kill on the node the row lives on (row-based launcher, spec §6.3).
      try {
        await this.#launcherFor(row.nodeId).killSubshell(row.tmuxSocket, id);
        // The pane is gone for good — a restart from here builds a NEW tmux
        // server — so reclaim the socket file tmux leaves behind. Only after a
        // VERIFIED kill: an offline node's pane may well still be running, and
        // this host's idea of that socket path is not that machine's anyway.
        await this.#launcherFor(row.nodeId).cleanSocket(row.tmuxSocket);
      } catch (err) {
        if (!isNodeOfflineError(err)) throw err;
        killUnverified = true;
        logger.warn(
          `subshell ${id}: node "${row.nodeId}" is offline; pane kill UNVERIFIED, retiring the row anyway (spec §5.6)`,
        );
      }
    }
    // The claim comes after the kill and before the retire, which is the only
    // placement that is both honest and useful: a kill that threw has written
    // nothing (the classic semantics above), and once `status` is
    // `terminated` there is no transition left to claim.
    const stopped = (await this.#subshells.updateIfAlive(id, { alive: 0 })) > 0;
    await this.#subshells.markTerminated(id, new Date().toISOString());
    publishLive({ kind: "subshell.changed", id });
    // Teardown must finish even when the token store is down: a failed revoke
    // unlinks apiKeyId (guard 401s the key) so the audit event below still lands.
    await this.#revokeTokenOrUnlink(id);
    await this.#audit({
      actorUserId: userId,
      action: "subshell.terminate",
      targetType: "subshell",
      targetId: id,
      metadataJson: JSON.stringify({ name: row.name, ...(killUnverified ? { killUnverified: true } : {}) }),
    });
    return stopped;
  }

  /**
   * Terminate one subshell because its NODE entered maintenance
   * (spec 2026-09-14 §5.2).
   *
   * {@link terminateSubshell} plus a push, and the push is the whole reason
   * this exists as a second method rather than a flag: that path is
   * deliberately silent because the operator clicked it, and here they did
   * not. A node owner's window stops subshells belonging to everyone the node
   * was shared with — people who cannot see the node, did not act, and would
   * otherwise find a dead pane with no account of why.
   *
   * The row's OWN `userId` is passed through, never an actor's: the terminate
   * path is owner-keyed and would silently skip every row but the caller's.
   * Void-fired push, like {@link #notifyDeath} — a slow or throwing sink must
   * not stall a loop that is holding up a node's whole maintenance window.
   *
   * It pushes only when it is the thing that STOPPED the subshell, and
   * {@link terminateSubshell}'s claim decides that rather than a read. The
   * agent sends its `maintenance` event before the `exit` frames the window
   * causes, so the pane's own death may already have travelled
   * {@link #applyDeath} — which pushes `maintenance` for the same reason — by
   * the time this loop reaches the row. A row already retired is still
   * terminated here (the bookkeeping is the point: token revoked, row marked,
   * act audited) and simply not announced a second time. A parked row loses
   * the claim too, which is right: nothing was running to stop, and its owner
   * heard about that death when it happened.
   *
   * @param row - the running row to stop, freshly read
   */
  async terminateForMaintenance(row: SubshellTable): Promise<void> {
    if (await this.terminateSubshell(row.userId, row.id)) void this.#notify(row.id, "maintenance");
  }

  /**
   * Permanently deletes a subshell: kills its tmux tree if it is running,
   * removes the DB row, and unlinks the per-subshell output log. Returns false
   * if not found/not owner.
   */
  async deleteSubshell(userId: string, id: string): Promise<boolean> {
    const row = await this.#subshells.findById(id);
    if (!row || row.userId !== userId) return false;
    const launcher = this.#launcherFor(row.nodeId);
    if (row.tmuxSocket) {
      // Kill the pane even if it is already dead; try/catch so a missing
      // tmux subshell (or an unreachable node) does not block the deletion.
      try {
        await launcher.killSubshell(row.tmuxSocket, row.id);
      } catch {
        // pane already gone
      }
      // Reclaim the socket file whether or not the kill found a pane: the row
      // is about to cease existing, so nothing will ever bind this name again.
      // Unconditional where terminate's is not, and that asymmetry is the
      // point — a delete has no "maybe it is still running elsewhere" case to
      // respect, because there will be no row left to respect it for.
      await launcher.cleanSocket(row.tmuxSocket).catch(() => {});
    }
    // Before deletion: revoke resolves the key via the row. A failure here is
    // survivable — unlinking apiKeyId neutralises the key, and deleting the
    // row outright does the same via the guard's missing-row check.
    await this.#revokeTokenOrUnlink(id);
    await this.#subshells.delete(id);
    // Best-effort artifact cleanup ON THE ROW'S NODE (the log is only an
    // attach-replay artifact; the MCP config holds no secrets but nothing
    // should be left behind). The layout lives behind the launcher seam
    // (spec §6.4): a local row leaves exactly its replay log; an agent node
    // names the triple (log + MCP config + the agent's own meta record —
    // deliberately left behind by a kill, so the DELETE unlinks it) from its
    // live `ready` facts, and an OFFLINE agent answers `[]`: no facts, no
    // layout to name paths from, artifacts age out with the node (§5.6).
    // The local short-circuit is row-keyed because a TEST launcher answers for
    // EVERY node id (the phase-0 suites) — a fake standing in for `local`
    // must keep receiving the local artifact set, never the agent triple.
    const artifacts = row.nodeId === LOCAL_NODE_ID ? [launcher.logPath(id)] : launcher.subshellArtifacts(id);
    await launcher.removeArtifacts(artifacts);
    // And the generated MCP config (no secrets, but nothing to leave behind).
    try {
      unlinkSync(subshellMcpConfigPath(id));
    } catch {
      // no config file
    }
    logger.info(`subshell deleted: ${id}`);
    await this.#audit({
      actorUserId: userId,
      action: "subshell.delete",
      targetType: "subshell",
      targetId: id,
      metadataJson: JSON.stringify({ name: row.name }),
    });
    return true;
  }

  /** Reconciles all running rows in the DB against tmux liveness. */
  async reconcile(userId: string): Promise<void> {
    const running = await this.#subshells.listByUser(userId, "running");
    await this.reconcileRows(running);
  }

  /** Reconciles every running row in the DB (server-wide sweep). */
  async reconcileAll(): Promise<void> {
    await this.reconcileRows(await this.#subshells.listRunning());
  }

  /**
   * Exponential-backoff auto-restart for crashed subshells (same DB row).
   *
   * Called from the reconcile crash branch. Skips when the subshell is not
   * opted in (`restartOnExit`), the row is already alive, or the backoff
   * delay has not elapsed. When an attempt is made the next run is scheduled
   * first (`nextRestartAt`) so a sweep race cannot double-spawn; the attempt
   * mirrors `createSubshell` (validate → findBinary → buildCommand → tmux).
   * Failures leave the row dead and un-schedule the retry so the next sweep
   * tries again — but every attempt (success or not) advances `backoffCount`,
   * so a subshell that can never spawn again (deleted binary, unlinked cwd)
   * reaches the bounded give-up in `reconcileRows` (token revoked) instead of
   * rotating its MCP token once per sweep forever. A terminate racing the
   * restart is closed off in two layers: a fresh row re-read immediately
   * before the spawn, and a conditional (`status = 'running'`) post-spawn
   * patch — if it no longer applies, the orphaned pane is killed and the
   * just-issued token revoked. Returns true when a restart was spawned.
   */
  private async maybeAutoRestart(row: SubshellTable): Promise<boolean> {
    if (row.status !== "running" || row.alive === 1 || row.restartOnExit !== 1) return false;
    const now = Date.now();
    // The last restart attempt (or the crash) scheduled a future retry; it
    // may not be due yet — sweep "no-op" until `nextRestartAt` passes.
    if (row.nextRestartAt && new Date(row.nextRestartAt).getTime() > now) return false; // backoff pending
    const delayMs = Math.min(30_000 * 2 ** row.backoffCount, 480_000);
    if (row.backoffCount >= 5) {
      logger.warn(`subshell ${row.id}: auto-restart backoff limit reached`);
      return false;
    }
    // Schedule the next attempt up-front: even if this spawn fails the row
    // can't be restarted in a tighter loop than the backoff allows.
    await this.#subshells.update(row.id, { nextRestartAt: new Date(now + delayMs).toISOString() });
    try {
      // Fresh status check: the sweep snapshot may predate a user terminate,
      // and we must not spawn a process under a subshell the operator killed.
      const fresh = await this.#subshells.findById(row.id);
      if (fresh?.status !== "running" || fresh.alive !== 0) return false;
      // An agent row whose node is offline DEFERS (spec §5.6): absence of
      // the socket is not absence of the process, and there is nothing to
      // launch through anyway. The backoff schedule set above re-tries on
      // the next tick; the node coming back is what unblocks the restart.
      if (isNodeOffline(fresh.nodeId)) {
        logger.debug(`subshell ${fresh.id}: auto-restart deferred: node "${fresh.nodeId}" has no live connection`);
        return false;
      }
      // A node in maintenance takes NO new work, and a sweep respawning a
      // pane there would undo the stop the window just performed — silently,
      // minutes later, on a machine somebody is standing at. Deferred rather
      // than given up on: the row keeps its backoff schedule and revives on
      // its own once the window ends, which is why the card promises the
      // opposite (an opted-in row does not come back by itself) only for the
      // rows maintenance TERMINATED — those are no longer `running` at all.
      if ((await getRequestlessContext().repos.nodes.findById(fresh.nodeId))?.maintenance === 1) {
        logger.debug(`subshell ${fresh.id}: auto-restart deferred: node "${fresh.nodeId}" is in maintenance`);
        return false;
      }
      // A restart IS a new subshell, so it obeys the same rule the create
      // route and the picker enforce: a disabled or uninstalled harness
      // starts nothing (ON THE ROW'S NODE — §6.2's per-node gate). The row
      // stays parked (the up-front nextRestartAt re-tries on the backoff
      // schedule); re-enabling the harness — or reinstalling the CLI —
      // makes the next tick respawn the pane.
      if (!(await harnessUsable(fresh.harnessId, fresh.nodeId))) {
        logger.debug(
          `subshell ${fresh.id}: auto-restart deferred: harness "${fresh.harnessId}" is disabled or not installed`,
        );
        return false;
      }
      const revived = await this.#reviveRow(fresh, { backoffCount: fresh.backoffCount + 1 });
      if (revived) logger.info(`subshell auto-restarted (${row.id}), backoff=${row.backoffCount + 1}`);
      return revived;
    } catch (err) {
      logger.withError(err).warn(`auto-restart failed for ${row.id}`);
      // A failed spawn still counts as an attempt toward the backoff limit:
      // without this, a subshell that can never spawn (deleted binary) would
      // revoke+re-issue its token on every sweep forever and never reach the
      // terminal give-up in `reconcileRows`.
      await this.#subshells.update(row.id, { nextRestartAt: null, backoffCount: row.backoffCount + 1 });
      return false;
    }
  }

  /**
   * Revive a parked row (`status: "running"`, `alive: 0`) in place: rotate
   * credentials, re-register MCP, resume the conversation when its transcript
   * survived, respawn the pane, and conditionally flip the row back alive.
   *
   * Shared by the auto-restart sweep and the manual `POST /:id/restart`;
   * both must obey the same race guards (pre-spawn re-read, conditional
   * revival) so a terminate landing mid-flight cannot leave a live pane
   * under a dead row. `nextRestartAt` is cleared on success and the row's
   * `tmuxSocket` is persisted (a row parked before its first socket write
   * still gets a durable one).
   * @param row - the parked row, freshly read (its fields compose the launch)
   * @param backoffCount - value written to the row on revival (auto: +1;
   *                       a manual restart resets to 0)
   * @returns true when the pane spawned and the row revived; false when a
   *          terminate won the race (orphan pane killed, fresh token revoked)
   * @throws when the launch cannot even be composed (preset/harness/binary
   *         gone, working dir unlinked, tmux refused the spawn) — or when
   *         the row's agent node has no live connection: the throw is
   *         offline-flavored (NodeRpcError("offline") or the same message
   *         from the facts guard) so the restart boundary can answer the
   *         structured 409 NODE_OFFLINE of spec §5.6.
   */
  async #reviveRow(row: SubshellTable, { backoffCount }: { backoffCount: number }): Promise<boolean> {
    // A NULL `presetId` is not a missing preset — it is a presetless launch
    // (spec 2026-09-13 §4), and it revives as exactly what it was created
    // as: EMPTY_PRESET. Only a NON-NULL reference whose row vanished throws.
    const presetRow = row.presetId ? await this.#presets.findById(row.presetId) : undefined;
    if (row.presetId && !presetRow) throw new Error("preset missing");
    const harness = getHarness(row.harnessId);
    if (!harness) throw new Error("harness missing");
    // The row's node owns this revive end to end (spec §6.3). An agent that
    // is offline answers with the offline-flavored throw from the very first
    // round-trip (or from #planMcp below), which is what lets the manual
    // restart map to 409 NODE_OFFLINE and the sweep defer (§5.6).
    const launcher = this.#launcherFor(row.nodeId);
    const realPath = await launcher.validateWorkingDir(row.workingDir);
    // A restart spawns a FRESH pane in that directory, so it is a launch and
    // takes the launch gate (spec 2026-09-05). Running panes are untouched by
    // a rule change; reviving one into a now-excluded directory is not.
    await assertDirAllowed(row.nodeId, realPath);
    const binary = await launcher.resolveBinary(harness);
    if (!binary) throw new Error("harness binary missing");
    const preset = presetRow ? parsePreset(presetRow) : EMPTY_PRESET;
    // Rotate the MCP token: the old process is gone and its baked key must
    // die with it; the new pane bakes the freshly issued one. A failed
    // revoke must NOT abort the restart — `issue` below rewrites the row's
    // apiKeyId, and the guard's link check then 401s the orphaned old key.
    await this.#revokeTokenOrUnlink(row.id);
    const apiKey = await this.#tokens.issue(row.id, row.userId);
    const { mcp, mcpConfigPath, facts } = this.#planMcp(harness, row.id, row.nodeId);
    const reporter = this.#planReporter(row.nodeId, facts);
    const subshellEnv = subshellMcpEnv(apiKey, row.id, row.name);
    if (facts) {
      // subshellMcpEnv bakes the BACKEND's SUBSHELL_SERVER_DATA_DIR — a path that
      // means nothing on the node; the agent's own dataDir is the truth there.
      subshellEnv.SUBSHELL_DATA_DIR = facts.dataDir;
    }
    // Same-row restart: resume the crashed conversation when it survived,
    // re-pin when it didn't (or the row predates the feature).
    const harnessSession = await this.#planHarnessSession(launcher, harness, row.harnessSessionId ?? null, realPath);
    const socket = row.tmuxSocket ?? tmuxSocketFor(row.id);
    // Cheap last look before the spawn: everything above (preset lookup,
    // findBinary, two token round-trips) is a window in which the operator
    // can terminate the subshell — never bake a pane under a killed row.
    const preSpawn = await this.#subshells.findById(row.id);
    if (preSpawn?.status !== "running" || preSpawn.alive !== 0) {
      // The row died mid-flight; retire the token we just minted for it.
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    // Command assembly + spawn + log-dir + pipe-pane in one launcher call
    // (same method createSubshell uses; the pipe is re-attached even when
    // cleanup unlinked the log). bestEffortLog restores the pre-seam revive
    // semantics: a pane this live must not die over a lost replay-log pipe.
    await launcher.launch({
      id: row.id,
      socket,
      harness,
      binary,
      cwd: realPath,
      preset,
      // Locked names are human-owned and travel back as `--name`; anything
      // else (placeholder or sweep-adopted) passes "" so the fresh pane is
      // titled by the harness again, not pinned to yesterday's task title
      // (titling spec 2026-09-03). The env keeps the row's display name.
      subshellName: row.nameLocked === 1 ? row.name : "",
      subshellEnv,
      mcp,
      mcpConfigPath,
      harnessSession,
      reporter,
      bestEffortLog: true,
    });
    // Conditional revival: a terminate that landed after the pre-spawn
    // check (between it and this write) must not resurrect the row — the
    // guard makes this a no-op and the orphan below is cleaned up instead.
    const revived = await this.#subshells.updateIfRunning(row.id, {
      alive: 1,
      exitCode: null,
      endedAt: null,
      tmuxSocket: socket,
      startedAt: new Date().toISOString(),
      backoffCount,
      nextRestartAt: null,
      // Persist the pinned id when this attempt re-pinned (mode "start");
      // a mode "resume" id equals the stored one, so this is a no-op write.
      ...(harnessSession ? { harnessSessionId: harnessSession.id } : {}),
    });
    if (revived === 0) {
      logger.warn(`subshell ${row.id} terminated mid-restart; killing the orphan pane and revoking its token`);
      await launcher.killSubshell(socket, row.id); // swallows "already gone"
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    return true;
  }

  /**
   * Fires the death push on the alive→dead reconcile transition — the ONLY
   * place death notifies (the manual `terminateSubshell` path deliberately
   * stays silent: the operator clicked it). `restartOnExit` decides crashed
   * vs exited; an opted-in row whose backoff is already exhausted (the same
   * `>= 5` limit `maybeAutoRestart` gives up at) gets `crashed_final`, so the
   * copy never promises a restart that will never come. Void-fired so a
   * throwing or slow sink cannot stall the sweep (`notifySubshell` itself
   * already swallows everything; this is belt-and-braces for an injected
   * mock).
   *
   * A death on a node in MAINTENANCE is none of those words. The pane did not
   * fail — somebody took the machine out of service, and the agent sends that
   * event before the `exit` frames it causes (spec §4.3), so the flag is
   * already on the row when this runs. `crashed` would promise an
   * auto-restart that {@link maybeAutoRestart} is at that same moment refusing
   * to make, and it would describe somebody else's deliberate act as a fault
   * on the owner's own screen. The node row is read HERE, on the death path,
   * so an instance where nothing is dying pays nothing for it.
   */
  async #notifyDeath(row: SubshellTable): Promise<void> {
    if ((await getRequestlessContext().repos.nodes.findById(row.nodeId))?.maintenance === 1) {
      void this.#notify(row.id, "maintenance");
      return;
    }
    const kind: NotifyKind = row.restartOnExit === 1 ? (row.backoffCount >= 5 ? "crashed_final" : "crashed") : "exited";
    void this.#notify(row.id, kind);
  }

  /**
   * Reconciles running rows against what each row's NODE reports (spec §6.3).
   * Partition first: LOCAL rows run the classic single-machine loop verbatim
   * (the regression net — sync seams, pane-title reads, the mtime probe);
   * AGENT rows NEVER touch that path (probing an online agent row through the
   * local launcher false-crashes it, and a collided revive would then kill on
   * the node). Their liveness arrives in batched `probe` commands instead.
   */
  private async reconcileRows(rows: SubshellTable[]): Promise<void> {
    const now = new Date().toISOString();
    const local: SubshellTable[] = [];
    const agent: SubshellTable[] = [];
    for (const row of rows) (row.nodeId === LOCAL_NODE_ID ? local : agent).push(row);
    await this.#reconcileLocalRows(local, now);
    await this.#reconcileAgentRows(agent, now);
  }

  /** The classic local sweep loop (verbatim pre-§6.3 body, crash branch folded into {@link #applyDeath}). */
  async #reconcileLocalRows(rows: SubshellTable[], now: string): Promise<void> {
    for (const row of rows) {
      // A manual restart owns this row right now: it is parked (alive:0, no
      // pane) mid-kill→respawn and is about to come back on its own. Sweeping
      // it here would revoke the token #reviveRow just issued, stamp a false
      // death push, or race a second revival — so skip the whole row.
      if (restartInFlight.has(row.id)) continue;
      if (!row.tmuxSocket) {
        // No socket → cannot be alive; mark crashed so reconcile converges.
        if (row.status === "running" && row.alive === 1) {
          // `ended_at` is stamped on the death transition (an auto-restart
          // clears it again) so a subshell that never comes back carries a
          // truthful end time instead of lingering as a null-ended zombie.
          // `waiting_since` dies with the process — nobody is waiting anymore.
          // CLAIMED, because `row` is this sweep's snapshot and a `local`
          // maintenance window retiring the same rows is the one death path
          // that never travels `applyRemoteExit`: without the claim the stale
          // `alive === 1` above is enough to push a second time.
          const claimed = await this.#subshells.updateIfAlive(row.id, { alive: 0, endedAt: now, waitingSince: null });
          if (claimed > 0) {
            publishLive({ kind: "subshell.changed", id: row.id });
            logger.info(`subshell process absent (no socket): ${row.id}`);
            await this.#notifyDeath(row);
          }
        }
        continue;
      }
      // UNKNOWN IS NOT DEAD. `hasSubshell` re-throws a timeout rather than
      // answering `false`, because the death branch below is destructive —
      // it revokes the subshell's token, stamps `endedAt` and pushes a death
      // notification — and a tmux client that simply did not answer is no
      // evidence at all. Skip the row and look again on the next tick; a
      // genuinely dead pane is still dead in sixty seconds.
      let paneAlive: boolean;
      try {
        paneAlive = await this.#localLauncher.hasSubshell(row.tmuxSocket, row.id);
      } catch (err) {
        if (!(err instanceof TmuxTimeoutError)) throw err;
        logger.withError(err).warn(`subshell ${row.id}: tmux did not answer the liveness probe; skipping this sweep`);
        continue;
      }
      if (!paneAlive) {
        // Probe FIRST, decide after: paneExitCode is awaited just like
        // hasSubshell, so collect every async probe before touching state.
        // ── TOCTOU re-check (spec §6.3 async seam TOCTOU): the probes widen
        // the check→act window; #applyDeath re-reads the lease AND the fresh
        // row before touching anything (a restart that began mid-flight owns
        // the row now; a terminate/delete mid-await isn't ours to stamp).
        const exitCode = row.alive === 1 ? await this.#localLauncher.paneExitCode(row.tmuxSocket, row.id) : null;
        await this.#applyDeath(row, { exitCode, endedAt: now });
        continue;
      }
      // Alive: stamp liveness + fold in the existing lastOutputAt mtime logic.
      // Build the patch conditionally and skip the write when nothing changed
      // (avoids churn on older rows per sweep, and a stale write could
      // resurrect a row the user just terminated).
      const patch: SubshellUpdate = {};
      if (row.alive !== 1) {
        patch.alive = 1;
        patch.endedAt = null; // back among the living — the stamp was for the death
      }
      if (row.startedAt == null) patch.startedAt = now;
      // A healthy sweep (alive at sweep) proves the crash resolved itself;
      // reset the auto-restart backoff so the next crash restarts promptly.
      if (row.alive === 1 && row.backoffCount > 0) patch.backoffCount = 0;
      // Auto-title mode: mirror the pane's OSC title (Claude Code titles
      // itself after the current task) into the subshell name. Two untitled
      // defaults are rejected: a title still equal to the running command,
      // and tmux's initial title — the host name (verified against tmux
      // 3.6). Locked names (an operator renamed or pinned) are never
      // touched, and the read is skipped entirely so the sweep stays cheap.
      if (row.nameLocked !== 1) {
        const pane = await this.#localLauncher.paneTitle(row.tmuxSocket, row.id);
        const title = pane ? normalizePaneTitle(pane.title) : "";
        if (pane && title && title !== pane.command && title !== HOST_NAME && title !== row.name) {
          patch.name = title;
        }
      }
      try {
        // The mtime probe is LOCAL-ONLY by design: an agent pane has no file
        // here — the WS attach relay's `persistOutput` plus the exit/report
        // paths keep agent rows' `lastOutputAt` fresh (spec §6.3).
        const mtimeMs = (await Bun.file(subshellLogPath(row.id)).stat()).mtime.getTime();
        if (!row.lastOutputAt || mtimeMs > new Date(row.lastOutputAt).getTime()) {
          patch.lastOutputAt = new Date(mtimeMs).toISOString();
        }
      } catch {
        /* no log yet */
      }
      if (Object.keys(patch).length > 0) {
        await this.#subshells.update(row.id, patch);
        publishLive({ kind: "subshell.changed", id: row.id });
      }
    }
  }

  /**
   * The agent half of the sweep (spec §5.6/§6.3). Rows whose node has no live
   * connection are SKIPPED, never crashed — absence of the socket is not
   * absence of the process; the reconnect census and the next probe settle
   * it. Survivors group by node and ride `probe` commands in chunks of
   * {@link PROBE_BATCH_MAX} ids; a chunk whose round-trip errors is
   * warn-and-continue — one wedged node must never abort the sweep.
   */
  async #reconcileAgentRows(rows: SubshellTable[], now: string): Promise<void> {
    if (rows.length === 0) return;
    const byNode = new Map<string, SubshellTable[]>();
    let skipped = 0;
    for (const row of rows) {
      // Same lease rule as the local loop (mid-restart rows are deliberately
      // pane-less), plus the offline skip the whole branch exists for.
      if (restartInFlight.has(row.id) || !getLive(row.nodeId)) {
        skipped++;
        continue;
      }
      const list = byNode.get(row.nodeId) ?? [];
      list.push(row);
      byNode.set(row.nodeId, list);
    }
    if (skipped > 0) {
      logger.debug(`reconcile: ${skipped} agent row(s) skipped (node offline or mid-restart; spec §5.6)`);
    }
    for (const [nodeId, nodeRows] of byNode) {
      for (let i = 0; i < nodeRows.length; i += PROBE_BATCH_MAX) {
        const chunk = nodeRows.slice(i, i + PROBE_BATCH_MAX);
        try {
          const data = await this.#sendNode(
            nodeId,
            { type: "probe", subshellIds: chunk.map((r) => r.id) },
            { timeoutMs: RECONCILE_PROBE_TIMEOUT_MS },
          );
          const entries = parseNodeProbeEntries(data);
          if (!entries) {
            logger.warn(`reconcile: node "${nodeId}" answered a malformed probe result; chunk skipped`);
            continue;
          }
          const byId = new Map(entries.map((e) => [e.subshellId, e]));
          for (const row of chunk) {
            const entry = byId.get(row.id);
            // The agent answers ONLY for the ids it supervises; no entry is
            // the same no-evidence class as an offline node — skip, don't kill.
            if (!entry) continue;
            if (!entry.alive) {
              await this.#applyDeath(row, { exitCode: entry.exitCode, endedAt: now });
              continue;
            }
            await this.#applyAgentAlive(row, entry, now);
          }
        } catch (err) {
          logger
            .withError(err)
            .warn(`reconcile probe to node "${nodeId}" failed (chunk of ${chunk.length}); sweep continues`);
        }
      }
    }
  }

  /**
   * The shared death transition — the ONE place a running row is stamped
   * alive→dead. Every entry point that learns of a death calls this: the
   * sweep (local tmux probe or the agent `probe`/`exit` census), an agent
   * `exit` event, and the `subshells_report` reconnect census. Idempotent by
   * construction: the stamp + death push fire only while the FRESH row is
   * still `running` with `alive: 1`, and a row a restart owns
   * (`restartInFlight`) is off-limits. After the (possible) transition the
   * auto-restart ladder runs for parked rows, and a subshell that will never
   * come back — opted out or backoff-exhausted — has its bearer revoked here.
   * The cached preview dies with the pane.
   * @param row - the row as the caller saw it; only its id must still be true
   * @param opts.exitCode - the observed pane exit code (null = never seen)
   * @param opts.endedAt - ISO stamp for the death (the agent's clock for remote events)
   */
  async #applyDeath(
    row: SubshellTable,
    { exitCode, endedAt }: { exitCode: number | null; endedAt: string },
  ): Promise<void> {
    // Death is the transition a dashboard is actually waiting on, so it is
    // announced from the ONE place both sweeps and the exit report share.
    previewCacheDrop(row.id);
    if (restartInFlight.has(row.id)) return;
    const fresh = await this.#subshells.findById(row.id);
    // The row may have been terminated or deleted under us mid-await —
    // neither stamping its death nor retiring its token is ours to do once
    // it isn't a running row anymore.
    if (fresh?.status !== "running") return;
    let claimed = 0;
    if (fresh.alive === 1) {
      // Claimed, not merely written: a maintenance window stopping this same
      // pane is retiring the row from the other direction, and the owner is
      // owed ONE account of the death. `waiting_since` dies with the process
      // — nobody is waiting anymore.
      claimed = await this.#subshells.updateIfAlive(fresh.id, {
        alive: 0,
        exitCode,
        endedAt,
        waitingSince: null,
      });
      if (claimed > 0) {
        logger.info(`subshell crashed (exit=${exitCode ?? "?"}): ${fresh.id}`);
        await this.#notifyDeath(fresh);
      }
    }
    // Auto-restart crashed subshells that opted in (exponential backoff);
    // a subshell that will never come back has its MCP token revoked here.
    // "Never" means opted out OR the backoff limit was exhausted (the
    // sweep gives up at that count, so the bearer would linger otherwise).
    const restarted = await this.maybeAutoRestart(fresh);
    if (!restarted && (fresh.restartOnExit !== 1 || fresh.backoffCount >= 5)) {
      // Terminal: this subshell will never come back, so its bearer must
      // not linger. Revoke failures here must not abort the sweep for the
      // remaining rows — unlinking apiKeyId is the guard-side fallback.
      await this.#revokeTokenOrUnlink(fresh.id);
    }
    // REAP THE TMUX SERVER, unless the row is coming back.
    //
    // `remain-on-exit` is what makes a finished pane observable, and the price
    // is that tmux no longer tears itself down: the session, and with it this
    // subshell's own server, would sit there for as long as the row is kept.
    // One idle server per dead subshell, accumulating for the life of the
    // host. Nothing is lost by killing it — the pane log on disk is the
    // diagnostic record the dead-pane UI reads, not the pane.
    //
    // Skipped when `maybeAutoRestart` revived the row: that path reuses this
    // socket, and killing the server under it is the shutdown race
    // `newSubshell` retries through.
    // LOCAL ONLY. `remain-on-exit` is set by the local launcher's own
    // `new-session`; a pane on an agent node lives under that machine's tmux
    // and its lifecycle is the node's business, so reaping from here would be
    // this host killing a server it does not own — and against the fixture,
    // recording kills for rows whose panes are not even visible locally.
    if (!restarted && fresh.tmuxSocket && fresh.nodeId === LOCAL_NODE_ID) {
      try {
        await this.#localLauncher.killSubshell(fresh.tmuxSocket, fresh.id);
      } catch (err) {
        // A server already gone is the outcome we wanted; anything else costs
        // an idle process, never correctness.
        logger.withError(err).debug(`could not reap the tmux server for ${fresh.id}`);
      }
    }
    // Announced only when this pass CHANGED something. The sweep calls into
    // here for any row whose pane is not alive, including rows already dead
    // and merely waiting out their restart backoff — so an unconditional
    // publish put one frame per such row on the wire every 60 s, describing
    // nothing. `claimed` is the write that actually happened; a restart is a
    // change in its own right.
    if (claimed || restarted) publishLive({ kind: "subshell.changed", id: row.id });
  }

  /**
   * Folds one ALIVE `probe` entry into its row — the agent twin of the local
   * sweep's alive branch: liveness patch, pane-title name through the same
   * reject rules, backoff reset. Minus the machine-local parts: there is no
   * node-side file for the `lastOutputAt` mtime probe (the relay's
   * `persistOutput` + exit/report keep it fresh), and title/capture ride in on
   * the entry — no second round-trip. The fresh re-read closes the multi-
   * second probe window: a row that raced to a non-running state was stopped
   * by the operator mid-sweep, so its still-alive pane gets
   * {@link #bestEffortKill} rather than a resurrection; a restart-owned row is
   * left alone. `capture` fills the preview cache when the agent had frame
   * budget to send one.
   */
  async #applyAgentAlive(row: SubshellTable, entry: NodeProbeEntry, now: string): Promise<void> {
    const fresh = await this.#subshells.findById(row.id);
    if (!fresh) return;
    if (restartInFlight.has(fresh.id)) return;
    if (fresh.status !== "running") {
      await this.#bestEffortKill(fresh, "reported alive by the probe but terminated mid-sweep");
      return;
    }
    const patch: SubshellUpdate = {};
    if (fresh.alive !== 1) {
      patch.alive = 1;
      patch.endedAt = null; // back among the living — the stamp was for the death
    }
    if (fresh.startedAt == null) patch.startedAt = now;
    if (fresh.alive === 1 && fresh.backoffCount > 0) patch.backoffCount = 0;
    if (fresh.nameLocked !== 1 && entry.title != null) {
      const title = normalizePaneTitle(entry.title);
      if (title && title !== (entry.command ?? "") && title !== HOST_NAME && title !== fresh.name) {
        patch.name = title;
      }
    }
    // Conditional write: the terminate race can still land between the
    // re-read and this statement — a stale patch must never resurrect a row
    // (closes the window the local branch leaves open; costs nothing here).
    if (Object.keys(patch).length > 0) {
      await this.#subshells.updateIfRunning(fresh.id, patch);
      publishLive({ kind: "subshell.changed", id: fresh.id });
    }
    if (entry.capture != null) {
      previewCachePut(fresh.id, screenTail(entry.capture));
    }
  }

  /**
   * Best-effort kill on the row's node: the backend has retired the row
   * (a terminate won while the node was unreachable, or mid-sweep) yet the
   * node reports the pane alive — the operator said stop, so the census
   * finishes the job the offline kill could not (O2). Errors are logged,
   * never thrown: the loop that owns this call must survive an unkillable
   * pane.
   */
  async #bestEffortKill(row: SubshellTable, why: string): Promise<void> {
    const socket = row.tmuxSocket ?? tmuxSocketFor(row.id);
    try {
      await this.#launcherFor(row.nodeId).killSubshell(socket, row.id);
      logger.info(`subshell ${row.id}: killed a stale-live pane on node "${row.nodeId}" (${why})`);
    } catch (err) {
      logger.withError(err).warn(`subshell ${row.id}: best-effort kill of a stale-live pane failed (${why})`);
    }
  }

  /**
   * Applies one `exit` event from a node (spec §3.3/§6.3): the agent watched
   * its supervised pane die and reports it before the next sweep gets there.
   * THE SAME shared death transition as the sweep ({@link #applyDeath}), so
   * exit-vs-sweep races are harmless — whichever lands first stamps and
   * pushes, the other finds the row already dead and no-ops. The reporting
   * CONNECTION's node id scopes authority: a node cannot report for rows it
   * does not own.
   * @param nodeId - the socket's authenticated node identity (never frame data)
   * @param subshellId - the subshell whose pane exited
   * @param exitCode - the pane's exit code (null when never captured)
   * @param at - the agent's death timestamp, stamped as `endedAt`
   */
  async applyRemoteExit(nodeId: string, subshellId: string, exitCode: number | null, at: string): Promise<void> {
    const row = await this.#subshells.findById(subshellId);
    if (!row || row.nodeId !== nodeId) return; // unknown row, or a foreign report — not ours to apply
    if (row.status !== "running") return; // already retired — the census/sweep and this event converge
    await this.#applyDeath(row, { exitCode, endedAt: at });
  }

  /**
   * Applies a pane's own death report (spec 2026-09-19 §4.3).
   *
   * The twin of {@link applyRemoteExit}, and deliberately the same shape: a
   * tmux `pane-died` hook re-enters the subshell binary ON THE PANE'S OWN
   * MACHINE the instant the harness exits,
   * so a dashboard learns in about a second rather than waiting out the 60 s
   * reconcile sweep. Both paths converge on {@link #applyDeath}, so a
   * hook-vs-sweep race is harmless — whichever lands first stamps and pushes,
   * the other finds the row already retired and no-ops.
   *
   * Authority is the caller's own bearer token, resolved by the route: a
   * subshell may report ITS OWN death and nothing else, exactly as it may
   * report its own attention and its own harness session.
   *
   * @param subshellId - the subshell whose pane exited
   * @param exitCode - `#{pane_dead_status}` as tmux reported it, null when unreadable
   * @param at - death timestamp, stamped as `endedAt`
   */
  async applySelfReportedExit(subshellId: string, exitCode: number | null, at: string): Promise<void> {
    const row = await this.#subshells.findById(subshellId);
    // No node check, unlike applyRemoteExit. There, authority is the socket's
    // node identity, because the NODE is speaking for a row. Here the SUBSHELL
    // is speaking for itself with its own bearer token, which the route has
    // already proved — and a pane on an agent node reports through exactly the
    // same hook, straight to this plane, because it holds this address and
    // that token either way.
    if (!row) return;
    if (row.status !== "running") return; // already retired — the sweep and this converge
    await this.#applyDeath(row, { exitCode, endedAt: at });
  }

  /**
   * The `subshells_report` reconnect census (spec §3.3/§5.6): after (re)connecting,
   * the agent lists every subshell it still supervises, and the rows THIS node
   * owns converge toward that truth — under the same guards as every remote
   * mutation (fresh read, `restartInFlight`, `row.nodeId === nodeId`, status
   * re-checks):
   * - reported ALIVE on a parked row (`running` / `alive: 0`): the revive
   *   patch (a restart that spawned but died before its `updateIfRunning`, or
   *   a pane restarted out-of-band) — mirrors the sweep's alive branch, no
   *   notification;
   * - reported ALIVE on a row the backend no longer runs: the operator said
   *   STOP and the kill never reached this node (the offline-stop of
   *   {@link terminateSubshell}) — best-effort kill, the row is never
   *   resurrected;
   * - reported DEAD: the shared death transition, idempotent with the sweep
   *   and {@link applyRemoteExit}.
   * @param nodeId - the socket's authenticated node identity
   * @param report - the frame's per-subshell alive census
   */
  async applySubshellsReport(
    nodeId: string,
    report: Extract<NodeEvent, { type: "subshells_report" }>["subshells"],
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of report) {
      const row = await this.#subshells.findById(entry.subshellId);
      if (!row || row.nodeId !== nodeId) continue; // census authority follows the socket identity
      if (entry.alive) {
        // A restart mid-flight owns the row AND its pane (the launch may
        // legitimately show up in the census before `updateIfRunning` lands).
        if (restartInFlight.has(row.id)) continue;
        if (row.status !== "running") {
          await this.#bestEffortKill(row, "reported alive by the census but the operator stopped it");
          continue;
        }
        if (row.alive !== 1) {
          const patch: SubshellUpdate = { alive: 1, endedAt: null };
          if (row.startedAt == null) patch.startedAt = now;
          await this.#subshells.updateIfRunning(row.id, patch);
          publishLive({ kind: "subshell.changed", id: row.id });
        }
        continue;
      }
      await this.#applyDeath(row, { exitCode: entry.exitCode, endedAt: now });
    }
  }

  /** Whether any harness is installed at all (setup wizard uses this). */
  async anyHarnessInstalled(): Promise<boolean> {
    for (const h of allHarnesses()) {
      if (await h.isInstalled()) return true;
    }
    return false;
  }

  /** Whether a specific harness is installed. */
  async harnessInstalled(harnessId: string): Promise<boolean> {
    const h = getHarness(harnessId);
    return h ? h.isInstalled() : false;
  }
}

/**
 * What an unnamed subshell is called until its harness titles its own pane:
 * the AGENT's display name — "Claude Code", "Terminal" (operator's call,
 * 2026-09-19).
 *
 * It was the current date/time, and the date/time was the wrong thing twice
 * over. It says nothing a row does not already show — the list is ordered by
 * recency and carries a timestamp of its own — and it is the value a person
 * sees while a pane is starting, which is exactly when "what is this" is the
 * question and "when did I start it" is not.
 *
 * It also gives the garbage-title case somewhere sensible to land.
 * {@link normalizePaneTitle} answers "" for a pane title that is really a
 * terminal capability query, and the sweep then leaves the name alone — so
 * what the person reads in the meantime is whatever this returned. A date/time
 * there looked like a bug; the agent's name looks like the truth, because it
 * is one.
 *
 * **Not unique, deliberately.** Several unnamed subshells on one agent read
 * the same until the harness titles them, which for an agent CLI is seconds.
 * A plain `terminal` pane may never title itself and so may keep this name for
 * good — that is the honest name for it, and the operator renames what they
 * care to keep.
 *
 * @param agentName - The harness's display name (`harness.name`)
 * @returns The agent's name, or the old date/time when a manifest has none
 */
export function defaultSubshellName(agentName: string): string {
  const named = agentName.trim();
  if (named) return named;
  // A manifest with a blank name is a broken plugin rather than a case to
  // design for, but a subshell with an EMPTY name is unreadable in every list
  // it appears in, so the old default survives as the last resort.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** The app-wide best-effort audit recorder, used when no sink is injected. */
const defaultAudit: (event: AuditEventInput) => Promise<void> = async (event) => {
  // Static import (module-level) — dynamic imports break `bun build --compile`.
  await audit(event);
};

/**
 * Reads the tail of a subshell's pane log (see the mover: `nodes/log-tail.ts`
 * + `LocalLauncher.readLogTail`). Kept as the import path every route/test
 * already uses; the read itself lives behind the launcher seam.
 *
 * Routed PER ROW (spec §6.5): callers with the subshell row in scope pass its
 * `nodeId`, so an agent-node subshell tails through that node's
 * `RemoteLauncher` (`log_read` size probe + window — byte-identical line
 * math). The default keeps the local file read for rowless callers.
 * @param subshellId - the subshell whose log to tail
 * @param nodeId - where the log lives (default `local`, the control-plane host)
 */
export async function readSubshellLogTail(
  subshellId: string,
  nodeId: string = LOCAL_NODE_ID,
): Promise<{ lines: string[]; truncated: boolean }> {
  return launcherFor(nodeId).readLogTail(subshellId);
}

/** Rough liveness state of a subshell, derived from output recency. */
export type Activity = "active" | "idle" | "terminated";

/**
 * Rough activity: running + output within 60s = active, else idle.
 *
 * Known limitation (plan property, accepted): a subshell that is working but
 * quiet for >60s (e.g. an agent "thinking") shows as idle. A future round
 * could add a progress-aware signal (harness heartbeat or an adaptive
 * window) to avoid false-idle for slow-but-working agents.
 */
export function computeActivity(lastOutputAt: string | null, status: string, now = Date.now()): Activity {
  if (status !== "running") return "terminated";
  if (!lastOutputAt) return "active"; // just started
  return now - new Date(lastOutputAt).getTime() <= 60_000 ? "active" : "idle";
}

/** How many lines of a subshell's screen a preview carries. */
export const PREVIEW_LINES = 20;

/** True when a captured row holds nothing but styling and whitespace. */
function isBlank(line: string): boolean {
  return stripAnsi(line).trim() === "";
}

/**
 * Collapses every run of blank rows to a single one.
 *
 * A terminal screen is mostly empty most of the time: a harness draws its
 * conversation at the top and its input box at the bottom, with a field of
 * blank rows between. Keeping that gap meant the bottom of the screen — the
 * only part a short preview can show — was the gap and the input box, with
 * the actual output stranded above the window. Collapsing pulls the content
 * back into view.
 *
 * A run becomes one blank rather than none, so the paragraph breaks that
 * separate a prompt from its answer survive.
 */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (isBlank(line)) {
      blanks++;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out;
}

/**
 * The bottom `maxLines` of a captured screen, with styling escapes intact.
 *
 * Takes the bottom rather than the top because that is where a terminal puts
 * what just happened. Blank runs are collapsed first (see
 * {@link collapseBlankRuns}) so the window lands on output rather than on the
 * empty middle of the screen, then blanks are trimmed from both ends of the
 * result: trailing ones before the slice, or they would push the content out
 * of the window entirely, and leading ones after it, so nothing starts with a
 * gap.
 */
export function screenTail(screen: string, maxLines = PREVIEW_LINES): string[] {
  const lines = collapseBlankRuns(screen.split("\n"));
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end--;
  let start = Math.max(0, end - maxLines);
  while (start < end && isBlank(lines[start])) start++;
  return lines.slice(start, end);
}

/**
 * A launch refused by the node's directory allowlist (spec 2026-09-05).
 *
 * Carries `status = 403` so the global error handler maps it without a
 * per-route branch — the `.status`-carrying convention every service-local
 * error class here uses. It is an EXPECTED refusal, not a fault: the message
 * names the directory and the rules in force so the operator can act on it.
 */
export class DirNotAllowedError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "DirNotAllowedError";
  }
}

/**
 * Refuses a launch whose directory is outside the node's allowlist
 * (spec 2026-09-05).
 *
 * Applied to the RESOLVED path: `validateWorkingDir` returns `realpathSync`,
 * and testing anything earlier is symlink-blind — `/allowed/link/../../etc`
 * collapses inside the root while the kernel walks out of it.
 *
 * This is the CONTROL PLANE's copy of the rule. The node enforces the same
 * list against its own persisted copy, which is what survives a compromised
 * control plane; this half is what gives the user a clear refusal before
 * anything is spawned, and what holds while a node has yet to receive a push.
 *
 * An empty list means unrestricted, so an unconfigured node is unaffected.
 */
export async function assertDirAllowed(nodeId: string, resolvedDir: string): Promise<void> {
  const dirs = await getRequestlessContext().repos.nodeAllowedDirs.listForNode(nodeId);
  if (dirAllowed(resolvedDir, dirs)) return;
  throw new DirNotAllowedError(
    `"${resolvedDir}" is outside the directories this node allows. Allowed: ${dirs.join(", ")}`,
  );
}

/**
 * {@link assertDirAllowed} under a name that says why it is exported.
 * @internal
 */
export const assertDirAllowedForTests = assertDirAllowed;

/**
 * {@link normalizePaneTitle}, for the tests that pin what a pane may name a
 * subshell. Exported the way `assertDirAllowedForTests` is: the function is an
 * internal of this module, and the alternative is a test that drives a whole
 * tmux sweep to assert one string.
 * @internal
 */
export const normalizePaneTitleForTests = normalizePaneTitle;

/** JSON-safe subshell view (no internal fields). */
/**
 * Whole escape sequences, matched so they can be removed as UNITS.
 *
 * The string kinds first (OSC/APC/DCS/PM/SOS run to a terminator), then CSI,
 * then any remaining two-character escape. An UNTERMINATED string kind eats
 * the rest of the input on purpose: a title captured mid-sequence has no
 * displayable remainder, and keeping the tail is how the payload gets through.
 *
 * Intentional control characters: the whole point is to recognise terminal
 * escape sequences.
 */
const ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: recognising terminal escape sequences
  /\x1b[\]_P^X][\s\S]*?(?:\x1b\\|\x07|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]+(?:[0-~]|$)|\x1b[@-Z\\-_]/g;

/**
 * A terminal-protocol payload with its introducer already gone.
 *
 * `ESC _ G i=31,s=1,v=1,a=q,t=d,f=24 ; AAAA ESC \\` is Kitty's
 * graphics-capability query, which agent CLIs emit at startup to ask whether
 * images are supported. {@link ESCAPE_SEQUENCE} removes it whole when the
 * `ESC _` is present — but tmux stores a DECODED `pane_title`, so what reaches
 * us can be the payload alone, and then there is no escape sequence left to
 * sweep. Measured 2026-09-19 against the real function: the two ESC-bearing
 * forms normalize to "", and `_Gi=31,…;AAAA` survives intact.
 *
 * That is why the earlier fix did not hold. Its comment blamed this function's
 * own laundering — the control pass deleting an `ESC` and the punctuation trim
 * eating the `_` — which was one true route, and closing it left the other
 * open: a payload that never had an introducer by the time we saw it.
 *
 * **The root cause upstream is NOT established.** Something between the agent
 * and `#{pane_title}` is putting an APC payload where a title belongs, and
 * this recognises the result rather than explaining it. Worth chasing if it
 * recurs in another shape; the shape below is narrow enough that a wrong guess
 * costs one unusual title rather than a class of them.
 *
 * **Narrow, and narrower than it first was** (review, 2026-09-19). The rule is:
 * at least TWO `key=value` pairs, no whitespace anywhere in a value, then `;`,
 * then at least four base64 characters. Nothing else in the string.
 *
 * Each clause bought back a class of real titles. The first version allowed one
 * pair, any non-`,;` value, and an EMPTY tail, which made it "a word, `=`,
 * anything, `;`, optionally a word" — and it ate `PATH=/usr/bin;ls`,
 * `TZ=UTC;date`, `host=db;psql`, `branch=feat/qr;push` and
 * `task=Fix the login bug;`, all measured against the real function. The
 * comment said "a human title does not look like this" while the regex said
 * something much broader; the comment was the part that was wrong.
 *
 * The Kitty query clears all three clauses with room to spare — six pairs, no
 * whitespace, a four-character tail — so nothing was given up to buy them.
 * `-` and `_` are in the tail class because base64url spells the same payload
 * with them, which the first version missed.
 */
const PROTOCOL_PAYLOAD = /^[A-Za-z]?(?:[A-Za-z]+=[^,;\s]*)(?:,[A-Za-z]+=[^,;\s]*)+;[A-Za-z0-9+/=_-]{4,}$/;

/**
 * Cleans a raw tmux `pane_title` for use as a subshell name: escape sequences
 * are removed whole, control residue collapses to single spaces, a leading
 * status decoration is dropped (Claude Code prefixes the title with a cycling
 * glyph — ✳/✻/· — that would otherwise churn the name between sweeps), and the
 * result is bounded like every other name the API accepts (120 chars). Returns
 * "" for a title that has nothing displayable in it.
 *
 * **Sequences go first, and that ORDER is the fix** (operator's screenshot,
 * 2026-09-18). This blanked control characters one at a time, which deleted
 * the `ESC` from an APC and left its payload behind as ordinary text — and the
 * leading-punctuation trim then ate the `_` introducer too, so a Kitty
 * graphics capability QUERY the agent emitted to probe for image support
 * arrived in the sidebar as a subshell named
 * `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA`. Every step of that laundering was this
 * function's own: it removed exactly the two characters that identified the
 * text as not a title, then kept the rest.
 *
 * So a title that is nothing but a sequence now normalizes to "", and the
 * caller falls back to the name it already had.
 *
 * **The `nF` forms are part of that**, and they were missed at first (review,
 * 2026-09-18): `ESC` followed by intermediate bytes (0x20–0x2F) and one final
 * byte — `ESC ( B`, `ESC # 8`, `ESC SP F`. A charset reset is ordinary in
 * terminal output, and without this branch the sweep left it alone, the
 * control pass below deleted the bare `ESC`, and a pane running `npm run dev`
 * was named `Bnpm run dev` in every sidebar it appeared in. Exactly the same
 * laundering as the Kitty query, by a shorter route.
 *
 * A TRUNCATED one goes too — `ESC (` at end of string, with the final byte
 * past the capture — the way the OSC branch already takes an unterminated
 * string. Without it the `ESC` fell to the control pass and the intermediate
 * byte survived as a stray `(`: one character rather than a payload, but it is
 * the class this function claims to close (review, 2026-09-18).
 */
function normalizePaneTitle(raw: string): string {
  const withoutSequences = raw.replace(ESCAPE_SEQUENCE, " ");
  // Intentional: whatever control characters survive a sequence sweep are
  // stray bytes, not structure.
  //
  // The range covers C1 (U+0080–U+009F) as well as C0, because valid UTF-8 can
  // carry an 8-bit introducer — U+009B is CSI — and one would otherwise pass
  // both this pass and the sequence sweep above, which only knows the 7-bit
  // `ESC x` forms (review N3). Not a laundering path of the kind this function
  // exists to close, since a name renders as text, but it is the one thing the
  // sweep does not cover and a title has no business carrying one.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing terminal output
  const cleaned = withoutSequences.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  const trimmed = cleaned.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  // A payload whose introducer never reached us is still not a title — see
  // PROTOCOL_PAYLOAD. "" makes the caller keep the name it already had.
  if (PROTOCOL_PAYLOAD.test(trimmed)) return "";
  return trimmed.slice(0, 120);
}

export function toSubshellView(
  row: {
    id: string;
    userId: string;
    presetId: string | null;
    harnessId: string;
    nodeId: string;
    name: string;
    workingDir: string;
    status: string;
    createdAt: string;
    endedAt: string | null;
    lastOutputAt: string | null;
    alive: number;
    exitCode: number | null;
    startedAt: string | null;
    backoffCount: number;
    restartOnExit: number;
    nextRestartAt: string | null;
    nameLocked: number;
    notify: number;
    waitingSince: string | null;
  },
  status: string,
  /** The subshell's current screen, bottom-first-trimmed; empty when not running. */
  preview: string[] = [],
  /**
   * Viewer-relative access to attach to the view. A returned row is always
   * visible to *someone*, so this is never `"none"`. Defaults to `"owner"` so
   * the many owner-keyed direct callers stay valid; the sharing service
   * overrides it per-viewer.
   */
  access: Exclude<Access, "none"> = "owner",
  /**
   * The row's agent node has no live connection (spec §5.6) — the subshell
   * may still be running there. Computed by the caller via
   * {@link isNodeOffline}; local rows (and every legacy caller) pass nothing
   * and read false.
   */
  nodeOffline = false,
) {
  return {
    id: row.id,
    presetId: row.presetId,
    harnessId: row.harnessId,
    nodeId: row.nodeId,
    name: row.name,
    workingDir: row.workingDir,
    status,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    lastOutputAt: row.lastOutputAt,
    activity: computeActivity(row.lastOutputAt, status),
    // The manager is OWNER-KEYED and knows nothing about grants, so it reports
    // the private shape. `subshells.service.ts` — the sharing-aware layer that
    // already loads the grant map to resolve `access` — overrides both.
    shareCount: 0,
    sharedWithEveryone: false,
    // The subshell's current screen, captured by the caller (see
    // SubshellManagerService#preview). Passed in rather than read here so this
    // stays a pure mapping and the tmux call has one home.
    preview,
    alive: row.alive === 1,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    backoffCount: row.backoffCount,
    restartOnExit: row.restartOnExit === 1,
    nextRestartAt: row.nextRestartAt,
    nameLocked: row.nameLocked === 1,
    notify: row.notify === 1,
    // ISO ts of the attention event that put this subshell in waiting-for-you
    // state (null = not waiting); cleared by the watcher on output-resume/death.
    waitingSince: row.waitingSince,
    access,
    // Agent node unreachable right now (see the param doc) — the UI's
    // "node offline" chip; false for every local subshell.
    nodeOffline,
  };
}
