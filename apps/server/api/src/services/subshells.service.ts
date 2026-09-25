import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
// The attention kinds are imported from the reporter that SPEAKS them rather
// than restated here: the old local `Extract<NotifyKind, …>`, widened once to
// `NotifyKind | "resumed"`, admitted push kinds (`crashed`, `maintenance`, …)
// the endpoint takes from no one — only the route's schema was holding the
// line. `resumed` is deliberately NOT a `NotifyKind` in either file: resuming
// is a state change, nothing rings for it.
import type { AttentionKind } from "@internal/mcp-core";
import { allHarnesses, getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { NODE_RESULT_MAINTENANCE } from "@internal/subshell-protocol";
import type { GuardActor } from "@/api/auth-guard.js";
import { HttpError } from "@/api/auth-guard.js";
import { harnessUsable } from "@/api/harness-utils.js";
import type { ShareEntry } from "@/db/repositories/subshell-shares.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { loadNodeAccess, type NodeAccessDeps, nodeCanLaunch, nodeCanLaunchOn } from "@/lib/node-access.js";
import { type Access, accessAtLeast, loadSubshellAccess, resolveSubshellAccess } from "@/lib/subshell-access.js";
import { BaseService, type CommonServiceParams } from "@/services/base.service.js";
import { publishLive } from "@/services/live-bus.js";
import { lockdownEnabled } from "@/services/lockdown.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import { getLive, isNodeOffline } from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { isNodeOfflineError } from "@/services/nodes/remote-launcher.js";
import { getNotifyService } from "@/services/notify.service.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import {
  PROMPT_POLL_MS,
  PROMPT_SETTLE_TIMEOUT_MS,
  RestartInFlightSwapError,
  readSubshellLogTail,
  SubshellManagerService,
} from "@/services/subshell-manager.service.js";
import { extendSubshellToken, subshellTokenTtlSeconds } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";

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
 * The preset pin died with spec 2026-09-13 §2.3 — a preset never names a
 * node, so "where" is the body, then the host, then the lone online agent.
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

  constructor(params: CommonServiceParams) {
    super(params);
    this.#manager = new SubshellManagerService({
      subshells: params.repos.subshells,
      presets: params.repos.presets,
    });
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
    /** Absolute working directory. */
    workingDir: string;
    /** Optional subshell display name. */
    name?: string;
    /** Optional task text typed into the pane once the harness settles. */
    prompt?: string;
    /** Node to launch on (spec §6.6); omitted/`local` = control-plane host. */
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
    if (presetId) {
      const presetRow = await this.repos.presets.findById(presetId);
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
    if (!getHarness(harnessId)) {
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
    const { nodeId: resolvedNodeId } = await resolveLaunchNode(
      {
        userId,
        machineActor,
        requestedNodeId: nodeId,
        // Read per create, not cached: a PATCH flips it for the NEXT launch,
        // and the row read is a single indexed SELECT on the same DB this
        // request already hammers.
        serverAsNodeEnabled: await serverSubshellsEnabled(this.db),
      },
      { nodes: this.repos.nodes, shares: this.repos.nodeShares, userMeta: this.repos.userMeta },
    );
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
    // The manager already rolled the row + token back; a node that dropped
    // offline between resolution and launch answers with the same structured
    // 409 the restart boundary gives (§5.6) — everything else rethrows.
    const created = await this.#manager
      .createSubshell({
        userId,
        harnessId,
        presetId: presetId ?? null,
        workingDir,
        name,
        prompt,
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
    await this.repos.recentPaths.touch(userId, workingDir, name ?? null, resolvedNodeId).catch(() => {});
    // The MCP apiKey is returned by the manager for env injection only; it is
    // a secret issued once and NEVER echoed to the HTTP client.
    return { id: created.id, tmuxSocket: created.tmuxSocket, promptDelivered: created.promptDelivered };
  }

  /**
   * Lists every subshell the caller can SEE — their own plus those shared with
   * Everyone or with them by name (all for an admin) — as manager-reconciled
   * views carrying the caller's viewer-relative `access`. A private foreign
   * subshell is simply absent, never a 403.
   * @param viewerId - The signed-in user (resolved from cookie or subshell key)
   */
  async listSubshells(viewerId: string, opts: { previews?: boolean } = {}): Promise<SubshellView[]> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const rows = await this.repos.subshells.listVisibleTo(viewerId, isAdmin);
    const sharesBy = await this.repos.subshellShares.listForSubshells(rows.map((r) => r.id));
    // Resolve access per row (needs the owner id, which the view doesn't carry),
    // keyed by id so the view mapping stays a plain lookup. A visible row always
    // resolves to view/edit/owner; "none" is impossible here but the type
    // carries it, so the fallback names the weakest real access.
    const accessBy = new Map<string, Exclude<Access, "none">>();
    for (const row of rows) {
      const access = resolveSubshellAccess(viewerId, isAdmin, row.userId, sharesBy.get(row.id) ?? []);
      accessBy.set(row.id, access === "none" ? "view" : access);
    }
    const views = await this.#manager.toViews(rows, opts);
    return views.map((view) => ({
      ...view,
      access: accessBy.get(view.id) ?? ("view" as const),
      ...shareExposure(sharesBy.get(view.id) ?? []),
    }));
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
  async previewsFor(viewerId: string, ids: string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const wanted = new Set(ids);
    const visible = (await this.repos.subshells.listVisibleTo(viewerId, isAdmin)).filter((row) => wanted.has(row.id));
    return await this.#manager.previewsFor(visible);
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
   * @param viewerId - The signed-in user whose visible set to count
   */
  async summarySubshells(viewerId: string): Promise<{ total: number; running: number; waiting: number }> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    return await this.repos.subshells.countsVisibleTo(viewerId, isAdmin, isNodeOffline);
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
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws HttpError 403 is impossible at `view` (visible ⇒ at least view).
   */
  async getSubshell(viewerId: string, id: string, actor: GuardActor): Promise<SubshellView> {
    const { row, access } = await this.#gate(viewerId, id, "view", actor);
    await this.#rememberSeen(actor, viewerId, row);
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
   * the log's contents never leak through timing or body differences.
   * @throws SubshellError 404 when absent or invisible to the caller.
   * @throws ApiError 409 NODE_OFFLINE when the row's agent node has no live
   *         connection (spec §5.6, the create/restart mapping again — the UI
   *         polls this tail, so an offline node must answer 409, never a 500
   *         plus a server-error log line per poll).
   */
  async getSubshellLogTail(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const { row } = await this.#gate(viewerId, id, "view", actor);
    await this.#rememberSeen(actor, viewerId, row);
    // Spec §6.5: the tail reads from the node that owns the pane — an
    // agent-node row goes through its RemoteLauncher (`log_read` window),
    // whose offline throw maps onto §5.6 exactly like create/restart.
    return await readSubshellLogTail(id, row.nodeId).catch(rethrowLaunchRefusal);
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
    actor: GuardActor,
  ): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
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
  async getShares(viewerId: string, id: string, actor: GuardActor): Promise<{ shares: SubshellShareView[] }> {
    await this.#gate(viewerId, id, "owner", actor);
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
    actor: GuardActor,
  ): Promise<{ shares: SubshellShareView[] }> {
    const { row } = await this.#gate(viewerId, id, "owner", actor);
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
    actor: GuardActor,
    swapPresetTo?: string | null,
    prompt?: string,
  ): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
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
  async terminateSubshell(viewerId: string, id: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    await this.#manager.terminateSubshell(row.userId, id);
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
  async deleteSubshell(viewerId: string, id: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "owner", actor);
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
