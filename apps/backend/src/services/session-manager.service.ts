import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { stripAnsi } from "@internal/backend-errors";
import {
  ALL_HARNESSES,
  getHarness,
  type HarnessPlugin,
  type ProfileDefinition,
  type TmuxRunner,
  tmuxSocketFor,
} from "@internal/harnesses";
import { harnessUsable } from "@/api/harness-utils.js";
import type { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import type { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { SessionTable, SessionUpdate } from "@/db/types/sessions.db-types.js";
import type { Access } from "@/lib/session-access.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { registerSessionMcp, sessionMcpConfigPath, sessionMcpEnv } from "@/services/mcp-launch.js";
import { defaultLocalLauncher, LocalLauncher } from "@/services/nodes/local-launcher.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { sessionLogPath } from "@/services/nodes/session-paths.js";
import { getNotifyService, type NotifyKind } from "@/services/notify.service.js";
import { issueSessionToken, revokeSessionToken } from "@/services/session-tokens.js";
import { logger } from "@/utils/logger.js";

/** The session-token lifecycle operations the manager triggers. Injectable
 * for test isolation; defaults to the real better-auth-backed functions. */
export interface SessionTokenProvider {
  /** Mints the session's MCP API key; returns the plaintext (once). */
  issue(sessionId: string, userId: string): Promise<string>;
  /** Disables the session's token (no-op when absent). */
  revoke(sessionId: string): Promise<void>;
}

/** How long to wait for a fresh pane to show output before giving up typing. */
const PROMPT_SETTLE_TIMEOUT_MS = 15_000;
/** tmux's initial `pane_title` on an untouched pane is the host name. */
const HOST_NAME = hostname();
/** Poll interval while waiting for the pane to settle. */
const PROMPT_POLL_MS = 400;

const defaultTokens: SessionTokenProvider = {
  issue: issueSessionToken,
  revoke: revokeSessionToken,
};

/**
 * In-flight manual restarts, shared process-wide by SESSION ID.
 *
 * The HTTP request handler, the 60 s reconcile sweep (`index.ts`) and the
 * `mote mcp` server each build their OWN `SessionManagerService`, so a
 * per-instance map would be inert: two restart clicks (two tabs, list +
 * detail, web + MCP) would each spawn, and the sweep would see the parked row
 * and revoke the token the restart just minted. Living at module scope, every
 * instance JOINS the one in-flight revival, and `reconcileRows` skips any id
 * present here (its pane is deliberately absent mid-restart). The entry is
 * added synchronously before the first await and removed in `finally`.
 */
const restartInFlight = new Map<string, Promise<{ id: string; tmuxSocket: string } | null>>();

/** The app-wide push notifier, used when no sink is injected. */
const defaultNotify: (sessionId: string, kind: NotifyKind) => Promise<void> = async (id, kind) => {
  // Static import (module-level) — dynamic imports break `bun build --compile`.
  // The singleton resolves at CALL time, so suites that inject a spy never
  // construct the real notify service (and never load web-push).
  await getNotifyService().notifySession(id, kind);
};

/**
 * Orchestrates agent sessions: validate inputs, spawn a tmux-backed harness,
 * stream output to a per-session log file, and reconcile DB state with what
 * tmux reports.
 */
export class SessionManagerService {
  readonly #sessions: SessionsRepository;
  readonly #profiles: ProfilesRepository;
  readonly #launcher: NodeLauncher;
  readonly #audit: (event: AuditEventInput) => Promise<void>;
  readonly #tokens: SessionTokenProvider;
  readonly #notify: (sessionId: string, kind: NotifyKind) => Promise<void>;

  constructor({
    sessions,
    profiles,
    tmux,
    audit = defaultAudit,
    tokens = defaultTokens,
    notify = defaultNotify,
    launcher,
  }: {
    sessions: SessionsRepository;
    profiles: ProfilesRepository;
    /**
     * @deprecated test-compat shim — wrapped in a {@link LocalLauncher} when
     * no `launcher` is given, so MockTmux-style injection keeps working.
     */
    tmux?: TmuxRunner;
    /** Audit sink (default: the app-wide best-effort recorder). Injectable for test isolation. */
    audit?: (event: AuditEventInput) => Promise<void>;
    /** Session-token lifecycle (default: better-auth api-keys). Injectable for tests. */
    tokens?: SessionTokenProvider;
    /** Push sink fired on the alive→dead reconcile transition (default: the app-wide notify service). Injectable for test isolation. */
    notify?: (sessionId: string, kind: NotifyKind) => Promise<void>;
    /** Machine interface for this manager's sessions; phase 0: always LocalLauncher. */
    launcher?: NodeLauncher;
  }) {
    this.#sessions = sessions;
    this.#profiles = profiles;
    this.#launcher = launcher ?? new LocalLauncher({ tmux });
    this.#audit = audit;
    this.#tokens = tokens;
    this.#notify = notify;
  }

  /**
   * Decides the conversation identity for one launch (restart-resume).
   * Returns undefined when the harness has no resume story — then nothing
   * is pinned and every launch starts a fresh conversation, as before.
   *
   * `storedId` is what an earlier launch of this lineage pinned. It is only
   * trusted when the plugin confirms the transcript still exists
   * (`canResume`): a resumed-but-never-used launch never wrote one, and a
   * wiped harness state dir removed it — handing Claude a dead id prints
   * "No conversation found" and exits, killing the pane. When the stored id
   * cannot be resumed a FRESH id is allocated (never the old one: pinning
   * `--session-id` on an id that exists somewhere would fail the launch),
   * and the caller persists it on the row being launched.
   */
  async #planHarnessSession(
    harness: HarnessPlugin,
    storedId: string | null,
    cwd: string,
  ): Promise<{ id: string; mode: "start" | "resume" } | undefined> {
    if (!harness.resume) return undefined;
    if (storedId && (await this.#launcher.canResume(harness, storedId, cwd))) {
      return { id: storedId, mode: "resume" };
    }
    return { id: harness.resume.allocateSessionId(), mode: "start" };
  }

  /**
   * Creates a new session: validates the profile + working directory, records
   * the DB row, mints the session's MCP token, then spawns the harness under
   * tmux with a curated env (including the injected MOTE_* credentials). When
   * `prompt` is given, it is typed into the pane once the harness has settled.
   */
  async createSession({
    userId,
    profileId,
    workingDir,
    name,
    prompt,
    promptSettleTimeoutMs,
    promptPollMs,
    resumeFromId,
    notify,
  }: {
    userId: string;
    profileId: string;
    workingDir: string;
    name?: string;
    /** Optional task text typed into the pane after the harness settles. */
    prompt?: string;
    /** Settle-window overrides (tests; production uses the module defaults). */
    promptSettleTimeoutMs?: number;
    promptPollMs?: number;
    /**
     * Harness conversation id pinned by a predecessor session (restart
     * lineage). When the harness supports resume and the conversation still
     * exists, THIS session continues it instead of starting fresh.
     */
    resumeFromId?: string | null;
    /**
     * Ring the owner's devices for this session's attention events. Omitted
     * = the silent default; restart passes the source row's bell so operator
     * monitoring survives a restart.
     */
    notify?: boolean;
  }): Promise<{ id: string; tmuxSocket: string; apiKey: string; promptDelivered: boolean }> {
    const profileRow = await this.#profiles.findById(profileId);
    if (!profileRow || profileRow.userId !== userId) {
      throw new Error("Profile not found");
    }
    const harness = getHarness(profileRow.harnessId);
    if (!harness) {
      throw new Error(`Unknown harness: ${profileRow.harnessId}`);
    }

    const realPath = await this.#launcher.validateWorkingDir(workingDir);
    const profile = parseProfile(profileRow);
    const binary = await this.#launcher.resolveBinary(harness);
    if (!binary) {
      throw new Error(`Harness "${harness.name}" is not installed on this machine.`);
    }

    const id = crypto.randomUUID();
    const socket = tmuxSocketFor(id);
    const sessionName = name?.trim() || defaultSessionName();
    // Restart-resume plan: continue the predecessor's conversation when it
    // survived, else pin a fresh id this session will be resumed by later.
    const harnessSession = await this.#planHarnessSession(harness, resumeFromId ?? null, realPath);

    // Record intent in the DB first so the row exists even if tmux errors.
    // The profile's auto-restart policy is inherited at creation time.
    await this.#sessions.create({
      id,
      userId,
      profileId,
      harnessId: profileRow.harnessId,
      name: sessionName,
      workingDir: realPath,
      tmuxSocket: socket,
      // A fresh session shows as active until real output lands.
      lastOutputAt: new Date().toISOString(),
      alive: 1,
      startedAt: new Date().toISOString(),
      restartOnExit: profileRow.restartOnExit,
      harnessSessionId: harnessSession?.id ?? null,
      // Default-silent unless explicitly requested (restart inherits the bell).
      notify: notify ? 1 : 0,
    });

    // The token is minted AFTER the row exists (issueSessionToken writes the
    // api-key id back onto it) but BEFORE tmux starts, so the plaintext key is
    // baked into the harness env.
    const apiKey = await this.#tokens.issue(id, userId);

    // Register `mote mcp` with the harness, in whatever dialect the plugin
    // speaks: claude gets --mcp-config argv, opencode a merged config layer +
    // OPENCODE_CONFIG (baked below); harnesses without a per-session format
    // (hermes, pi) register nothing — their MOTE_* env still lands, and the
    // UI shows their one-time manual registration steps.
    const mcp = registerSessionMcp(harness, id);

    let promptDelivered = false;
    try {
      // Command assembly happens INSIDE launch, which runs inside this try:
      // a rejected env key throws there, and the row + token must roll back
      // like any other spawn failure below.
      await this.#launcher.launch({
        id,
        socket,
        harness,
        binary,
        cwd: realPath,
        profile,
        sessionName,
        moteEnv: sessionMcpEnv(apiKey, id, sessionName),
        mcp,
        harnessSession,
      });
      if (prompt?.trim()) {
        promptDelivered = await this.#deliverPrompt(
          socket,
          id,
          prompt.trim(),
          promptSettleTimeoutMs ?? PROMPT_SETTLE_TIMEOUT_MS,
          promptPollMs ?? PROMPT_POLL_MS,
        );
      }
    } catch (err) {
      // A throw AFTER a successful newSession (the strict pipe-pane path, or
      // anything else past the spawn) would otherwise orphan a live harness
      // under the terminated row: best-effort kill FIRST. killSession
      // swallows "already gone", and the try/catch keeps any other kill
      // failure from masking the original error or skipping the rollback.
      try {
        await this.#launcher.killSession(socket, id);
      } catch {
        // kill is best-effort; the row + token rollback below must still run
      }
      await this.#sessions.markTerminated(id, new Date().toISOString());
      await this.#revokeTokenOrUnlink(id);
      throw err;
    }

    logger.info(`session created: ${id} (${sessionName}) harness=${profileRow.harnessId} cwd=${realPath}`);
    // Audit trail: best-effort sink (default app-wide recorder), never throws.
    await this.#audit({
      actorUserId: userId,
      action: "session.create",
      targetType: "session",
      targetId: id,
      metadataJson: JSON.stringify({ name: sessionName, profileId, workingDir: realPath }),
    });
    return { id, tmuxSocket: socket, apiKey, promptDelivered };
  }

  /**
   * Types a creation prompt into a freshly-spawned pane once the harness has
   * produced output. The settle loop itself lives behind the launcher seam
   * ({@link NodeLauncher.deliverPrompt}) — it mirrors the phase-2
   * `prompt_deliver` command so a remote agent runs it as one round-trip.
   */
  async #deliverPrompt(
    socket: string,
    id: string,
    prompt: string,
    settleTimeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    return this.#launcher.deliverPrompt(socket, id, prompt, settleTimeoutMs, pollMs);
  }

  /**
   * Revokes a session's MCP token, tolerating a failing token store: if the
   * revoke itself throws, the row's `apiKeyId` link is cleared instead, so
   * the auth guard's link check (the key's id must equal the row's
   * `apiKeyId`, see `api/auth-guard.ts`) rejects the credential — the
   * documented second layer. Logs loudly either way; never throws, because
   * every caller is a cleanup/teardown path that must finish.
   */
  async #revokeTokenOrUnlink(sessionId: string): Promise<void> {
    try {
      await this.#tokens.revoke(sessionId);
    } catch (err) {
      logger
        .withError(err)
        .error(`session token revoke FAILED for ${sessionId}; clearing apiKeyId so the auth guard rejects the key`);
      try {
        await this.#sessions.update(sessionId, { apiKeyId: null });
      } catch (unlinkErr) {
        logger.withError(unlinkErr).error(`could not clear apiKeyId for ${sessionId} after a failed revoke`);
      }
    }
  }

  /**
   * The session's current screen, for the preview on its card.
   *
   * Asks tmux what the pane looks like right now rather than tailing the
   * output log. The log is a byte stream of everything the harness ever
   * wrote, including the redraws of a full-screen TUI, so its last few lines
   * are fragments of a repaint rather than anything a person can read — which
   * is exactly what the old preview showed. `capture-pane` renders the screen
   * instead, so the card shows what the terminal shows.
   *
   * Costs one tmux invocation per running session per call, which is what
   * makes the preview cheap enough to fan out over every card: no socket, no
   * terminal emulator and no WebGL context per tile.
   */
  async #preview(row: { id: string; status: string; alive: number; tmuxSocket: string | null }): Promise<string[]> {
    if (row.status !== "running" || row.alive !== 1 || !row.tmuxSocket) return [];
    try {
      return screenTail(await this.#launcher.capture(row.tmuxSocket, row.id));
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
  async toViews(rows: SessionTable[]): Promise<ReturnType<typeof toSessionView>[]> {
    const views: ReturnType<typeof toSessionView>[] = [];
    for (const row of rows) {
      views.push(toSessionView(row, row.status, await this.#preview(row)));
    }
    return views;
  }

  /** Lists sessions for a user, reconciling liveness against tmux. */
  async listSessions(userId: string): Promise<ReturnType<typeof toSessionView>[]> {
    return await this.toViews(await this.#sessions.listByUser(userId));
  }

  /** Gets a single session view for a user (reconciled). */
  async getSession(userId: string, id: string): Promise<ReturnType<typeof toSessionView> | undefined> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return undefined;
    return toSessionView(row, row.status, await this.#preview(row));
  }

  /**
   * Renames a session AND locks the name: a hand-picked name is exactly the
   * signal that the pane-title sweep must stop overwriting it. Releasing the
   * lock is {@link setNameLocked}'s job. The caller must pass a non-blank
   * trimmed name (the route enforces it); every session keeps a name.
   * @returns false when the session is absent or not the caller's
   */
  async updateName(userId: string, id: string, name: string): Promise<boolean> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    await this.#sessions.update(id, { name, nameLocked: 1 });
    return true;
  }

  /**
   * Turns the pane-title auto-naming on (`locked` false) or off (true) for
   * one session. Unlocking does not rename anything — the next sweep adopts
   * the pane's current title whenever it differs.
   * @returns false when the session is absent or not the caller's
   */
  async setNameLocked(userId: string, id: string, locked: boolean): Promise<boolean> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    await this.#sessions.update(id, { nameLocked: locked ? 1 : 0 });
    return true;
  }

  /** Sets or clears a session's note. Returns false if not found/not owner. */
  async updateNotes(userId: string, id: string, notes: string | null): Promise<boolean> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    // Normalize empty/whitespace notes to null so API clients get the same
    // behavior as the UI (a blank notes field means "no note").
    await this.#sessions.update(id, { notes: notes?.trim() ? notes.trim() : null });
    return true;
  }

  /**
   * Restart the session IN PLACE: same row, same id, same name. Kills the
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
   *          when the session is absent/not the caller's, was deleted, or a
   *          terminate won the race (so the caller converges on "gone")
   * @throws Error when the relaunch cannot be composed (profile/harness/
   *         binary gone, working dir unlinked, tmux refused the spawn). The
   *         parked row is rolled back to `terminated` + token revoked on the
   *         way out, so a failed restart leaves a dead-and-restartable row,
   *         never a `running` zombie the sweep would auto-revive.
   */
  async restartSession(userId: string, sourceId: string): Promise<{ id: string; tmuxSocket: string } | null> {
    // Ownership is checked BEFORE consulting the lease, so a foreign caller
    // can never ride another principal's in-flight restart for the id's info.
    const source = await this.#sessions.findById(sourceId);
    if (!source || source.userId !== userId) return null;
    const existing = restartInFlight.get(sourceId);
    if (existing) return existing; // same owner, already restarting — join it
    const run = (async (): Promise<{ id: string; tmuxSocket: string } | null> => {
      if (source.alive === 1 && source.tmuxSocket) {
        // killSession swallows "already gone"; the tree dies with its baked
        // key, which #reviveRow then rotates off the same row anyway.
        await this.#launcher.killSession(source.tmuxSocket, source.id);
      }
      // Conditional park: succeeds only if the row is still where we read it.
      // A terminate/delete in the window flips status/alive, so this no-ops
      // and we honor the kill rather than resurrecting it.
      const parkedRows = await this.#sessions.parkForRestart(
        source.id,
        { status: source.status, alive: source.alive },
        { status: "running", alive: 0, exitCode: null, endedAt: null },
      );
      if (parkedRows === 0) {
        await this.#audit({
          actorUserId: userId,
          action: "session.restart",
          targetType: "session",
          targetId: source.id,
          metadataJson: JSON.stringify({ name: source.name, racedTerminate: true }),
        });
        logger.info(`session restart abandoned (terminate/delete raced): ${source.id}`);
        return null;
      }
      const parked = await this.#sessions.findById(source.id);
      if (!parked) return null; // deleted between park and re-read
      let revived: boolean;
      try {
        revived = await this.#reviveRow(parked, { backoffCount: 0 });
      } catch (err) {
        // Roll the parked `running` row back to a truthful dead state and
        // retire any token #reviveRow minted before failing, so the sweep
        // (which lists only `running`) neither auto-revives nor leaves a
        // zombie. Mirrors createSession's spawn-failure rollback.
        await this.#sessions.markTerminated(parked.id, new Date().toISOString());
        await this.#revokeTokenOrUnlink(parked.id);
        throw err;
      }
      // Audit trail: a restart is its own event on the SAME row (create
      // already logged session.create; terminate logged its own death).
      // `racedTerminate` marks the case where the operator killed the
      // session mid-restart and we honored it (no pane, no token).
      await this.#audit({
        actorUserId: userId,
        action: "session.restart",
        targetType: "session",
        targetId: parked.id,
        metadataJson: JSON.stringify({ name: parked.name, racedTerminate: !revived }),
      });
      if (!revived) {
        logger.info(`session restart honored a mid-flight terminate: ${parked.id} left dead`);
        return null; // finding: don't report success for a revival that spawned nothing
      }
      logger.info(`session restarted in place: ${parked.id} (${parked.name})`);
      return { id: parked.id, tmuxSocket: parked.tmuxSocket ?? tmuxSocketFor(parked.id) };
    })().finally(() => restartInFlight.delete(sourceId));
    restartInFlight.set(sourceId, run);
    return run;
  }

  /** Terminates a session: kills the tmux tree and marks the DB row. */
  async terminateSession(userId: string, id: string): Promise<void> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return;
    if (row.tmuxSocket) {
      await this.#launcher.killSession(row.tmuxSocket, id);
    }
    await this.#sessions.markTerminated(id, new Date().toISOString());
    await this.#sessions.update(id, { alive: 0 });
    // Teardown must finish even when the token store is down: a failed revoke
    // unlinks apiKeyId (guard 401s the key) so the audit event below still lands.
    await this.#revokeTokenOrUnlink(id);
    await this.#audit({
      actorUserId: userId,
      action: "session.terminate",
      targetType: "session",
      targetId: id,
      metadataJson: JSON.stringify({ name: row.name }),
    });
  }

  /**
   * Permanently deletes a session: kills its tmux tree if it is running,
   * removes the DB row, and unlinks the per-session output log. Returns false
   * if not found/not owner.
   */
  async deleteSession(userId: string, id: string): Promise<boolean> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    if (row.tmuxSocket) {
      // Kill the pane even if it is already dead; try/catch so a missing
      // tmux session does not block the deletion.
      try {
        await this.#launcher.killSession(row.tmuxSocket, row.id);
      } catch {
        // pane already gone
      }
    }
    // Before deletion: revoke resolves the key via the row. A failure here is
    // survivable — unlinking apiKeyId neutralises the key, and deleting the
    // row outright does the same via the guard's missing-row check.
    await this.#revokeTokenOrUnlink(id);
    await this.#sessions.delete(id);
    // Best-effort log cleanup (the log is only an attach-replay artifact);
    // removeArtifacts swallows "no file" per path, as the direct unlink did.
    await this.#launcher.removeArtifacts([this.#launcher.logPath(id)]);
    // And the generated MCP config (no secrets, but nothing to leave behind).
    try {
      unlinkSync(sessionMcpConfigPath(id));
    } catch {
      // no config file
    }
    logger.info(`session deleted: ${id}`);
    await this.#audit({
      actorUserId: userId,
      action: "session.delete",
      targetType: "session",
      targetId: id,
      metadataJson: JSON.stringify({ name: row.name }),
    });
    return true;
  }

  /**
   * True if the tmux session is still alive for this row.
   *
   * Deliberately SYNC (the sweep's `hasSession` below goes through the async
   * launcher): callers outside async code use this as a cheap boolean probe,
   * and the local tmux call is synchronous under the hood. It is therefore a
   * LocalLauncher-only affordance — a phase-2 remote launcher's liveness is
   * async by nature, so injecting one makes this throw loudly rather than
   * silently answer from a stale projection.
   */
  isAlive(row: { tmuxSocket: string | null; id: string }): boolean {
    if (!row.tmuxSocket) return false;
    if (this.#launcher instanceof LocalLauncher) {
      return this.#launcher.hasSessionSync(row.tmuxSocket, row.id);
    }
    throw new Error("isAlive() is a local-launcher sync probe; remote liveness must await NodeLauncher.hasSession");
  }

  /** Reconciles all running rows in the DB against tmux liveness. */
  async reconcile(userId: string): Promise<void> {
    const running = await this.#sessions.listByUser(userId, "running");
    await this.reconcileRows(running);
  }

  /** Reconciles every running row in the DB (server-wide sweep). */
  async reconcileAll(): Promise<void> {
    await this.reconcileRows(await this.#sessions.listRunning());
  }

  /**
   * Exponential-backoff auto-restart for crashed sessions (same DB row).
   *
   * Called from the reconcile crash branch. Skips when the session is not
   * opted in (`restartOnExit`), the row is already alive, or the backoff
   * delay has not elapsed. When an attempt is made the next run is scheduled
   * first (`nextRestartAt`) so a sweep race cannot double-spawn; the attempt
   * mirrors `createSession` (validate → findBinary → buildCommand → tmux).
   * Failures leave the row dead and un-schedule the retry so the next sweep
   * tries again — but every attempt (success or not) advances `backoffCount`,
   * so a session that can never spawn again (deleted binary, unlinked cwd)
   * reaches the bounded give-up in `reconcileRows` (token revoked) instead of
   * rotating its MCP token once per sweep forever. A terminate racing the
   * restart is closed off in two layers: a fresh row re-read immediately
   * before the spawn, and a conditional (`status = 'running'`) post-spawn
   * patch — if it no longer applies, the orphaned pane is killed and the
   * just-issued token revoked. Returns true when a restart was spawned.
   */
  private async maybeAutoRestart(row: SessionTable): Promise<boolean> {
    if (row.status !== "running" || row.alive === 1 || row.restartOnExit !== 1) return false;
    const now = Date.now();
    // The last restart attempt (or the crash) scheduled a future retry; it
    // may not be due yet — sweep "no-op" until `nextRestartAt` passes.
    if (row.nextRestartAt && new Date(row.nextRestartAt).getTime() > now) return false; // backoff pending
    const delayMs = Math.min(30_000 * 2 ** row.backoffCount, 480_000);
    if (row.backoffCount >= 5) {
      logger.warn(`session ${row.id}: auto-restart backoff limit reached`);
      return false;
    }
    // Schedule the next attempt up-front: even if this spawn fails the row
    // can't be restarted in a tighter loop than the backoff allows.
    await this.#sessions.update(row.id, { nextRestartAt: new Date(now + delayMs).toISOString() });
    try {
      // Fresh status check: the sweep snapshot may predate a user terminate,
      // and we must not spawn a process under a session the operator killed.
      const fresh = await this.#sessions.findById(row.id);
      if (fresh?.status !== "running" || fresh.alive !== 0) return false;
      // A restart IS a new session, so it obeys the same rule the create
      // route and the picker enforce: a disabled or uninstalled harness
      // starts nothing. The row stays parked (the up-front nextRestartAt
      // re-tries on the backoff schedule); re-enabling the harness — or
      // reinstalling the CLI — makes the next tick respawn the pane.
      if (!(await harnessUsable(fresh.harnessId))) {
        logger.debug(
          `session ${fresh.id}: auto-restart deferred — harness "${fresh.harnessId}" is disabled or not installed`,
        );
        return false;
      }
      const revived = await this.#reviveRow(fresh, { backoffCount: fresh.backoffCount + 1 });
      if (revived) logger.info(`session auto-restarted (${row.id}), backoff=${row.backoffCount + 1}`);
      return revived;
    } catch (err) {
      logger.withError(err).warn(`auto-restart failed for ${row.id}`);
      // A failed spawn still counts as an attempt toward the backoff limit:
      // without this, a session that can never spawn (deleted binary) would
      // revoke+re-issue its token on every sweep forever and never reach the
      // terminal give-up in `reconcileRows`.
      await this.#sessions.update(row.id, { nextRestartAt: null, backoffCount: row.backoffCount + 1 });
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
   * @throws when the launch cannot even be composed (profile/harness/binary
   *         gone, working dir unlinked, tmux refused the spawn)
   */
  async #reviveRow(row: SessionTable, { backoffCount }: { backoffCount: number }): Promise<boolean> {
    const profileRow = await this.#profiles.findById(row.profileId);
    if (!profileRow) throw new Error("profile missing");
    const harness = getHarness(row.harnessId);
    if (!harness) throw new Error("harness missing");
    const realPath = await this.#launcher.validateWorkingDir(row.workingDir);
    const binary = await this.#launcher.resolveBinary(harness);
    if (!binary) throw new Error("harness binary missing");
    const profile = parseProfile(profileRow);
    // Rotate the MCP token: the old process is gone and its baked key must
    // die with it; the new pane bakes the freshly issued one. A failed
    // revoke must NOT abort the restart — `issue` below rewrites the row's
    // apiKeyId, and the guard's link check then 401s the orphaned old key.
    await this.#revokeTokenOrUnlink(row.id);
    const apiKey = await this.#tokens.issue(row.id, row.userId);
    const mcp = registerSessionMcp(harness, row.id);
    // Same-row restart: resume the crashed conversation when it survived,
    // re-pin when it didn't (or the row predates the feature).
    const harnessSession = await this.#planHarnessSession(harness, row.harnessSessionId ?? null, realPath);
    const socket = row.tmuxSocket ?? tmuxSocketFor(row.id);
    // Cheap last look before the spawn: everything above (profile lookup,
    // findBinary, two token round-trips) is a window in which the operator
    // can terminate the session — never bake a pane under a killed row.
    const preSpawn = await this.#sessions.findById(row.id);
    if (preSpawn?.status !== "running" || preSpawn.alive !== 0) {
      // The row died mid-flight; retire the token we just minted for it.
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    // Command assembly + spawn + log-dir + pipe-pane in one launcher call
    // (same method createSession uses; the pipe is re-attached even when
    // cleanup unlinked the log). bestEffortLog restores the pre-seam revive
    // semantics: a pane this live must not die over a lost replay-log pipe.
    await this.#launcher.launch({
      id: row.id,
      socket,
      harness,
      binary,
      cwd: realPath,
      profile,
      sessionName: row.name,
      moteEnv: sessionMcpEnv(apiKey, row.id, row.name),
      mcp,
      harnessSession,
      bestEffortLog: true,
    });
    // Conditional revival: a terminate that landed after the pre-spawn
    // check (between it and this write) must not resurrect the row — the
    // guard makes this a no-op and the orphan below is cleaned up instead.
    const revived = await this.#sessions.updateIfRunning(row.id, {
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
      logger.warn(`session ${row.id} terminated mid-restart; killing the orphan pane and revoking its token`);
      await this.#launcher.killSession(socket, row.id); // swallows "already gone"
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    return true;
  }

  /**
   * Fires the death push on the alive→dead reconcile transition — the ONLY
   * place death notifies (the manual `terminateSession` path deliberately
   * stays silent: the operator clicked it). `restartOnExit` decides crashed
   * vs exited; an opted-in row whose backoff is already exhausted (the same
   * `>= 5` limit `maybeAutoRestart` gives up at) gets `crashed_final`, so the
   * copy never promises a restart that will never come. Void-fired so a
   * throwing or slow sink cannot stall the sweep (`notifySession` itself
   * already swallows everything; this is belt-and-braces for an injected
   * mock).
   */
  #notifyDeath(row: SessionTable): void {
    const kind: NotifyKind = row.restartOnExit === 1 ? (row.backoffCount >= 5 ? "crashed_final" : "crashed") : "exited";
    void this.#notify(row.id, kind);
  }

  private async reconcileRows(rows: SessionTable[]): Promise<void> {
    const now = new Date().toISOString();
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
          // clears it again) so a session that never comes back carries a
          // truthful end time instead of lingering as a null-ended zombie.
          // `waiting_since` dies with the process — nobody is waiting anymore.
          await this.#sessions.update(row.id, { alive: 0, endedAt: now, waitingSince: null });
          logger.info(`session process absent (no socket): ${row.id}`);
          this.#notifyDeath(row);
        }
        continue;
      }
      if (!(await this.#launcher.hasSession(row.tmuxSocket, row.id))) {
        // Probe FIRST, decide after: paneExitCode is awaited just like
        // hasSession, so collect every async probe before touching state.
        const exitCode = row.alive === 1 ? await this.#launcher.paneExitCode(row.tmuxSocket, row.id) : null;
        // ── TOCTOU re-check (spec §6.3 async seam TOCTOU): the probes above
        // widened the check→act window that opened at the skip-guard. A
        // restart that began mid-flight owns this row now (its pane is
        // deliberately absent) — skip it this sweep rather than revoke the
        // token #reviveRow just minted.
        if (restartInFlight.has(row.id)) continue;
        // Same spirit: the row may have been terminated or deleted under us
        // mid-await — neither stamping its death nor retiring its token is
        // ours to do once it isn't a running row anymore.
        const fresh = await this.#sessions.findById(row.id);
        if (fresh?.status !== "running") continue;
        if (row.alive === 1) {
          // `waiting_since` dies with the process — nobody is waiting anymore.
          await this.#sessions.update(row.id, { alive: 0, exitCode, endedAt: now, waitingSince: null });
          logger.info(`session crashed (exit=${exitCode ?? "?"}): ${row.id}`);
          this.#notifyDeath(row);
        }
        // Auto-restart crashed sessions that opted in (exponential backoff);
        // a session that will never come back has its MCP token revoked here.
        // "Never" means opted out OR the backoff limit was exhausted (the
        // sweep gives up at that count, so the bearer would linger otherwise).
        const restarted = await this.maybeAutoRestart(row);
        if (!restarted && (row.restartOnExit !== 1 || row.backoffCount >= 5)) {
          // Terminal: this session will never come back, so its bearer must
          // not linger. Revoke failures here must not abort the sweep for the
          // remaining rows — unlinking apiKeyId is the guard-side fallback.
          await this.#revokeTokenOrUnlink(row.id);
        }
        continue;
      }
      // Alive: stamp liveness + fold in the existing lastOutputAt mtime logic.
      // Build the patch conditionally and skip the write when nothing changed
      // (avoids churn on older rows per sweep, and a stale write could
      // resurrect a row the user just terminated).
      const patch: SessionUpdate = {};
      if (row.alive !== 1) {
        patch.alive = 1;
        patch.endedAt = null; // back among the living — the stamp was for the death
      }
      if (row.startedAt == null) patch.startedAt = now;
      // A healthy sweep (alive at sweep) proves the crash resolved itself;
      // reset the auto-restart backoff so the next crash restarts promptly.
      if (row.alive === 1 && row.backoffCount > 0) patch.backoffCount = 0;
      // Auto-title mode: mirror the pane's OSC title (Claude Code titles
      // itself after the current task) into the session name. Two untitled
      // defaults are rejected: a title still equal to the running command,
      // and tmux's initial title — the host name (verified against tmux
      // 3.6). Locked names (an operator renamed or pinned) are never
      // touched, and the read is skipped entirely so the sweep stays cheap.
      if (row.nameLocked !== 1) {
        const pane = await this.#launcher.paneTitle(row.tmuxSocket, row.id);
        const title = pane ? normalizePaneTitle(pane.title) : "";
        if (pane && title && title !== pane.command && title !== HOST_NAME && title !== row.name) {
          patch.name = title;
        }
      }
      try {
        // TODO(spec §6.3): phase-2 routes through launcher (lastOutputAt's
        // mtime probe is not machine-scoped yet; phase 0 is local-only).
        const mtimeMs = (await Bun.file(sessionLogPath(row.id)).stat()).mtime.getTime();
        if (!row.lastOutputAt || mtimeMs > new Date(row.lastOutputAt).getTime()) {
          patch.lastOutputAt = new Date(mtimeMs).toISOString();
        }
      } catch {
        /* no log yet */
      }
      if (Object.keys(patch).length > 0) {
        await this.#sessions.update(row.id, patch);
      }
    }
  }

  /** Whether any harness is installed at all (setup wizard uses this). */
  async anyHarnessInstalled(): Promise<boolean> {
    for (const h of ALL_HARNESSES) {
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

/** Parses a profile row's JSON blobs into the plugin-facing shape. */ export function parseProfile(row: {
  envJson: string | null;
  flagsJson: string | null;
  settingsJson: string | null;
  configIsolation: number;
  restartOnExit?: number;
  name: string;
  description?: string | null;
}): ProfileDefinition {
  return {
    name: row.name,
    description: row.description ?? null,
    env: row.envJson ? (JSON.parse(row.envJson) as Record<string, string>) : {},
    flags: row.flagsJson ? (JSON.parse(row.flagsJson) as string[]) : [],
    settings: row.settingsJson ? (JSON.parse(row.settingsJson) as Record<string, unknown>) : null,
    configIsolation: row.configIsolation === 1,
    restartOnExit: row.restartOnExit === 1,
  };
}

/** Default session name: the current date/time, e.g. "2026-08-18 14:30". */
export function defaultSessionName(): string {
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
 * Reads the tail of a session's pane log (see the mover: `nodes/log-tail.ts`
 * + `LocalLauncher.readLogTail`). Kept as the import path every route/test
 * already uses; the read itself lives behind the launcher seam.
 */
export async function readSessionLogTail(sessionId: string): Promise<{ lines: string[]; truncated: boolean }> {
  return defaultLocalLauncher.readLogTail(sessionId);
}

/** Rough liveness state of a session, derived from output recency. */
export type Activity = "active" | "idle" | "terminated";

/**
 * Rough activity: running + output within 60s = active, else idle.
 *
 * Known limitation (plan property, accepted): a session that is working but
 * quiet for >60s (e.g. an agent "thinking") shows as idle. A future round
 * could add a progress-aware signal (harness heartbeat or an adaptive
 * window) to avoid false-idle for slow-but-working agents.
 */
export function computeActivity(lastOutputAt: string | null, status: string, now = Date.now()): Activity {
  if (status !== "running") return "terminated";
  if (!lastOutputAt) return "active"; // just started
  return now - new Date(lastOutputAt).getTime() <= 60_000 ? "active" : "idle";
}

/** How many lines of a session's screen a preview carries. */
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

/** JSON-safe session view (no internal fields). */
/**
 * Cleans a raw tmux `pane_title` for use as a session name: control/escape
 * residue collapses to single spaces, a leading status decoration is dropped
 * (Claude Code prefixes the title with a cycling glyph — ✳/✻/· — that would
 * otherwise churn the name between sweeps), and the result is bounded like
 * every other name the API accepts (120 chars). Returns "" for a title that
 * has nothing displayable in it.
 */
function normalizePaneTitle(raw: string): string {
  // Intentional: the whole point is to strip terminal control characters
  // that can ride along in a raw OSC title.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing terminal output
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return cleaned
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 120);
}

export function toSessionView(
  row: {
    id: string;
    userId: string;
    profileId: string;
    harnessId: string;
    nodeId: string;
    name: string;
    workingDir: string;
    status: string;
    createdAt: string;
    endedAt: string | null;
    lastOutputAt: string | null;
    notes: string | null;
    alive: number;
    exitCode: number | null;
    startedAt: string | null;
    backoffCount: number;
    restartOnExit: number;
    nextRestartAt: string | null;
    nameLocked: number;
    notify: number;
    waitingSince: string | null;
    terminalReplayLines?: number | null;
  },
  status: string,
  /** The session's current screen, bottom-first-trimmed; empty when not running. */
  preview: string[] = [],
  /**
   * Viewer-relative access to attach to the view. A returned row is always
   * visible to *someone*, so this is never `"none"`. Defaults to `"owner"` so
   * the many owner-keyed direct callers stay valid; the sharing service
   * overrides it per-viewer.
   */
  access: Exclude<Access, "none"> = "owner",
) {
  return {
    id: row.id,
    profileId: row.profileId,
    harnessId: row.harnessId,
    nodeId: row.nodeId,
    name: row.name,
    workingDir: row.workingDir,
    status,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    lastOutputAt: row.lastOutputAt,
    notes: row.notes,
    activity: computeActivity(row.lastOutputAt, status),
    // The session's current screen, captured by the caller (see
    // SessionManagerService#preview). Passed in rather than read here so this
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
    // ISO ts of the attention event that put this session in waiting-for-you
    // state (null = not waiting); cleared by the watcher on output-resume/death.
    waitingSince: row.waitingSince,
    access,
    // Per-session terminal attach history cap; null = instance default.
    terminalReplayLines: row.terminalReplayLines ?? null,
  };
}
