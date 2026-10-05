import { homedir as osHomedir } from "node:os";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
// The attention kinds are imported from the reporter that SPEAKS them rather
// than restated here: the old local `Extract<NotifyKind, …>`, widened once to
// `NotifyKind | "resumed"`, admitted push kinds (`crashed`, `maintenance`, …)
// the endpoint takes from no one — only the route's schema was holding the
// line. `resumed` is deliberately NOT a `NotifyKind` in either file: resuming
// is a state change, nothing rings for it.
import type { AttentionKind } from "@internal/mcp-core";
import { allHarnesses, getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { joinPresetPrompt, NODE_RESULT_MAINTENANCE, parsePresetPromptBlocks } from "@internal/subshell-protocol";
import type { GuardActor } from "@/api/auth-guard.js";
import { HttpError } from "@/api/auth-guard.js";
import { harnessUsable } from "@/api/harness-utils.js";
import type { ShareEntry } from "@/db/repositories/subshell-shares.repository.js";
import { summarizeSubshells } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { PresetTable } from "@/db/types/presets.db-types.js";
import type { SshActorSide } from "@/db/types/ssh-actor-side.js";
import type { SshTerminalExecTable } from "@/db/types/ssh-terminal-execs.db-types.js";
import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { loadNodeAccess, type NodeAccessDeps, nodeCanLaunch, nodeCanLaunchOn } from "@/lib/node-access.js";
import { type Access, accessAtLeast, loadSubshellAccess, resolveSubshellAccess } from "@/lib/subshell-access.js";
import { BaseService, type CommonServiceParams } from "@/services/base.service.js";
import { publishLive } from "@/services/live-bus.js";
import { lockdownEnabled } from "@/services/lockdown.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import type { LogCursorRequest, LogWindowReader } from "@/services/nodes/log-tail.js";
import { getLive, isNodeOffline } from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import {
  EXEC_MAX_OUTPUT_BYTES,
  execOutputTail,
  execSentinelCommand,
  execSentinelToken,
  execTimeoutMs,
  probeQuiet,
  waitSentinel,
} from "@/services/nodes/pane-exec.js";
import { isNodeOfflineError } from "@/services/nodes/remote-launcher.js";
import { getNotifyService } from "@/services/notify.service.js";
import {
  gateHumanActFor,
  gatePaneSurfaceFor,
  gateSharingFor,
  getSshPaneHooks,
  readManagedPane,
  readManagedPanes,
  type SshCallerSeed,
  SshGateFailure,
  type SshManagedPaneFacts,
  transitionPaneControl,
} from "@/services/pane-ssh-gate.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import type { SshControlView, SshTerminalExecView } from "@/services/ssh/ssh-api-types.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshPaneSurface } from "@/services/ssh/ssh-policy.js";
import {
  PROMPT_POLL_MS,
  PROMPT_SETTLE_TIMEOUT_MS,
  RestartInFlightSwapError,
  readSubshellLogWindow,
  SubshellManagerService,
} from "@/services/subshell-manager.service.js";
import { extendSubshellToken, subshellTokenTtlSeconds } from "@/services/subshell-tokens.js";
import {
  cancelObservation,
  completeExec,
  hasBlockingUnknown,
  insertExec,
  invalidateOutstandingExecs,
  loadExec,
  observationActive,
  observeExecToResolution,
  paneHeld,
  reconcileStaleIncarnation,
  refuseAfterUnknown,
  releasePane,
  toExecView,
  tryHoldPane,
} from "@/services/terminal-exec-records.js";
import { logger } from "@/utils/logger.js";
import { closeViewersForSubshell } from "@/ws/viewers.js";

/** Subshell view shape returned by the manager (single source: toSubshellView). */
type SubshellView = NonNullable<Awaited<ReturnType<SubshellManagerService["getSubshell"]>>>;

/** A sharing grant as returned to the client, with the grantee label resolved. */
interface SubshellShareView {
  /** Share row id */
  id: string;
  /** Grantee user id, or null for the Everyone grant */
  granteeUserId: string | null;
  /** Display name ("Everyone" for the null grant; the id if the user is gone) */
  granteeName: string | null;
  /** Access level this grant confers */
  permission: SubshellSharePermission;
}

/** Route error with an HTTP status; Elysia maps `status` to the response code. */
class SubshellCreateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Thrown when a subshell (or its owner-visible surface) does not exist; maps to 404. */
class SubshellError extends Error {
  readonly code: string;
  readonly status = 404;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The maintenance refusal for a caller who may not be able to SEE the node.
 *
 * Subshell shares and node shares are independent axes, so an `edit` grantee
 * on somebody else's subshell reaches the restart path holding no access at
 * all to the machine it runs on — and every other refusal there is name-free
 * for exactly that reason. The NAMED variant is correct and stays in
 * `resolveLaunchNode`, which sits behind a visibility 404: a caller who got
 * that far has the node on their screen already.
 */
const MAINTENANCE_REFUSAL = "That node is in maintenance and is accepting no new subshells";

/**
 * The exec-record INCARNATION key for a row: its `startedAt` stamp, the fact
 * that changes on every respawn (migration 0048's honest restart test). A
 * running+alive pane always carries it; the empty-string fallback exists only
 * to keep the NOT-NULL column an honest poison value for the row that could
 * not legally be exec'd - no observer or reconcile can ever call a null stamp
 * "current", so such a row's records go `unknown` rather than lying.
 */
function paneIncarnation(row: SubshellTable): string {
  return row.startedAt ?? "";
}

/**
 * Map a node-flavored manager throw onto the structured 409 it deserves.
 * Every other error keeps whatever mapping it had: the rethrow rides the
 * global handler unchanged.
 *
 * Two refusals travel this way:
 *
 * - **Offline** (spec §5.6) — the pane may still be running on the node, so
 *   the row is the UI's truth again rather than an error.
 * - **Maintenance** (spec 2026-09-14 §5.1) — the MACHINE refused the launch
 *   because its own file says it is out of service. The plane gates this
 *   itself from the node row, so reaching here means the node knew first: a
 *   window opened at the keyboard, in the gap before the agent's `maintenance`
 *   event converged the row. Without this branch that window answers 500,
 *   which reads as a broken server rather than as the setting somebody just
 *   changed. Compared against `detail` — the agent's `error` string VERBATIM
 *   — and by equality, never by substring-matching the sentence
 *   `NodeRpcError` wraps it in.
 *
 * Shared by create, restart and the log tail. A log tail can never see the
 * maintenance refusal (only `launch` is refused in a window), so the sharing
 * costs the third caller nothing and keeps one mapper instead of two that
 * drift.
 *
 * @throws ApiError 409 NODE_OFFLINE / 409 NODE_IN_MAINTENANCE (doNotLog — both
 *         are expected 4xx classes)
 */
function rethrowLaunchRefusal(err: unknown): never {
  if (isNodeOfflineError(err)) {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "The subshell's node has no live connection; it may still be running the subshell there",
      doNotLog: true,
    });
  }
  if (err instanceof NodeRpcError && err.code === "failed" && err.detail === NODE_RESULT_MAINTENANCE) {
    throwApiError({
      code: BackendErrorCodes.NODE_IN_MAINTENANCE,
      message: MAINTENANCE_REFUSAL,
      doNotLog: true,
    });
  }
  throw err;
}

/**
 * THE launch-node decision for a new subshell (spec 2026-08-31 §6.6), in
 * strict precedence — a request that says where to run is never silently
 * relocated:
 *
 * 1. `requestedNodeId` (body) — gate it: row absent OR invisible ⇒ 404, so
 *    the id is never an existence oracle (spec §2). IN MAINTENANCE ⇒ 409
 *    NODE_IN_MAINTENANCE — nobody launches in a window, owner, admin and
 *    grantee alike (spec 2026-09-14 decision 1). VISIBLE BUT UNLAUNCHABLE
 *    ⇒ 403: since 2026-09-12 that state exists for exactly one row, the
 *    control-plane host narrowed to named people, which an admin still
 *    sees because seeing it is how they switch it back on. The 404 above runs
 *    FIRST, so the 403 can only ever name a node already on the caller's own
 *    Nodes page. An AGENT node with no live connection ⇒ 409 NODE_OFFLINE.
 * 2. `local` when its own access check grants launch AND it is not in
 *    maintenance AND `allow_server_subshells` is on — today's default, and
 *    the switches on it (an admin
 *    deleting local's Everyone row turns this step off for EVERYONE, admins
 *    included: `nodeCanLaunchOn` reads the granted access there, never the
 *    admin boost, or the one person who can throw the switch would be the one
 *    person it does not apply to).
 * 3. Auto-pick: exactly one ONLINE agent among the caller's candidates that is
 *    not in maintenance — `findAccessible` for a browser actor, `listByOwner`
 *    for a bearer. Zero or several ⇒ 400 NODE_REQUIRED ("pick one"; the spec's
 *    single-online auto-pick is read literally — two online nodes is NOT a
 *    choice). This step never reaches `nodeCanLaunchOn`, so the flag is
 *    filtered here by hand: an implicit launch must never relocate onto a
 *    machine whose owner took it out of service.
 *
 * The preset PIN died with spec 2026-09-13 §2.3 (a preset could pin a node
 * and relocate a launch the human pointed elsewhere); spec 2026-09-29
 * preset-launch-fields brought a HINT back, not the pin: a preset may name a
 * node, but the create path resolves `body.nodeId ?? preset.nodeId` BEFORE
 * calling this, so the resolver sees one plain requested node (or none) and
 * the precedence body → host → lone-online stays exactly as written. The
 * resolver never reads a preset, and nothing here can relocate a stated
 * request.
 *
 * MACHINE actors (`machineActor: true` — any bearer token, subshell or
 * system key) get the STRICT loader everywhere: no admin boost, no shares,
 * owner-only — so a leaked harness key can never spawn a control-plane
 * subshell (local belongs to the system user) nor ride a shared node.
 *
 * @param deps - the repositories the access resolver reads (nodes, shares,
 *               userMeta) — injected so tests drive a scratch DB
 * @returns the node id to launch on (`local` = control-plane host)
 * @throws SubshellCreateError 404 (absent/invisible, spec §2) and 403
 *         (`node_launch_disabled` — the visible host with launching off);
 *         ApiError 409 NODE_OFFLINE (offline gate) and 400 NODE_REQUIRED
 *         (auto-pick)
 */
export async function resolveLaunchNode(
  {
    userId,
    machineActor,
    requestedNodeId,
    serverAsNodeEnabled = true,
  }: {
    /** The creating user (bearer actors arrive as their owning user). */
    userId: string;
    /** True for every non-cookie actor — switches off admin boost + shares. */
    machineActor: boolean;
    /** Explicit `body.nodeId` (may name `local`). */
    requestedNodeId?: string;
    /**
     * The `allow_server_subshells` setting, pre-read by the caller (it is
     * given the way `machineActor` is — a fact about the request, not a
     * lookup inside the rule). Default true: a resolver call that knows
     * nothing of the setting behaves exactly as it did before it existed.
     */
    serverAsNodeEnabled?: boolean;
  },
  deps: NodeAccessDeps,
): Promise<{ nodeId: string }> {
  /** The step-1 gate: existence → launch access → agent liveness. */
  const gate = async (nodeId: string): Promise<{ nodeId: string }> => {
    const { row, access, granted } = await loadNodeAccess(deps, userId, nodeId, {
      allowAdminAndShares: !machineActor,
    });
    // Any share grants launch (spec §2): access "none" ⇔ invisible ⇒ 404.
    if (!row || !nodeCanLaunch(access)) {
      throw new SubshellCreateError("node_not_found", "Node not found", 404);
    }
    // Maintenance BEFORE the share reading and before liveness, because it is
    // the only one of the three the caller can do something about and the
    // only one that is true of everybody: a window refuses the owner, every
    // admin and every grantee alike, `local` included. Saying "offline"
    // about a machine whose owner deliberately took it out of service sends
    // someone to check a network; saying "no launch access" invites them to
    // ask for a share that would change nothing.
    //
    // It is stated here rather than left to `nodeCanLaunchOn` below — which
    // ANDs the same flag — so the refusal carries its own code and message.
    if (row.maintenance === 1) {
      throwApiError({
        code: BackendErrorCodes.NODE_IN_MAINTENANCE,
        message: `${row.name} is in maintenance and is accepting no new subshells`,
        doNotLog: true,
      });
    }
    // The ONE visible-but-unlaunchable node (spec 2026-09-12): the
    // control-plane host is narrowed to named people, and this viewer only
    // reaches it through the admin boost. A 403 rather than the 404 above —
    // they can see this node on the Nodes page, and "not found" about a row
    // on their screen reads as a bug rather than as a setting.
    //
    // `local` can be refused two ways now, and they read differently because
    // the remedies differ: the admin switched the host off (settings), or a
    // share was removed (sharing). `nodeCanLaunchOn` ANDs both into one
    // boolean that cannot say which, so the switch is checked first and gets
    // its own sentence — sending someone to the sharing dialog when an admin
    // turned the machine off is a dead end, exactly the "offer that ends
    // nowhere" the launch-form empty state already refuses to be.
    if (!nodeCanLaunchOn(row.kind, access, granted, row.maintenance === 1, serverAsNodeEnabled)) {
      if (row.kind === "local" && !serverAsNodeEnabled) {
        throw new SubshellCreateError(
          "node_launch_disabled",
          `Launching on ${row.name} is switched off in server settings. Ask an admin to turn it back on, or pick another machine.`,
          403,
        );
      }
      throw new SubshellCreateError(
        "node_launch_disabled",
        `No one is granted launch access on ${row.name}. Share it with Everyone or with specific people to allow launching.`,
        403,
      );
    }
    if (row.kind === "agent" && !getLive(nodeId)) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "That node has no live connection",
        doNotLog: true,
      });
    }
    return { nodeId };
  };

  if (requestedNodeId) return gate(requestedNodeId);

  // Step 2: the control-plane host (its seeded Everyone/edit share is the
  // launch grant and its maintenance flag the switch; either missing
  // relocates to step 3). An IMPLICIT local launch is deliberately silent
  // about both: the caller named no node, so there is nothing to explain yet
  // — step 3 answers, or NODE_REQUIRED does.
  const local = await loadNodeAccess(deps, userId, LOCAL_NODE_ID, { allowAdminAndShares: !machineActor });
  if (
    local.row &&
    nodeCanLaunch(local.access) &&
    nodeCanLaunchOn(local.row.kind, local.access, local.granted, local.row.maintenance === 1, serverAsNodeEnabled)
  ) {
    return { nodeId: LOCAL_NODE_ID };
  }

  // Step 3: single-online-agent auto-pick over the actor's candidate set. The
  // maintenance filter is spelled out because this step never reaches
  // `nodeCanLaunchOn` — an implicit launch must not relocate onto a machine
  // its owner took out of service, and "the only online node" is exactly
  // where that would happen unnoticed.
  const candidates = machineActor ? await deps.nodes.listByOwner(userId) : await deps.nodes.findAccessible(userId);
  const online = candidates.filter((n) => n.kind === "agent" && n.maintenance !== 1 && getLive(n.id));
  if (online.length === 1) return { nodeId: online[0].id };
  throwApiError({
    code: BackendErrorCodes.NODE_REQUIRED,
    message:
      online.length === 0
        ? "No launch-eligible node; pick one"
        : `Multiple online nodes; pick one explicitly (${online.length} are online)`,
    doNotLog: true,
  });
}

/**
 * THE launch resolution (spec 2026-09-29 preset-launch-fields): the chosen
 * preset may name a node, a directory, and a prompt; the REQUEST wins wherever
 * it said something, the preset fills every gap it left. Pure so the whole
 * matrix is testable without a machine on the other side; every door - web,
 * mobile, and MCP - arrives at it through `createSubshell`, and the manager
 * keeps receiving plain resolved facts, never a row to interpret. A preset's
 * node hint comes back as an ordinary requested node: the SAME gate a typed
 * one faces, refusal included. Determinism is the whole cross-comm promise;
 * there is no silent fallback.
 */
export function resolvePresetLaunch(
  body: { workingDir?: string; prompt?: string; nodeId?: string },
  presetRow: PresetTable | undefined,
): { workingDir?: string; nodeId?: string; prompt?: string } {
  const promptText = joinPresetPrompt(parsePresetPromptBlocks(presetRow?.promptBlocks) ?? []);
  return {
    workingDir: body.workingDir ?? presetRow?.workingDir ?? undefined,
    nodeId: body.nodeId ?? presetRow?.nodeId ?? undefined,
    prompt: body.prompt ?? (promptText.trim() === "" ? undefined : promptText),
  };
}

/** What one `execInTerminal` call answers (spec 2026-10-02 §2, widened by the SSH feature's exec records). */
export interface ExecAnswer {
  /** `completed`: the sentinel line landed before the deadline; `timed_out`: it never did (the command may still be running - ruling 2). */
  status: "completed" | "timed_out";
  /** The exit code the shell reported; null when no sentinel landed. */
  exitCode: number | null;
  /** The pane's output between the quiet mark and the sentinel, newline-joined, newest lines kept within the byte cap. */
  output: string;
  /** True when older output was dropped to keep `output` inside {@link EXEC_MAX_OUTPUT_BYTES}. */
  truncated: boolean;
  /** Raw byte offset just past the sentinel line (or where a timed-out scan stopped): the caller's next log cursor read. */
  nextByte: number;
  /**
   * The `ssh_terminal_execs` recovery handle (spec §3's execution IDs): read
   * the durable record back at `GET /:id/execs/:executionId` - the
   * `get_terminal_execution` door. A `timed_out` answer means the record is
   * still `outstanding`: observation continues past this caller's wait.
   */
  executionId: string;
}

/**
 * Business logic behind `/api/subshells`, one method per endpoint.
 *
 * A thin layer over {@link SubshellManagerService} (the subshell lifecycle truth,
 * built once per service instance — not per call) plus the preset/harness
 * gating and permission-adjacent checks the HTTP surface needs. Errors ride
 * the global error handler as `status`-carrying classes.
 */
export class SubshellsService extends BaseService {
  /** Built once per request (not once per call) from the context's repositories. */
  readonly #manager: SubshellManagerService;
  /** The managed-pane marker table - the log-read branch persists rotation stamps through it. */
  readonly #sshPanes: SshPanesRepository;

  constructor(params: CommonServiceParams) {
    super(params);
    this.#manager = new SubshellManagerService({
      subshells: params.repos.subshells,
      presets: params.repos.presets,
    });
    this.#sshPanes = new SshPanesRepository(params.db);
  }

  /**
   * Creates a new agent subshell (starts the harness on the node §6.6
   * resolves — control-plane host unless stated otherwise) and returns only
   * the client-safe fields — the MCP apiKey is issued once inside the
   * manager for env injection and is NEVER echoed to the HTTP client.
   * The preset is OPTIONAL (spec 2026-09-13 §4): `harnessId` names what
   * launches, and an omitted preset composes the launch from nothing —
   * `EMPTY_PRESET` adds no env, no flags, no isolation.
   * @throws SubshellCreateError 404 when the (given) preset is absent, or
   *         the requested node is absent OR invisible (spec §2: 404-not-403
   *         — an invisible node never answers 403); 400 when a given preset
   *         belongs to a different harness than the body names
   *         (`preset_harness_mismatch`); 403 (node launch switched off).
   * @throws ApiError 409 NODE_OFFLINE (agent node unreachable), 400
   *         NODE_REQUIRED (no launch-eligible node), 409 when the harness is
   *         disabled/unusable ON THE RESOLVED NODE.
   */
  async createSubshell({
    userId,
    harnessId,
    presetId,
    workingDir,
    name,
    prompt,
    nodeId,
    machineActor,
    crossAgent,
  }: {
    /** Owner of the new subshell (never taken from the body). */
    userId: string;
    /** Harness plugin to launch — the ONE required thing this call needs. */
    harnessId: string;
    /** Preset to launch with; absent/null = a presetless launch (EMPTY_PRESET). */
    presetId?: string | null;
    /**
     * Absolute working directory. Optional since spec 2026-09-29: the chosen
     * preset may carry one. Request wins; when neither does, the caller gets
     * the 400 below.
     */
    workingDir?: string;
    /** Optional subshell display name. */
    name?: string;
    /**
     * Optional task text typed into the pane once the harness settles. When
     * the request says none, the preset's prompt blocks (if any) supply it.
     */
    prompt?: string;
    /** Node to launch on (spec §6.6); omitted/`local` = control-plane host.
     *  A preset's node hint fills this when the request names none. */
    nodeId?: string;
    /**
     * True for any bearer (non-cookie) actor — enforced by the user-ratified
     * STRICT rule: bearer creation resolves nodes with no admin boost and no
     * shares, owner-only, the implicit `local` fallback included.
     */
    machineActor: boolean;
    /**
     * True when the launch arrived on a pane's own token (an agent opening a
     * sibling over MCP). The row is stamped cross-agent (what the rail files
     * under "Cross-agent comms"), and the bell defaults OFF — internal
     * cross-agent chatter is not news to ring the human's devices for, though
     * they can still turn it on from the pane's menu.
     */
    crossAgent: boolean;
  }): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    // Lockdown is the FIRST question the instance asks of every create
    // (operator ask 2026-09-24): it answers valid bodies and invalid ones
    // alike, before any machine is chosen or any preset is looked up, and it
    // catches every entry point at once — the REST route, a bearer (pane)
    // token, and MCP sibling launches all arrive here.
    if (await lockdownEnabled(this.db)) {
      throw new SubshellCreateError(
        "lockdown",
        "This instance is in lockdown mode, so no new subshells can be started. Ask an admin to end it.",
        403,
      );
    }
    // Gate new subshells here, not inside SubshellManagerService: its own
    // restart path reuses createSubshell, and an existing subshell's harness
    // must keep starting even once its harness is disabled.
    let presetRow: PresetTable | undefined;
    if (presetId) {
      presetRow = await this.repos.presets.findById(presetId);
      if (!presetRow || presetRow.userId !== userId) {
        throw new SubshellCreateError("not_found", "Preset not found", 404);
      }
      if (presetRow.harnessId !== harnessId) {
        // A preset only customises ITS harness — silently launching the
        // preset's harness instead of the asked-for one (or the asked-for
        // one without the settings it names) would both be a lie.
        throw new SubshellCreateError(
          "preset_harness_mismatch",
          `Preset is for harness "${presetRow.harnessId}", not "${harnessId}"`,
          400,
        );
      }
    }
    // THE launch resolution (spec 2026-09-29 preset-launch-fields), pure form
    // in {@link resolvePresetLaunch}; the throws and gates below stay here.
    const resolved = resolvePresetLaunch({ workingDir, prompt, nodeId }, presetRow);
    const harnessPlugin = getHarness(harnessId);
    // Spec 2026-10-01 §2: a PRESETLESS launch of a terminal-type harness with
    // no named directory gets the launch node's home. The answer depends on
    // which machine wins, so the default is computed after node resolution and
    // the missing-dir 400 is deferred for exactly this shape — presetless,
    // terminal type, no dir. Every other no-dir launch keeps answering the
    // 400 HERE, before anything node-shaped can reply (the ordering the
    // harness-existence check below cites for its own reason).
    const presetlessTerminal = presetRow === undefined && harnessPlugin?.type === "terminal";
    if (resolved.workingDir === undefined && !presetlessTerminal) {
      throw new SubshellCreateError(
        "bad_request",
        "A working directory is required: pass one, or launch from a preset that carries one",
        400,
      );
    }
    const resolvedPrompt = resolved.prompt;
    // An id that resolves to NO plugin names nothing — a typo, or a plugin
    // that failed to load (broken plugins enter neither the registry nor the
    // overlay). Say so (400, the same status `POST /api/presets` uses) before
    // anything node-shaped can answer instead: this check depends on nothing
    // node resolution produces, so running it after would let a typo on an
    // instance with no launch-eligible node come back as NODE_REQUIRED
    // ("pick one") rather than "Unknown harness". Only the USABILITY gate
    // below is per-node; disabled-but-known still 409s there.
    //
    // The refusal NAMES the options (spec 2026-09-25, MCP DX): the machine
    // reader that arrives through this error has no other enumeration path in
    // hand, and a bare "unknown" forces a guess-retry loop. The list is what
    // `getHarness` actually resolves against (built-ins plus the installed
    // overlay), sorted, so two identical mistakes answer identically.
    if (!harnessPlugin) {
      const available = allHarnesses()
        .map((h) => h.id)
        .sort()
        .join(", ");
      throw new SubshellCreateError(
        "bad_request",
        `Unknown harness: ${harnessId}. Available harnesses: ${available}`,
        400,
      );
    }
    // §6.6 precedence BEFORE the per-node harness gate: "where" must be
    // settled first, since "usable" is per-node now (spec §6.2).
    let resolvedNodeId: string;
    try {
      resolvedNodeId = (
        await resolveLaunchNode(
          {
            userId,
            machineActor,
            // A preset's hint reaches the SAME gate as an explicit body nodeId
            // (resolved above); `undefined` feeds the existing ladder.
            requestedNodeId: resolved.nodeId,
            // Read per create, not cached: a PATCH flips it for the NEXT launch,
            // and the row read is a single indexed SELECT on the same DB this
            // request already hammers.
            serverAsNodeEnabled: await serverSubshellsEnabled(this.db),
          },
          { nodes: this.repos.nodes, shares: this.repos.nodeShares, userMeta: this.repos.userMeta },
        )
      ).nodeId;
    } catch (err) {
      // When a machine refusal rides a PRESET hint the caller never named,
      // say where the hint came from (spec 2026-09-29-preset-launch-fields):
      // "pick another machine" cannot be followed by someone who only asked
      // for the preset by name. The refusal's own code and status stand.
      if (err instanceof SubshellCreateError && nodeId === undefined && presetRow?.nodeId != null) {
        throw new SubshellCreateError(
          err.code,
          `${err.message} (the preset "${presetRow.name}" names this machine; pass another nodeId to override)`,
          err.status,
        );
      }
      throw err;
    }
    if (!(await harnessUsable(harnessId, resolvedNodeId))) {
      // Copy honesty: on an AGENT node "this machine" is a lie — the harness
      // may simply not be installed there (spec §6.2 per-node inventory). The
      // local wording stays verbatim — legacy tests pin it.
      throw new SubshellCreateError(
        "harness_disabled",
        resolvedNodeId === LOCAL_NODE_ID
          ? "That harness is disabled on this machine"
          : "That harness is disabled or not installed on that node",
        409,
      );
    }
    // The deferred default (spec 2026-10-01 §2): the launch node's home, read
    // only from sources this request already has — the local host's homedir,
    // or the agent's reported `ready` facts. A node that has never reported a
    // home gets the honest 400 naming what is missing; a default is never
    // fabricated, and an allowlist that excludes the home refuses the launch
    // exactly as it would any hand-typed directory (gated downstream, twice).
    let launchWorkingDir = resolved.workingDir;
    if (launchWorkingDir === undefined) {
      const home = resolvedNodeId === LOCAL_NODE_ID ? osHomedir() : getLive(resolvedNodeId)?.agent?.homeDir;
      if (home === undefined || home === "") {
        throw new SubshellCreateError(
          "bad_request",
          "A working directory is required: pass one (that node has not reported a home directory)",
          400,
        );
      }
      launchWorkingDir = home;
    }
    // The manager already rolled the row + token back; a node that dropped
    // offline between resolution and launch answers with the same structured
    // 409 the restart boundary gives (§5.6) — everything else rethrows.
    const created = await this.#manager
      .createSubshell({
        userId,
        harnessId,
        presetId: presetId ?? null,
        workingDir: launchWorkingDir,
        name,
        prompt: resolvedPrompt,
        nodeId: resolvedNodeId,
        crossAgent: crossAgent ? 1 : 0,
        // Notifications default ON for new subshells (spec 2026-08-31); the
        // per-user master switch still gates the actual send, and the
        // operator can mute an individual subshell with its bell. A
        // cross-agent launch (operator ask 2026-09-25): the bell defaults
        // OFF — agent-to-agent comms are not news a human needs rung for —
        // and it stays togglable exactly like any other pane's.
        notify: !crossAgent,
      })
      .catch(rethrowLaunchRefusal);
    // Feed the picker's Recents (and the new-subshell form's pre-fill) from
    // real use — scoped to the node the subshell actually launched on, so a
    // remote machine's paths never surface in the local picker (and vice
    // versa). Best-effort: the subshell EXISTS at this point, and a book-
    // keeping insert failing must not turn a successful launch into an error.
    await this.repos.recentPaths.touch(userId, launchWorkingDir, name ?? null, resolvedNodeId).catch(() => {});
    // The MCP apiKey is returned by the manager for env injection only; it is
    // a secret issued once and NEVER echoed to the HTTP client.
    return { id: created.id, tmuxSocket: created.tmuxSocket, promptDelivered: created.promptDelivered };
  }

  /**
   * Lists every subshell the caller can SEE — their own plus those shared with
   * Everyone or with them by name (all for an admin) — as manager-reconciled
   * views carrying the caller's viewer-relative `access`. A private foreign
   * subshell is simply absent, never a 403.
   *
   * The SSH branch: managed panes absent from the ordinary visibility math
   * (list previews is a policy surface) are FILTERED OUT for this caller - a
   * same-owner sibling without its own grant, an admin, a stranger; every one
   * of them sees a list without the row, exactly as they see no row for a
   * private foreign pane. The filter asks the policy per managed row (the
   * list is per-user small, and one PK read covers them all); an unmanaged
   * list costs one empty-batch read and no policy calls.
   * @param viewerId - The signed-in user (resolved from cookie or subshell key)
   */
  async listSubshells(
    viewerId: string,
    opts: { previews?: boolean } = {},
    ssh?: SshCallerSeed,
  ): Promise<SubshellView[]> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const rows = await this.repos.subshells.listVisibleTo(viewerId, isAdmin);
    // SSH census (list_preview): drop the rows this caller may not preview.
    const visible =
      rows.length > 0
        ? await this.#dropUngrantedSsh(
            ssh ?? { actor: "cookie", userId: viewerId, principal: `user:${viewerId}`, apiKeyId: null },
            rows.map((r) => r.id),
            "list_preview",
          )
        : [];
    const kept = new Set(visible);
    const rowsShown = rows.filter((r) => kept.has(r.id));
    const sharesBy = await this.repos.subshellShares.listForSubshells(rowsShown.map((r) => r.id));
    // Resolve access per row (needs the owner id, which the view doesn't carry),
    // keyed by id so the view mapping stays a plain lookup. A visible row always
    // resolves to view/edit/owner; "none" is impossible here but the type
    // carries it, so the fallback names the weakest real access.
    const accessBy = new Map<string, Exclude<Access, "none">>();
    for (const row of rowsShown) {
      const access = resolveSubshellAccess(viewerId, isAdmin, row.userId, sharesBy.get(row.id) ?? []);
      accessBy.set(row.id, access === "none" ? "view" : access);
    }
    const views = await this.#manager.toViews(rowsShown, opts);
    return views.map((view) => ({
      ...view,
      access: accessBy.get(view.id) ?? ("view" as const),
      ...shareExposure(sharesBy.get(view.id) ?? []),
    }));
  }

  /**
   * The list/preview/live filter: of the caller-visible ids, drop the managed
   * SSH panes whose policy decision this caller does not earn (`refuse` arm:
   * same-owner sibling without its own grant, admin, stranger). Ordinary ids
   * pass through with no policy call; one batch PK read finds the managed
   * subset. A THROWING policy read is a refusal (deny by default), and the
   * filtered-out row is simply absent - never a 403, so lists cannot probe.
   */
  async #dropUngrantedSsh(seed: SshCallerSeed, ids: string[], surface: SshPaneSurface): Promise<string[]> {
    const managed = await readManagedPanes(this.db, ids);
    if (managed.size === 0) return ids;
    const out: string[] = [];
    for (const id of ids) {
      if (!managed.has(id)) {
        out.push(id);
        continue;
      }
      try {
        await gatePaneSurfaceFor(this.db, seed, id, surface);
        out.push(id);
      } catch {
        // Refused (or the gate threw): absence is the answer, the same shape
        // a private foreign row has in this list.
      }
    }
    return out;
  }

  /**
   * A pane's own death report, from its tmux `pane-died` hook — on this host
   * or on any enrolled node, since both reach this plane the same way.
   *
   * Thin by design: the route has already established that this is the
   * subshell's own key, and the manager owns the one death transition the
   * sweep also runs through — so nothing here decides anything, it only
   * carries the timestamp.
   *
   * @param id - the subshell whose pane exited
   * @param exitCode - tmux's `#{pane_dead_status}`, null when it could not be read
   */
  async reportExit(id: string, exitCode: number | null): Promise<void> {
    await this.#manager.applySelfReportedExit(id, exitCode, new Date().toISOString());
  }

  /**
   * Screens for the subshells a viewer asked to see, filtered to those they
   * actually may (spec 2026-09-19 §4.4).
   *
   * The gate is the ordinary visible-set read, not a second predicate: an id
   * the viewer cannot see is simply absent from the answer, exactly as it is
   * absent from their list — never a 403, so ids cannot be probed.
   *
   * @param viewerId - the signed-in viewer asking
   * @param ids - subshell ids whose screens to capture
   */
  async previewsFor(viewerId: string, ids: string[], ssh?: SshCallerSeed): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const wanted = new Set(ids);
    const visible = (await this.repos.subshells.listVisibleTo(viewerId, isAdmin)).filter((row) => wanted.has(row.id));
    // The screen IS the pane's output: the dedicated captures door is its own
    // census surface (spec §2 lists captures beside list previews - the list
    // row rides `list_preview`, the captured lines ride `capture`, and D's
    // policy may admit one and refuse the other; captured lines are the most
    // sensitive bytes this app moves, and a managed pane's are additionally
    // blocked while a human holds control).
    const allowed = await this.#dropUngrantedSsh(
      ssh ?? { actor: "cookie", userId: viewerId, principal: `user:${viewerId}`, apiKeyId: null },
      visible.map((row) => row.id),
      "capture",
    );
    const keep = new Set(allowed);
    return await this.#manager.previewsFor(visible.filter((row) => keep.has(row.id)));
  }

  /**
   * One row as EVERY viewer sees it — the shared half of a broadcast frame
   * (spec 2026-09-19 §4.1a).
   *
   * Deliberately carries no `access`: the live fan-out publishes one payload
   * to a topic, so a per-viewer stamp cannot ride it, and a caller that let
   * `toViews`' owner-shaped default through would be telling a `view` grantee
   * they own the row. `shareExposure` IS included — those fields describe the
   * row rather than the reader.
   *
   * It goes through the SAME `toViews` + `shareExposure` composition
   * {@link listSubshells} uses, so a broadcast row and a snapshot row cannot
   * disagree about anything but access.
   *
   * @param rows - subshell rows to render, in order
   */
  async viewsForBroadcast(
    rows: SubshellTable[],
    shares?: Map<string, ShareEntry[]>,
  ): Promise<Omit<SubshellView, "access">[]> {
    // The caller usually has these already — the publisher reads them to
    // derive the recipient topics, one line before calling this — and reading
    // them twice per event is the one place this path did more work than the
    // design says it does.
    const sharesBy = shares ?? (await this.repos.subshellShares.listForSubshells(rows.map((r) => r.id)));
    // NO PREVIEWS, for two independent reasons. A broadcast reaches every
    // subscriber on a topic, so a pane's screen lines — the most sensitive
    // thing this app renders — must not ride one. And capturing here would
    // put a `capture-pane` spawn back on every event, which is the cost §4.4
    // removed: screens are PULLED by the cards that draw them.
    const views = await this.#manager.toViews(rows, { previews: false });
    return views.map(({ access: _access, ...view }) => ({
      ...view,
      ...shareExposure(sharesBy.get(view.id) ?? []),
    }));
  }

  /**
   * Waiting/running counts over the visible set (own + shared; all for an
   * admin) — the same subshells {@link listSubshells} returns, reduced to the
   * badge numbers for the native tab and push payloads. The blessed
   * `isNodeOffline` predicate is passed so a waiting subshell behind an
   * unreachable node does not count as waiting (F1); `running`/`total` are
   * unaffected.
   *
   * The SSH census (review I-1): the counts ride the SAME rows the list
   * returns, so the `list_preview` filter runs here too - a managed pane the
   * caller cannot preview is absent from the badge numbers exactly as it is
   * absent from their list. An admin's counts and a same-owner sibling's
   * bearer counts therefore never leak a managed row's existence through
   * arithmetic.
   * @param viewerId - The signed-in user whose visible set to count
   * @param seed - The caller's SSH seed (default: the viewer's own cookie arm)
   */
  async summarySubshells(
    viewerId: string,
    seed?: SshCallerSeed,
  ): Promise<{ total: number; running: number; waiting: number }> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const rows = await this.repos.subshells.listVisibleTo(viewerId, isAdmin);
    // Same single source as the list: one `listVisibleTo`, then the policy
    // filter, then the shared reduction (`summarizeSubshells` is the ONE
    // formula, imported rather than restated).
    const visible =
      rows.length > 0
        ? await this.#dropUngrantedSsh(
            seed ?? { actor: "cookie", userId: viewerId, principal: `user:${viewerId}`, apiKeyId: null },
            rows.map((r) => r.id),
            "list_preview",
          )
        : [];
    const keep = new Set(visible);
    return summarizeSubshells(
      rows.filter((r) => keep.has(r.id)),
      isNodeOffline,
    );
  }

  /**
   * Loads a subshell and enforces that `viewerId` holds at least `min` access,
   * the single policy point for every per-subshell route.
   *
   * A bearer (subshell-key) actor is treated as its owner and NOTHING more: the
   * admin boost and shared grants are switched off for it, so a machine token
   * can never act on a foreign or shared subshell — exactly the strictness the
   * pre-sharing owner check had. Absent/invisible → 404 (`not_found`, no
   * existence leak); visible-but-insufficient → 403.
   *
   * @returns the subshell row (caller uses `row.userId` as the owner when it
   *          hands off to the owner-keyed manager) and the resolved access
   */
  async #gate(
    viewerId: string,
    subshellId: string,
    min: Exclude<Access, "none">,
    actor: GuardActor,
  ): Promise<{ row: SubshellTable; access: Access }> {
    const { row, access } = await loadSubshellAccess(
      { subshells: this.repos.subshells, shares: this.repos.subshellShares, userMeta: this.repos.userMeta },
      viewerId,
      subshellId,
      { allowAdminAndShares: actor !== "subshell-key" },
    );
    if (!row || access === "none") throw new SubshellError("not_found", "Subshell not found");
    if (!accessAtLeast(access, min)) {
      throw new HttpError(403, "You do not have permission to do that with this subshell");
    }
    return { row, access };
  }

  /**
   * The ONE SSH branch every generic pane surface runs through (task-C brief
   * deliverable 3): consult the injected policy for `surface`, translate the
   * decision onto this service's own error classes, and hand back the pane's
   * managed facts (null = ordinary pane, caller continues on its untouched
   * path).
   *
   * The mapping keeps the house conventions exact: `not_found`/`gone` become
   * the same invisibility 404 an unshared row gets (a managed pane the policy
   * cannot authorize must be indistinguishable from one that does not exist -
   * the non-enumerating rule §2 states), every other refusal is the visible-
   * but-insufficient 403, carrying the named `SshPolicyCode` in metadata so
   * MCP prose and SPA copy map by equality. A refusal is never a placeholder
   * success: the placeholder policy denies everything until D installs the
   * real one, and managed panes themselves cannot exist until the create
   * route does.
   */
  async #sshGate(seed: SshCallerSeed, id: string, surface: SshPaneSurface): Promise<SshManagedPaneFacts | null> {
    try {
      return await gatePaneSurfaceFor(this.db, seed, id, surface);
    } catch (err) {
      if (err instanceof SshGateFailure) {
        if (err.reason === "not_found" || err.reason === "gone") {
          throw new SubshellError("not_found", "Subshell not found");
        }
        if (err.reason === "backend_unavailable") {
          throwApiError({ code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE, message: err.message, doNotLog: true });
        }
        throwApiError({
          code: BackendErrorCodes.SSH_ACCESS_DENIED,
          message: err.message,
          ...(err.policyCode ? { metadataSafe: { sshPolicyCode: err.policyCode } } : {}),
          doNotLog: true,
        });
      }
      throw err;
    }
  }

  /** The sharing refusal every v1 caller of a managed pane's shares routes gets. */
  async #sshSharingRefusedIfManaged(seed: SshCallerSeed, id: string): Promise<void> {
    // (review R4) The policy refuses sharing with an `SshGateFailure` that
    // carries no HTTP status; uncaught it reached the error handler as a 500.
    // Map it exactly like `#sshGate`: an invisibility refusal stays a 404 (a
    // foreign managed pane is indistinguishable from one that does not exist),
    // a backend-unavailable refusal is a 503, and any other refusal - which is
    // every OWNED managed pane, since v1 denies sharing categorically - is the
    // named sharing-unsupported 403. A stranger never reaches here (the shares
    // route's own ownership check 404s first); the owner always does.
    let facts: Awaited<ReturnType<typeof gateSharingFor>>;
    try {
      facts = await gateSharingFor(this.db, seed, id);
    } catch (err) {
      if (err instanceof SshGateFailure) {
        if (err.reason === "not_found" || err.reason === "gone") {
          throw new SubshellError("not_found", "Subshell not found");
        }
        if (err.reason === "backend_unavailable") {
          throwApiError({ code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE, message: err.message, doNotLog: true });
        }
        throwApiError({
          code: BackendErrorCodes.SSH_SHARING_UNSUPPORTED,
          message: "Managed SSH panes cannot be shared",
          ...(err.policyCode ? { metadataSafe: { sshPolicyCode: err.policyCode } } : {}),
          doNotLog: true,
        });
      }
      throw err;
    }
    // Belt AND braces: even if a future policy ever ALLOWED sharing, v1 refuses
    // it at the surface (spec §2). Today the policy arm denies first; this is
    // the second lock.
    if (facts) {
      throwApiError({
        code: BackendErrorCodes.SSH_SHARING_UNSUPPORTED,
        message: "Managed SSH panes cannot be shared",
        doNotLog: true,
      });
    }
  }

  /**
   * Opening the pane as its owner answers the unseen push (spec 2026-09-23):
   * the stored urgency clears, re-arming follow-ups until the next delivered
   * push. Only a cookie session whose user IS the row's owner — a shared
   * viewer saw a pane that was never theirs to be pushed about, and a
   * machine credential resolves as the owner but attended nothing.
   * Best-effort, like the attach twin in `ws/attach-resolve.ts`: an
   * uncleared urgency costs one extra push at most; a throwing clear (a real
   * SQLITE_BUSY in this repo) must not turn the owner's own read into a 500.
   */
  async #rememberSeen(actor: GuardActor, viewerId: string, row: SubshellTable): Promise<void> {
    if (actor !== "cookie" || viewerId !== row.userId || row.lastPushUrgency === null) return;
    try {
      await this.repos.subshells.update(row.id, { lastPushUrgency: null });
      publishLive({ kind: "subshell.changed", id: row.id });
    } catch (err) {
      logger.withError(err).warn(`unseen-push clear/announce failed for ${row.id} (escalation may double)`);
    }
  }

  /**
   * Gets a single subshell view for the viewer — their own or one shared to
   * them — stamped with the viewer's own `access`.
   *
   * The SSH `detail` census: a managed pane the policy cannot authorize 404s
   * here exactly like an unshared foreign row, before any of the row's fields
   * (or the unseen-push side effect) are touched.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 is impossible at `view` (visible ⇒ at least view).
   */
  async getSubshell(viewerId: string, id: string, seed: SshCallerSeed): Promise<SubshellView> {
    const { row, access } = await this.#gate(viewerId, id, "view", seed.actor);
    await this.#sshGate(seed, id, "detail");
    await this.#rememberSeen(seed.actor, viewerId, row);
    // Build the view under the OWNER's id (the manager is owner-keyed); the
    // caller never sees the owner id, only their resolved access level.
    const subshell = await this.#manager.getSubshell(row.userId, id);
    if (!subshell) throw new SubshellError("not_found", "Subshell not found");
    // One extra read on a single-row path: the gate resolves access without
    // handing back the grants it looked at, and the disclosure warning needs
    // the audience, not just the caller's own level.
    const shares = (await this.repos.subshellShares.listForSubshells([id])).get(id) ?? [];
    return { ...subshell, access: access === "none" ? "view" : access, ...shareExposure(shares) };
  }

  /**
   * Tail of the subshell's pane log (ANSI-stripped) — why a harness exited, if it did.
   *
   * Gated at `view`, the same level as GET /:id, so a stranger gets a 404 and
   * the log's contents never leak through timing or body differences. The SSH
   * `log` census adds the generation contract (spec §3's bounded-rotation
   * rule): a MANAGED pane's byte-cursor reads are namespaced by
   * `logGeneration` - the rotation/reset counter - and a cursor whose stamp
   * is missing or other than the pane's current one answers the explicit
   * `cursorExpired` result (with the current generation) rather than reading
   * fresh bytes at a dead offset. The pane's stamp is not a constant: the
   * node echoes its CURRENT rotation generation in every `log_read` answer,
   * the plane persists a higher one, and a cursor read whose echoed
   * generation differs from what the reader stamped is the same explicit
   * expiry (the rotation happened between reads, the bytes are not a
   * continuation). Tail reads (no cursor) need no stamp and
   * answer the current one; ordinary panes keep the existing contract
   * EXACTLY - same shape, same semantics, one added optional field they
   * never receive.
   * @param window - optional cursor (spec 2026-10-01 §3): `fromByte` resumes
   *         raw bytes from that offset instead of tailing; absent keeps the
   *         EOF-anchored tail and `nextByte` seeds the next read at EOF.
   * @param cursorGeneration - managed-pane cursor stamp (the `log_generation`
   *         query): must equal the pane's current generation or the read
   *         answers `cursorExpired`.
   * @throws SubshellError 404 when absent or invisible to the caller (the SSH
   *         policy refusing `log` answers the same 404, invisibility-first).
   * @throws ApiError 409 NODE_OFFLINE when the row's agent node has no live
   *         connection (spec §5.6, the create/restart mapping again — the UI
   *         polls this tail, so an offline node must answer 409, never a 500
   *         plus a server-error log line per poll).
   */
  async getSubshellLogTail(
    viewerId: string,
    id: string,
    seed: SshCallerSeed,
    window?: LogCursorRequest,
    cursorGeneration?: number,
  ): Promise<{
    lines: string[];
    truncated: boolean;
    nextByte: number;
    cursorExpired?: boolean;
    logGeneration?: number;
  }> {
    const { row } = await this.#gate(viewerId, id, "view", seed.actor);
    const managed = await this.#sshGate(seed, id, "log");
    await this.#rememberSeen(seed.actor, viewerId, row);
    // Spec §6.5: the read goes to the node that owns the pane — an agent-node
    // row answers through its RemoteLauncher (`log_read` window), whose offline
    // throw maps onto §5.6 exactly like create/restart. One composition
    // (readSubshellLogWindow) now serves tail and cursor for every launcher.
    if (managed) {
      // The generation check is a plane-side fact and it runs BEFORE the log
      // read: a stale cursor must never reach the disk or the node, which is
      // what makes "never silent reuse" true even when the file survived.
      if (window?.fromByte !== undefined && cursorGeneration !== managed.logGeneration) {
        return { lines: [], truncated: false, nextByte: 0, cursorExpired: true, logGeneration: managed.logGeneration };
      }
      const res = await readSubshellLogWindow(id, row.nodeId, window ?? {}).catch(rethrowLaunchRefusal);
      // The read's SECOND half: the node echoes its CURRENT terminal log
      // generation (rotated on its own schedule; the plane has no other
      // writer). A report above the persisted stamp persists first, and a
      // CURSOR read whose echoed generation is not what the reader stamped
      // answers the explicit expiry with the current value - the window read
      // happened across a rotation, its bytes are NOT the reader's continuation.
      const { logGeneration: reported, ...view } = res;
      let current = managed.logGeneration;
      if (reported !== undefined && reported > current) {
        await this.#sshPanes.bumpLogGeneration(id, reported);
        current = reported;
      }
      if (window?.fromByte !== undefined && reported !== undefined && reported !== cursorGeneration) {
        return { lines: [], truncated: false, nextByte: 0, cursorExpired: true, logGeneration: current };
      }
      return { ...view, logGeneration: current };
    }
    // An ordinary pane never receives the generation fields - belt against a
    // node echoing one for a pane with no SSH terminal (there is nothing to
    // strip on the common path; a node CANNOT mint `cursorExpired` here).
    const { logGeneration: _reported, ...ordinary } = await readSubshellLogWindow(id, row.nodeId, window ?? {}).catch(
      rethrowLaunchRefusal,
    );
    return ordinary;
  }

  /**
   * Renames a subshell (which also locks the name against the pane-title
   * sweep) — an `edit` act. Validation (non-blank, length) is the route's job.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async renameSubshell(viewerId: string, id: string, name: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const ok = await this.#manager.updateName(row.userId, id, name);
    if (!ok) throw new SubshellError("not_found", "Subshell not found");
    return { ok: true };
  }

  /**
   * Types text into a RUNNING pane over REST (spec 2026-09-25 MCP DX), the
   * input the live attach socket already carries, given an HTTP door for
   * machine callers. Gated at `edit`, the level the posture assigns to
   * terminal input (`view` 403s, a foreign row 404s, and a bearer pane key
   * acts through its OWNER with boost and shares off, exactly like restart).
   *
   * "The same seam as the attach path" means: the ONE `NodeLauncher.sendInput`
   * member, resolved per row via `launcherFor(row.nodeId)`: locally a
   * `tmux send-keys -l --` on the row's socket, remotely the agent's `input`
   * command, byte for byte. The bytes are never translated, matching the dumb
   * pipe the WS keystrokes flow through. `submit` appends Enter as a literal
   * CR, the exact byte the browser terminal sends when a human presses it on
   * that path; `deliverPrompt`'s `pressEnter` is the same CR at the pane's
   * pty, but it is a `TmuxRunner` method with no `NodeLauncher` twin, so the
   * spelling both launches can carry is this one. The per-pane input chain (or
   * the agent's serialized dispatch) keeps text-before-Enter in order.
   *
   * Typed input transits argv (`send-keys -l -- <text>`, `/proc`-readable for
   * the spawn's life) exactly like every other send-keys path, keystrokes
   * included; that is the accepted posture (`docs/security.md` §11.2), not a
   * new exposure this route introduces.
   *
   * The one honest partial: a node that drops BETWEEN the text and the Enter
   * frame answers the offline 409 with the text already sitting at the prompt
   * unsubmitted. Half a pair landing beats reordering or duplicating it, and a
   * retry of the POST re-types rather than guesses (the WS path's own
   * at-least-once posture, stated in `ws/subshell-ws.ts`).
   *
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   * @throws ApiError 409 SUBSHELL_NOT_RUNNING when the row is not running OR
   *         its pane has exited (checked BEFORE the launcher is resolved:
   *         nothing is typed into a row that is not there), and 409
   *         NODE_OFFLINE when its agent node has no live connection (the
   *         create/restart mapper again).
   */
  async sendSubshellInput(
    viewerId: string,
    id: string,
    text: string,
    submit: boolean,
    seed: SshCallerSeed,
  ): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", seed.actor);
    // The SSH `input` census, run BEFORE the running check: an unauthorized
    // caller must not learn the managed pane's running state, and a
    // AUTHORIZED write to a managed pane leaves the ordinary launcher path
    // entirely - it goes to the SSH input seam, stamped with the pane's
    // CURRENT control generation (the frozen additive `inputGeneration`), so
    // the machine's mirror fences queued writes that a takeover already
    // invalidated. While the SSH backend's hooks are not registered the act
    // refuses outright (503): the plane never falls back to typing through a
    // connecting-node shell, which is the same no-fallback rule restart has.
    const managed = await this.#sshGate(seed, id, "input");
    if (managed) {
      const hooks = getSshPaneHooks();
      if (!hooks) {
        throwApiError({
          code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE,
          message: "The SSH backend needed for this pane action is not available",
          doNotLog: true,
        });
      }
      await hooks.sendManagedInput({ subshellId: id, text, submit, inputGeneration: managed.controlGeneration });
      return { ok: true };
    }
    // The TWO facts, both required — a lesson from the live incident
    // (2026-09-25): `status` is the lifecycle INTENT and a pane that exited
    // on its own parks at `status: "running"` with `alive: 0` (parked is what
    // auto-restart and "Start again" revive from), so a guard on `status`
    // alone types into a session that is already reaped — on a remote node
    // the send-keys failure is unmapped and answers 500, on a local one it
    // can even "succeed" into nothing. `alive` is the fact a send needs, the
    // same conjunction the manager's own reads use (`status !== "running" ||
    // alive !== 1`).
    if (row.status !== "running" || row.alive !== 1) {
      throwApiError({
        code: BackendErrorCodes.SUBSHELL_NOT_RUNNING,
        message: "The subshell is not running; nothing was typed. Restart it first.",
        doNotLog: true,
      });
    }
    // NO publishLive, deliberately: every other act here announces itself
    // because it CHANGES THE ROW, and this one writes nothing. The typed text
    // is the pane's own doing from that moment on; its consequences reach
    // viewers through the pane log and the live tail, not a dashboard re-read.
    const launcher = launcherFor(row.nodeId);
    const socket = row.tmuxSocket ?? tmuxSocketFor(id);
    await launcher.sendInput(socket, id, text).catch(rethrowLaunchRefusal);
    if (submit) await launcher.sendInput(socket, id, "\r").catch(rethrowLaunchRefusal);
    return { ok: true };
  }

  /**
   * Run ONE shell command in a TERMINAL pane and answer with its output and
   * exit code (spec 2026-10-02). Everything the pane cannot tell us is
   * machinery's job: the sentinel protocol lives in `pane-exec.ts`, the two
   * sends ride the SAME `sendInput` seam as every keystroke in this app (argv
   * posture included, accepted §11.2), and the wait reads through the
   * `readLogWindow` seam the cursor reads already use. Gates mirror
   * `sendSubshellInput` verbatim (edit grant, the two facts, the offline
   * mapper) and ADD two: a non-terminal harness is refused by name (an
   * agent pane would eat the line into its own input box), and one exec per
   * pane at a time (interleaved sentinels corrupt each other). The quiet
   * check precedes EVERYTHING typed: a refusal never touches the pane, and
   * neither does a lease, timeout, or wait (ruling 2 - the command keeps
   * running; this call just stops watching). No publishLive, no audit row:
   * like input, the row never changed; the pane's own log records the typing.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   * @throws ApiError 409 SUBSHELL_NOT_RUNNING when the row is not running OR
   *         its pane has exited (the two facts, checked FIRST exactly as
   *         input does); 400 EXEC_TERMINAL_ONLY when the pane's harness is not
   *         a terminal; 409 EXEC_IN_FLIGHT when another exec already holds the
   *         pane's lease; 409 EXEC_PANE_BUSY when the quiet probe finds the
   *         log growing. All four refuse before anything is typed, and any
   *         launcher refusal maps through the create/restart mapper.
   */
  async execInTerminal(
    viewerId: string,
    id: string,
    command: string,
    timeoutMs: number | undefined,
    seed: SshCallerSeed,
  ): Promise<ExecAnswer> {
    const { row } = await this.#gate(viewerId, id, "edit", seed.actor);
    // The SSH census: `exec` on a managed pane is refused by the policy first
    // (invisibility before specificity), and the spec's own rule - "Do not
    // use this helper on managed SSH terminals" - then refuses even an
    // authorized caller. An ordinary pane (no row) continues untouched.
    if (await this.#sshGate(seed, id, "exec")) {
      throwApiError({
        code: BackendErrorCodes.EXEC_SSH_UNSUPPORTED,
        message: "exec does not run on managed SSH terminals; read the pane directly",
        doNotLog: true,
      });
    }
    // Restart-left-behind records first: an outstanding row of an older
    // incarnation is honest `unknown` NOW, before any new question is asked
    // of the pane (and before the after-unknown read below, so a restart
    // cannot read as a blocking unknown of the CURRENT incarnation).
    await reconcileStaleIncarnation(this.db, id, paneIncarnation(row));
    // After unknown, automated exec waits (spec §3); HUMAN-CLASS callers pass -
    // they are the recovery the rule waits for, and their next completed
    // record is what clears it. Human-class is cookie AND system key (M5,
    // coordinator ruling 2026-10-05): a system key resolves through the full
    // human gate as the `system` service user everywhere else in this tree,
    // and an operator driving recovery over a machine credential is the same
    // human act. Only a SUBSHELL key - the prompt-injectable automated actor
    // the rule was written against - is refused.
    if (seed.actor === "subshell-key" && (await hasBlockingUnknown(this.db, id, paneIncarnation(row)))) {
      refuseAfterUnknown();
    }
    if (row.status !== "running" || row.alive !== 1) {
      throwApiError({
        code: BackendErrorCodes.SUBSHELL_NOT_RUNNING,
        message: "The subshell is not running; nothing was typed. Restart it first.",
        doNotLog: true,
      });
    }
    const harness = getHarness(row.harnessId);
    if (harness?.type !== "terminal") {
      throwApiError({
        code: BackendErrorCodes.EXEC_TERMINAL_ONLY,
        // Two shapes under one code: a KNOWN non-terminal harness runs an
        // agent (its own input box would eat the line); an unresolvable id
        // names that instead, because "this pane runs a harness" would be a
        // sentence about a harness nobody can look up (PR #319 review).
        message: harness
          ? "exec types shell commands into terminal panes; this pane runs a harness"
          : "exec types shell commands into terminal panes; this pane's harness is not installed",
        doNotLog: true,
      });
    }
    // The reservation is taken SYNCHRONOUSLY here (nothing between the check
    // and the claim awaits), so two racing calls never both proceed. It now
    // outlives the caller's wait when that wait times out: `#execInner` hands
    // it to the observation, and the pane releases when the late marker, the
    // watcher's budget, or the pane's own end settles the record.
    if (!tryHoldPane(id)) {
      throwApiError({
        code: BackendErrorCodes.EXEC_IN_FLIGHT,
        message: "Another exec is already waiting on this pane; retry once it finishes",
        doNotLog: true,
      });
    }
    let answer: ExecAnswer & { observation?: Promise<void> };
    try {
      answer = await this.#execInner(row, id, command, execTimeoutMs(timeoutMs), seed);
    } catch (err) {
      releasePane(id);
      throw err;
    }
    if (answer.observation) {
      releasePane(id, answer.observation);
    } else {
      releasePane(id);
    }
    const { observation: _observation, ...publicAnswer } = answer;
    return publicAnswer;
  }

  async #execInner(
    row: SubshellTable,
    id: string,
    command: string,
    timeoutMs: number,
    seed: SshCallerSeed,
  ): Promise<ExecAnswer & { observation?: Promise<void> }> {
    const launcher = launcherFor(row.nodeId);
    const socket = row.tmuxSocket ?? tmuxSocketFor(id);
    const read: LogWindowReader = (fromByte, maxBytes) =>
      launcher.readLogWindow(id, fromByte, maxBytes).catch(rethrowLaunchRefusal);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const quiet = await probeQuiet(read, sleep);
    if (!quiet.quiet) {
      throwApiError({
        code: BackendErrorCodes.EXEC_PANE_BUSY,
        message: "The pane is producing output; nothing was typed. Read it or wait, then retry.",
        doNotLog: true,
      });
    }
    // The token is production's own, always (review choice 2026-10-02): the
    // suites drive a scripted node whose `log_read` answer is drawn from the
    // sentinel frame it actually received, so completion proves scanner and
    // frame agree without a test seam in the signature.
    const token = execSentinelToken();
    const execId = crypto.randomUUID();
    // The record exists BEFORE the typing: a caller that dies mid-typing or
    // mid-wait still left a durable receipt, and the status door can ask
    // what happened. `inputGeneration` is 1 for ordinary panes (the fence is
    // the managed pane's counter; ordinary panes have exactly one). A
    // subshell-key actor is the agent side of `initiated_by` (the record
    // names WHO typed); the api-key row it typed with rides beside it. A
    // system key is a human-class credential (it acts through the human gate,
    // owns nothing, and is never an agent pane), so it stamps `human`.
    const initiatedBy: SshActorSide = seed.actor === "subshell-key" ? "agent" : "human";
    await insertExec(
      this.db,
      {
        id: execId,
        subshellId: id,
        paneIncarnation: paneIncarnation(row),
        initiatedBy,
        grantId: null,
        apiKeyId: seed.apiKeyId,
        inputGeneration: 1,
        markerToken: token,
        state: "outstanding",
      },
      quiet.size,
    );
    for (const text of [command, "\r", execSentinelCommand(token), "\r"]) {
      await launcher.sendInput(socket, id, text).catch(rethrowLaunchRefusal);
    }
    const waited = await waitSentinel(read, token, quiet.size, {
      timeoutMs,
      sleep,
      now: Date.now,
      alive: async () => {
        const fresh = await this.repos.subshells.findById(id);
        return fresh?.status === "running" && fresh?.alive === 1;
      },
    });
    const tail = execOutputTail(waited.outputLines, EXEC_MAX_OUTPUT_BYTES);
    if (waited.status === "completed") {
      await completeExec(
        this.db,
        execId,
        waited.rc ?? 0,
        tail.text === "" ? null : tail.text,
        tail.truncated,
        waited.nextByte,
      );
      return {
        status: "completed",
        exitCode: waited.rc,
        output: tail.text,
        truncated: tail.truncated,
        nextByte: waited.nextByte,
        executionId: execId,
      };
    }
    // timed_out: the REPORT-ONLY rule stands (no automatic Ctrl-C, ruling 2),
    // and the record stays `outstanding` with the pane's reservation handed to
    // a bounded watcher. A LATE marker completes it; pane death or the budget
    // ends it as `unknown`.
    const observation = observeExecToResolution(
      this.db,
      {
        id: execId,
        subshellId: id,
        markerToken: token,
        startByte: waited.nextByte,
        priorLines: waited.outputLines,
      },
      { read, isPaneCurrent: () => this.#paneIncarnationCurrent(id, paneIncarnation(row)) },
    );
    return {
      status: "timed_out",
      exitCode: null,
      output: tail.text,
      truncated: tail.truncated,
      nextByte: waited.nextByte,
      executionId: execId,
      observation,
    };
  }

  /** The restart-death test the observer runs each poll: same live incarnation. */
  async #paneIncarnationCurrent(id: string, incarnation: string): Promise<boolean> {
    const fresh = await this.repos.subshells.findById(id);
    return fresh?.status === "running" && fresh?.alive === 1 && fresh.startedAt === incarnation;
  }

  /**
   * Rings or mutes a subshell's notifications (the ⋯-menu bell) — OWNER-only
   * (it changes what leaves the instance for the owner's devices). Muting stops
   * pushes only; the waiting stamp is deliberately untouched.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner.
   */
  async setSubshellNotify(viewerId: string, id: string, notify: boolean, actor: GuardActor): Promise<{ ok: true }> {
    await this.#gate(viewerId, id, "owner", actor);
    await this.repos.subshells.update(id, { notify: notify ? 1 : 0 });
    publishLive({ kind: "subshell.changed", id });
    return { ok: true };
  }

  /** The current grants on a subshell, with grantee names resolved for display. */
  async #shareViews(subshellId: string): Promise<SubshellShareView[]> {
    const rows = await this.repos.subshellShares.listForSubshell(subshellId);
    const named = rows.map((r) => r.granteeUserId).filter((x): x is string => x !== null);
    const names = await this.repos.users.displayNamesByIds(named);
    return rows.map((r) => ({
      id: r.id,
      granteeUserId: r.granteeUserId,
      granteeName: r.granteeUserId === null ? "Everyone" : (names.get(r.granteeUserId) ?? r.granteeUserId),
      permission: r.permission,
    }));
  }

  /**
   * Lists a subshell's sharing grants — OWNER-only (managing who can see a
   * subshell is the owner's act; an admin's effective `edit` does not extend here).
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner.
   */
  async getShares(viewerId: string, id: string, seed: SshCallerSeed): Promise<{ shares: SubshellShareView[] }> {
    await this.#gate(viewerId, id, "owner", seed.actor);
    // v1 refuses sharing managed SSH panes to EVERYONE - the reader included.
    // A managed pane can never carry shares (writes are refused, and it is
    // created without any), so "an empty list" and "refused" describe the
    // same fact; the refusal states it, per "Sharing SSH panes is refused in
    // v1, to anyone, always".
    await this.#sshSharingRefusedIfManaged(seed, id);
    return { shares: await this.#shareViews(id) };
  }

  /**
   * Replaces a subshell's whole grant set — OWNER-only. Each non-null grantee
   * must be an existing user (else 400); a null/absent grantee is the Everyone
   * grant. Returns the resulting set (with names). The creator recorded on each
   * row is the acting owner.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner; 400 on an unknown grantee.
   */
  async setShares(
    viewerId: string,
    id: string,
    entries: ShareEntry[],
    seed: SshCallerSeed,
  ): Promise<{ shares: SubshellShareView[] }> {
    const { row } = await this.#gate(viewerId, id, "owner", seed.actor);
    // The sharing census, before anything is written: v1 refuses managed
    // SSH panes unconditionally (owner, `view`, every actor - see
    // {@link #sshSharingRefusedIfManaged} for why both the policy arm and
    // this site enforce it).
    await this.#sshSharingRefusedIfManaged(seed, id);
    // Read BEFORE the replace: these are the grants that decide who currently
    // receives this row, and after the write nothing can recover them.
    const before = (await this.repos.subshellShares.listForSubshells([id])).get(id) ?? [];
    const named = entries.map((e) => e.granteeUserId).filter((x): x is string => x !== null);
    if (named.length > 0) {
      const names = await this.repos.users.displayNamesByIds(named);
      const unknown = named.find((uid) => !names.has(uid));
      if (unknown) throw new HttpError(400, "Cannot share with an unknown user");
    }
    await this.repos.subshellShares.replaceForSubshell(id, entries, viewerId);
    // The BEFORE access rides the event: recipients computed after the write
    // reach everyone EXCEPT whoever just lost the row, so this is the only
    // thing that can tell a revoked grantee (spec §4.2). Deriving which topics
    // that means stays in the publisher — the service carries domain facts.
    publishLive({ kind: "subshell.shares-changed", id, before: { ownerUserId: row.userId, shares: before } });
    return { shares: await this.#shareViews(id) };
  }

  /**
   * A harness reports on itself (hook delivery): `turn_complete` /
   * `needs_attention` SET the waiting stamp and ring (the bell gate lives
   * inside notifySubshell, so this path is unconditional here); `resumed`
   * CLEARS the stamp without ringing, and is the only clear that reaches an
   * agent-node pane — see the branch below.
   *
   * A DEAD row silently drops every kind: a hook POST in flight while the
   * pane dies arrives after the reconcile sweep cleared `waiting_since`, and
   * stamping then would resurrect a false "waiting for you" chip on a dead
   * (possibly auto-restarting, same-id) row. The caller still sees 200 —
   * hooks are fire-and-forget, and a 4xx there buys nothing.
   */
  async recordAttention(id: string, kind: AttentionKind): Promise<void> {
    const row = await this.repos.subshells.findById(id);
    if (row?.alive !== 1) return;
    if (kind === "resumed") {
      // The hook-side CLEAR (2026-09-24). The idle-watcher clear works only
      // where the plane can STAT the pane log — `local` panes — so an
      // agent-node pane stayed "waiting for you" for its entire next turn:
      // its Stop/Notification stamps arrive from the node, but the watcher
      // skips the row (`stat` of a file that only exists on the node's disk
      // → null → nothing to measure) and no other alive-path cleared it.
      // The pane itself knows work resumed (a prompt was submitted, a tool
      // is starting after its approval); that fact has to travel.
      //
      // Never rings: resuming is not an event. The read above is the cheap
      // gate for the common case (PreToolUse reports EVERY tool call); the
      // conditional write is what makes "publish only when it actually moved"
      // true against a concurrent approval-stamp rather than only against the
      // snapshot this call read.
      if (row.waitingSince === null) return;
      const cleared = await this.repos.subshells.clearWaitingIfSet(id);
      if (cleared > 0) publishLive({ kind: "subshell.changed", id });
      return;
    }
    await this.repos.subshells.update(id, { waitingSince: new Date().toISOString() });
    publishLive({ kind: "subshell.changed", id });
    await getNotifyService().notifySubshell(id, kind);
  }

  /**
   * A harness re-pins its conversation identity (SessionStart hook). The
   * launch-time pin goes stale whenever the pane switches conversation
   * in-pane (/clear, /resume <other>, /fork) — without this write the next
   * restart resumes the ORIGINAL launch conversation instead of the current
   * one. Unlike attention, a row that is alive=0 but still `running` (just
   * died mid-transition, auto-restart pending) is a valuable report: the
   * next respawn should continue the CURRENT transcript. Terminated/deleted
   * rows silently drop it — the operator retired that lineage.
   * The caller still sees 200: hooks are fire-and-forget.
   */
  async recordHarnessSession(id: string, sessionId: string): Promise<void> {
    const row = await this.repos.subshells.findById(id);
    if (row?.status !== "running" || row.harnessSessionId === sessionId) return;
    // Known benign race (review 2026-09-04): a report in flight during a
    // restart can land after the respawn planned on the older pin, or the
    // respawn's own write can clobber a just-landed report — a last-write
    // no CAS. Both ids are always REAL transcripts of this user's, and the
    // live pane's next SessionStart report reconverges the row. A CAS on
    // harnessSessionId would close the window for a write that is self-
    // healing within one transition; deliberately not worth it here.
    await this.repos.subshells.update(id, { harnessSessionId: sessionId });
    publishLive({ kind: "subshell.changed", id });
  }

  /**
   * Revives a subshell IN PLACE (same id, same row): the manager kills the
   * pane and re-runs the auto-restart's guarded respawn on this row,
   * resuming the harness conversation when its transcript survived.
   * Deliberately does NOT re-check harness usability — the gate lives on
   * creation and the auto path; a subshell whose harness was disabled later
   * can still be restarted.
   * A refusal at the gate, in validation, at maintenance or by the offline
   * pre-gate writes nothing; a revive that fails after the swap leaves the
   * row dead keeping the chosen preset (the next Start again uses it).
   * @throws SubshellError 404 when absent/invisible to the caller, or when a
   *         terminate/delete won the restart race (converge on "gone").
   * @throws HttpError 403 when the caller holds only `view`.
   * @throws ApiError 409 NODE_OFFLINE when the row's agent node has no live
   *         connection (spec §5.6) — a swap-carrying restart is refused here
   *         before the manager is entered; a plain restart of an alive row
   *         dies on the manager's kill, which has already rolled the parked
   *         row back and retired the token before this boundary.
   * @throws ApiError 400 INVALID_PRESET when the swap preset is unknown, not
   *         the caller's, or from another harness (spec 2026-09-23 §2).
   * @throws ApiError 409 RESTART_IN_FLIGHT when a swap-carrying restart finds
   *         the id's in-flight lease held: the running revival composes the
   *         first caller's preset, so this one is refused rather than joined
   *         into a 200 that would promise a swap that never lands.
   * @param swapPresetTo - the optional preset swap riding this restart
   *         (spec 2026-09-23): `null` = swap to presetless, `undefined` = no
   *         swap. Validated here, written by the manager at the swap point.
   * @param prompt - optional task text (spec 2026-09-25): typed into the
   *         revived pane through the SAME settle seam create uses, after a
   *         SUCCESSFUL revive only. A refusal at any point above types
   *         nothing; a pane that never settles answers false and is kept.
   */
  async restartSubshell(
    viewerId: string,
    id: string,
    seed: SshCallerSeed,
    swapPresetTo?: string | null,
    prompt?: string,
  ): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const { row } = await this.#gate(viewerId, id, "edit", seed.actor);
    // The SSH `restart` census: policy re-asked FIRST (a restart of a managed
    // pane IS a fresh authorization recheck, spec §3 - the decision is not
    // carried over from whatever opened the pane), and the managed path then
    // goes to the SSH re-launch seam. The generic manager revive is NOT
    // reached: a managed pane's foreground process is ssh, and reviving it
    // through the local launcher would start a connecting-node shell where
    // its exit was supposed to end the pane - the fallback the spec forbids.
    // While the SSH backend's hooks are unregistered the act refuses (503);
    // a refusal types nothing and swaps nothing, exactly like every other
    // gate above the manager.
    const managed = await this.#sshGate(seed, id, "restart");
    // The instance gates are asked ONCE, for both paths: lockdown and the
    // machine's maintenance/off-switch are not bypassed by a managed restart
    // (a relaunch IS a launch, and a managed SSH terminal is a new SSH
    // session onto its node), while the swap validation below stays
    // ordinary-path-only.
    //
    // Lockdown is instance-wide, so it is asked before anything machine-shaped
    // is read. It names no machine, per the restart path's own rule (the row's
    // owner is the only guaranteed viewer of this refusal). And a stopped row's
    // auto-restart hook cannot work around it: the terminate revoked its token,
    // exactly as under maintenance.
    if (await lockdownEnabled(this.db)) {
      throw new SubshellCreateError(
        "lockdown",
        "This instance is in lockdown mode, so subshells cannot be restarted. Ask an admin to end it.",
        403,
      );
    }
    // A restart IS a launch, and this path never touches `resolveLaunchNode`
    // — the node was decided when the subshell was created. So the
    // maintenance gate is asserted here, or "restart" would be the one way to
    // start a pane on a machine that is refusing them. On an AGENT node the
    // node's own fail-closed file would refuse it a second time; on `local`
    // there is no agent and no file, so THIS is the only gate that exists.
    const node = await this.repos.nodes.findById(row.nodeId);
    if (node?.maintenance === 1) {
      throwApiError({
        code: BackendErrorCodes.NODE_IN_MAINTENANCE,
        message: MAINTENANCE_REFUSAL,
        doNotLog: true,
      });
    }
    // Same reasoning as the maintenance check one line above: the host
    // switched off as a launch target must refuse a restart too, or restart
    // is the one way onto it. The message names NO machine — the restart
    // path's own rule (an edit grantee on a shared subshell may not be able
    // to see the node; the named variant lives behind the visibility 404 in
    // `resolveLaunchNode`).
    if (node?.kind === "local" && !(await serverSubshellsEnabled(this.db))) {
      throw new SubshellCreateError(
        "node_launch_disabled",
        "Launching subshells on this machine is switched off in the server settings. Ask an admin to turn it back on.",
        403,
      );
    }
    if (managed) {
      // The restart PROMPT is its own census surface (spec §2 lists prompt
      // injection separately from restart): a caller allowed to relaunch the
      // pane may still be refused the injection into it, and the refusal
      // precedes ANY effect, relaunch included (review I-4).
      if (prompt?.trim()) {
        await this.#sshGate(seed, id, "prompt");
      }
      const hooks = getSshPaneHooks();
      if (!hooks) {
        throwApiError({
          code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE,
          message: "The SSH backend needed for this pane action is not available",
          doNotLog: true,
        });
      }
      // A preset swap has no meaning on a managed pane (its argv was built
      // from the connection snapshot; there is no preset under it).
      if (swapPresetTo !== undefined) {
        throwApiError({
          code: BackendErrorCodes.BAD_REQUEST,
          message: "A managed SSH terminal restarts as the same SSH session; there is no preset to swap",
          doNotLog: true,
        });
      }
      const relaunched = await hooks.restartManagedPane({ subshellId: id });
      // The old incarnation's records go `unknown` NOW (the observation loop's
      // own incarnation check would reach the same verdict on its next poll;
      // this makes the status door honest immediately).
      await reconcileStaleIncarnation(this.db, id, paneIncarnation(row));
      await cancelObservation(this.db, id);
      let promptDelivered = false;
      const trimmed = prompt?.trim();
      if (trimmed) {
        // The restart prompt is an input write like any other: it rides the
        // SSH input seam at the CURRENT generation, so a takeover between the
        // relaunch and the typing fences it at the machine (spec §3:
        // "Enforce input ownership across every write path, including restart
        // prompts").
        const after = await readManagedPane(this.db, id);
        await hooks.sendManagedInput({
          subshellId: id,
          text: trimmed,
          submit: true,
          inputGeneration: after?.controlGeneration ?? managed.controlGeneration,
        });
        promptDelivered = true;
      }
      return { id, tmuxSocket: relaunched.tmuxSocket, promptDelivered };
    }
    // The swap is validated HERE — after the gate and the maintenance 409,
    // before the manager touches anything — so a restart refused on this
    // side of the manager never changes the preset (spec 2026-09-23 §2). The
    // preset must be the CALLER's (the
    // same per-user rule create enforces): a pane-token actor resolves through
    // the guard as its row's owner, so its swap lands on the owner's presets;
    // the system service user owns nothing and holds no grants, so the edit
    // gate above refuses it before this validation. And one of this row's
    // harness: a harness switch on a live row would silently resume another
    // agent's transcript in a different CLI.
    if (swapPresetTo !== undefined && swapPresetTo !== null) {
      const preset = await this.repos.presets.findById(swapPresetTo);
      if (!preset || preset.userId !== viewerId || preset.harnessId !== row.harnessId) {
        throwApiError({
          code: BackendErrorCodes.INVALID_PRESET,
          message: "The preset must exist, belong to you, and match the subshell's harness",
          doNotLog: true,
        });
      }
    }
    // The offline pre-gate for a swap-carrying restart (final review 2026-09-24).
    // The manager's kill only protects an ALIVE row: a dead row skips the kill,
    // the swap write lands, and `#reviveRow`'s first node RPC is what throws
    // offline — a 409 answering for a restart whose preset already moved.
    // Refuse the swap HERE, before the manager can write anything. A plain
    // (no-swap) restart keeps its byte-identical path — for it the 409 from
    // the manager is honest because nothing was written. Local is answered
    // false by design (`isNodeOffline`), and the alive row's kill still
    // orders the local path's own failures; a dangling nodeId — the node row
    // force-deleted under this one — refuses too, exactly as an offline one
    // does.
    if (swapPresetTo !== undefined && isNodeOffline(row.nodeId)) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "The subshell's node has no live connection; it may still be running the subshell there",
        doNotLog: true,
      });
    }
    const revived = await this.#manager
      .restartSubshell(row.userId, id, swapPresetTo, viewerId)
      .catch((err) => {
        // A swap that arrived mid-restart is REFUSED, not joined: the running
        // revival composes someone else's preset, and a 200 for this swap
        // would be the lie the final review named. Retry once it lands.
        if (err instanceof RestartInFlightSwapError) {
          throwApiError({
            code: BackendErrorCodes.RESTART_IN_FLIGHT,
            message: "Another restart for this subshell is already running; try the switch again once it finishes",
            doNotLog: true,
          });
        }
        throw err;
      })
      .catch(rethrowLaunchRefusal);
    if (!revived) {
      throw new SubshellError("not_found", "Subshell not found");
    }
    // The restart ended the incarnation any outstanding exec record belonged
    // to: reconcile the stale rows to `unknown` and stop their watcher NOW
    // (the loop's own incarnation check would reach the same verdict within
    // one poll; this makes the status door and the after-unknown rule honest
    // the moment the revive lands).
    {
      const fresh = await this.repos.subshells.findById(id);
      if (fresh) await reconcileStaleIncarnation(this.db, id, paneIncarnation(fresh));
      await cancelObservation(this.db, id);
    }
    // A prompt (when asked) rides the SUCCESSFUL revive, typed through the
    // same launcher seam and the same settle constants create uses (spec
    // 2026-09-25): `deliverPrompt` waits for the fresh pane to show output and
    // reports false rather than typing blind. It never throws on either
    // launcher (local catches its own input failures, the agent-side loop
    // answers `{ promptDelivered: false }`), so no mapper wraps it, and the
    // blank check mirrors create's `prompt?.trim()`. Every refusal above has
    // already returned; nothing is typed into a pane this call did not start.
    let promptDelivered = false;
    const trimmed = prompt?.trim();
    if (trimmed) {
      promptDelivered = await launcherFor(row.nodeId).deliverPrompt(
        revived.tmuxSocket,
        id,
        trimmed,
        PROMPT_SETTLE_TIMEOUT_MS,
        PROMPT_POLL_MS,
      );
    }
    return { id: revived.id, tmuxSocket: revived.tmuxSocket, promptDelivered };
  }

  /**
   * Terminates a subshell (kills the harness process tree) — an `edit` act. A
   * missing/invisible subshell is a 404 via the gate; a view-only grantee a 403.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async terminateSubshell(viewerId: string, id: string, seed: SshCallerSeed): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", seed.actor);
    // The SSH `terminate` census first (invisibility before anything else).
    // The EFFECT stays the ordinary one for managed panes too: terminate is
    // the tmux kill that ends the ssh foreground process - "its exit ends
    // the pane" is a statement about the pane, and killing it is the correct
    // act whether or not a policy allowed it beyond this point. The kill
    // ends the incarnation, so any observed exec record goes `unknown` via
    // the same reconcile the restart path runs (spec: terminating SSH never
    // guarantees remote descendants died - the record says unknown, not
    // completed).
    await this.#sshGate(seed, id, "terminate");
    await this.#manager.terminateSubshell(row.userId, id);
    // Observation is LOST the moment the pane dies: every outstanding record
    // on this pane becomes `unknown` (no marker can arrive for a dead shell),
    // and any running watcher's next poll finds the pane gone and releases
    // the reservation.
    await invalidateOutstandingExecs(this.db, id);
    await cancelObservation(this.db, id);
    return { ok: true };
  }

  /**
   * Resets this subshell's MCP token expiry.
   *
   * Only the subshell's own token (or its owner's cookie) may self-extend —
   * a subshell can never widen another's lifetime.
   * @throws SubshellError 404 when the subshell is absent or not the user's.
   * @throws HttpError 403 when a subshell key tries to extend another subshell.
   */
  async extendSubshellToken({
    userId,
    subshellId,
    actor,
    principal,
  }: {
    /** Owner resolved by the auth guard. */
    userId: string;
    /** Subshell whose token should be refreshed. */
    subshellId: string;
    /** How the request authenticated. */
    actor: GuardActor;
    /** Guard principal (`sess:<id>` for subshell keys, `user:<id>` otherwise). */
    principal: string;
  }): Promise<{ extended: boolean; ttlSeconds: number }> {
    const row = await this.repos.subshells.findById(subshellId);
    if (!row || row.userId !== userId) {
      throw new SubshellError("not_found", "Subshell not found");
    }
    if (actor === "subshell-key" && principal !== `sess:${subshellId}`) {
      throw new HttpError(403, "A subshell token may only extend its own lifetime");
    }
    const extended = await extendSubshellToken(subshellId);
    return { extended, ttlSeconds: subshellTokenTtlSeconds() };
  }

  /**
   * Deletes a subshell (terminates first if running) — OWNER-only.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner (view/edit included).
   */
  async deleteSubshell(viewerId: string, id: string, seed: SshCallerSeed): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "owner", seed.actor);
    // The SSH `delete` census: a managed pane is INVISIBLE (404) to any
    // caller the policy refuses, owner included until the policy's owner arm
    // allows it. The `ssh_panes` row cascades with the subshell (0048), so
    // the managed marker cannot outlive the pane it describes.
    await this.#sshGate(seed, id, "delete");
    // Release any running watcher before the cascade takes its rows (the loop
    // tolerates the rows vanishing under it, but the pane reservation should
    // end with the pane, not one poll later).
    await cancelObservation(this.db, id);
    // READ BEFORE THE DELETE: grants cascade with the row, and they are the
    // only way to reach the people it was shared with. Announced from HERE
    // rather than from the manager for the same reason — the manager is
    // owner-keyed and holds no shares repository, so a deletion announced
    // there could only ever name the owner and the admins, which is exactly
    // the bug: a shared subshell stayed on every grantee's dashboard until
    // they reconnected, and 404'd when clicked.
    const shares = (await this.repos.subshellShares.listForSubshells([id])).get(id) ?? [];
    const ok = await this.#manager.deleteSubshell(row.userId, id);
    if (!ok) {
      throw new SubshellError("not_found", "Subshell not found");
    }
    publishLive({ kind: "subshell.deleted", id, ownerId: row.userId, shares });
    return { ok: true };
  }

  /**
   * Read one terminal-exec record back - the read-only `get_terminal_execution`
   * door (spec §3: "execution IDs, persistent outstanding state, and a
   * read-only status operation"). A status read that changes NOTHING about the
   * command, with one deliberate exception: an `outstanding` record in the
   * pane's current incarnation with no observation running (the server
   * restarted, or nobody re-armed it) gets its bounded watcher re-armed by
   * this read, so a late marker still lands on the row a caller is polling.
   *
   * Gates: the pane's ordinary `view` access, then the SSH `exec` census (a
   * managed pane never earns records - exec refuses there - so this is the
   * 404-for-invisibility posture only). An id from another pane 404s: the
   * recovery handle only ever recovers YOUR pane's records.
   * @throws SubshellError 404 for an absent pane, an invisible pane, or an id
   *         that is not this pane's record.
   */
  async getTerminalExecution(
    viewerId: string,
    id: string,
    execId: string,
    seed: SshCallerSeed,
  ): Promise<SshTerminalExecView> {
    const { row } = await this.#gate(viewerId, id, "view", seed.actor);
    if (await this.#sshGate(seed, id, "exec")) {
      // A managed pane answers not_found for records it can never own (exec
      // never ran there) - indistinguishable from any other miss.
      throw new SubshellError("not_found", "Execution not found");
    }
    await reconcileStaleIncarnation(this.db, id, paneIncarnation(row));
    const exec = await loadExec(this.db, execId);
    if (!exec || exec.subshellId !== id) {
      throw new SubshellError("not_found", "Execution not found");
    }
    if (exec.state === "outstanding" && !observationActive(execId) && !paneHeld(id)) {
      this.#ensureObservation(exec, row);
    }
    return toExecView(exec);
  }

  /**
   * Arm (or join) the bounded observation for an outstanding record that has
   * no watcher. Fire-and-forget: the read answers with the row's facts the
   * instant it read them; the watcher's work lands on the row, never in this
   * response. The pane reservation is taken here so no exec can start on a
   * pane whose marker is being caught.
   */
  #ensureObservation(exec: SshTerminalExecTable, row: SubshellTable): void {
    if (!tryHoldPane(exec.subshellId)) return; // someone else's wait/watch already owns the pane
    const launcher = launcherFor(row.nodeId);
    const read: LogWindowReader = (fromByte, maxBytes) =>
      launcher.readLogWindow(exec.subshellId, fromByte, maxBytes).catch(rethrowLaunchRefusal);
    const observation = observeExecToResolution(
      this.db,
      {
        id: exec.id,
        subshellId: exec.subshellId,
        markerToken: exec.markerToken,
        // Resume exactly where the lost loop stopped; null (never advanced)
        // means nothing was consumed, so nothing to resume from.
        startByte: exec.nextByte ?? 0,
        priorLines: [],
      },
      { read, isPaneCurrent: () => this.#paneIncarnationCurrent(exec.subshellId, exec.paneIncarnation) },
    );
    releasePane(exec.subshellId, observation);
  }

  /**
   * The human takeover / return act (`POST /:id/ssh-control`, the frozen
   * `SshPaneControlRequest`/`SshControlView` pair): a cookie-session human
   * moves a MANAGED pane's input control, the SERVER raises the generation
   * (never the caller's to choose), and the machine is fenced FIRST - the
   * node mirror moves with the plane's claim or the act does not land.
   *
   * What a takeover does, in one act: raise the generation (queued stale
   * input is refused at the machine from that moment), move control state
   * (`human` blocks agent reads AND writes on every API/stream until a human
   * returns it), invalidate the pane's outstanding exec records (spec §3: "An
   * explicit human takeover invalidates the result"), and close the pane's
   * live terminal subscriptions (spec §2: streams close when control changes
   * - the attach-redeem gate is what re-admits each reconnect).
   *
   * A pane with no `ssh_panes` row 404s: takeover is a managed-pane act, and
   * making it answer for ordinary panes would be a second terminal-control
   * surface the spec does not have.
   * @throws SubshellError 404 when the pane is absent or unmanaged.
   * @throws ApiError 403 `SSH_ACCESS_DENIED` (policy), 503
   *         `SSH_BACKEND_UNAVAILABLE` (no SSH backend to fence the node), 403
   *         for any non-cookie actor (`cookie_required`).
   */
  async takeSshControl(
    _viewerId: string,
    id: string,
    mode: SshActorSide,
    seed: SshCallerSeed,
  ): Promise<SshControlView> {
    // Cookie first, from the shape of the act itself (spec §2: control
    // changes require a cookie session; the policy arm says it again and D
    // owns the final answer - belt AND braces, never a fallback that types).
    if (seed.actor !== "cookie") {
      throwApiError({
        code: BackendErrorCodes.SSH_ACCESS_DENIED,
        message: "SSH input control changes require a cookie session",
        metadataSafe: { sshPolicyCode: "cookie_required" },
        doNotLog: true,
      });
    }
    const facts = await readManagedPane(this.db, id);
    if (!facts) throw new SubshellError("not_found", "Subshell not found");
    let state: { controlOwner: SshActorSide; controlGeneration: number };
    try {
      await gateHumanActFor(this.db, seed, mode === "human" ? "take_control" : "return_control", facts.connectionId);
      state = await transitionPaneControl(this.db, id, mode);
    } catch (err) {
      // Same mapping the pane-surface gate gives the policy's refusals: the
      // human-config arm refusing (a `forbidden` decision) and the transition
      // finding no SSH backend (a `backend_unavailable`) must answer with the
      // named codes, not escape as an unmapped 500.
      if (err instanceof SshGateFailure) {
        if (err.reason === "not_found" || err.reason === "gone") {
          throw new SubshellError("not_found", "Subshell not found");
        }
        if (err.reason === "backend_unavailable") {
          throwApiError({ code: BackendErrorCodes.SSH_BACKEND_UNAVAILABLE, message: err.message, doNotLog: true });
        }
        throwApiError({
          code: BackendErrorCodes.SSH_ACCESS_DENIED,
          message: err.message,
          ...(err.policyCode ? { metadataSafe: { sshPolicyCode: err.policyCode } } : {}),
          doNotLog: true,
        });
      }
      throw err;
    }
    // The record-side fence (outstanding execs on this pane go `unknown`) and
    // the stream-side fence (every attached terminal socket closes; the
    // reconnection is what re-runs the redeem gate against the new state).
    await invalidateOutstandingExecs(this.db, id);
    await cancelObservation(this.db, id);
    closeViewersForSubshell(id, mode === "human" ? "human took control" : "control returned to agent");
    // Announce so the dashboard re-derives the row for its audience (the
    // feed carries no control field yet - wave 2's SPA reads it through the
    // SSH views; the changed-event is what makes clients re-resolve visibility
    // while control holds).
    publishLive({ kind: "subshell.changed", id });
    return { subshellId: id, controlOwner: state.controlOwner, controlGeneration: state.controlGeneration };
  }
}

/**
 * Reduces a subshell's grant rows to the two facts the UI's disclosure warning
 * needs: how many grants exist, and whether one of them is the Everyone grant.
 *
 * The distinction matters for what the warning can honestly say. A list of
 * named grantees is a countable audience ("3 people can see this terminal");
 * the Everyone grant is not — it is every signed-in user, present and future,
 * which is a different sentence and a different risk.
 */
function shareExposure(shares: { granteeUserId: string | null }[]): {
  shareCount: number;
  sharedWithEveryone: boolean;
} {
  return {
    shareCount: shares.length,
    sharedWithEveryone: shares.some((share) => share.granteeUserId === null),
  };
}
