import { pruneLayout } from "@/api/workspaces/workspace-layout.js";
import type { SessionStatus } from "@/db/types/session-status.js";
import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";
import { BaseService } from "@/services/base.service.js";

/** Route error carrying an HTTP status; Elysia maps `status` to the response code. */
class WorkspacesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "WorkspacesError";
  }
}

/** Elevates a duplicate (user_id, name) to a 409. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

/** Parses stored layout JSON, treating anything unparseable as "no layout". */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** A workspace in API shape: parsed `layout` instead of `layoutJson`, plus the pane tally. */
type WorkspaceResponse = Omit<WorkspaceTable, "layoutJson"> & {
  /** The serialized dockview layout, or null when absent/unparseable. */
  layout: unknown;
  /** Number of panes referencing this workspace. */
  sessionCount: number;
};

/**
 * Maps a workspace row to its API shape, replacing the stored `layoutJson`
 * string with the parsed `layout` and attaching the pane tally the cards show.
 */
function toWorkspaceResponse(workspace: WorkspaceTable, sessionCount: number): WorkspaceResponse {
  const { layoutJson, ...rest } = workspace;
  return { ...rest, layout: layoutJson ? safeParse(layoutJson) : null, sessionCount };
}

/** One pane joined with a summary of the session it renders, as returned by `GET /:id`. */
interface WorkspacePaneView {
  /** Pane id */
  id: string;
  /** Session rendered in this pane */
  sessionId: string;
  /** Session display name, joined for the pane title */
  sessionName: string;
  /** running | terminated */
  sessionStatus: SessionStatus;
  /** False once the harness process has exited */
  sessionAlive: boolean;
  /**
   * Exit code of the harness process once dead, null while alive or when the
   * exit predates the code being readable. Joined here because the
   * workspace's exited-pane panel renders the same LogTail headline as the
   * detail page ("Session exited (code 137)").
   */
  sessionExitCode: number | null;
  /**
   * ISO ts of the attention event that put this session in waiting-for-you
   * state, null when not waiting. Joined here for the same reason as
   * `sessionExitCode`: the dock tab decorates its title from the pane row.
   */
  sessionWaitingSince: string | null;
  /** Absolute working directory of the session */
  workingDir: string;
}

/** Body of a detail read (`GET /:id`): the workspace plus its panes. */
export interface WorkspaceDetail {
  /** The workspace in API shape, with its layout pruned against the live panes. */
  workspace: Omit<WorkspaceTable, "layoutJson"> & { layout: unknown; sessionCount: number };
  /** Every pane with a summary of the session it renders. */
  panes: WorkspacePaneView[];
}

/**
 * Business logic behind `/api/workspaces`, one method per endpoint.
 *
 * Moved verbatim from the former monolithic route: same repository calls in
 * the same order, same checks, same `status`-carrying errors (which ride the
 * global error handler via `.status`). Workspace CRUD is owner-scoped —
 * anything outside the caller's ownership reads as 404, never 403, so ids
 * cannot be probed.
 */
export class WorkspacesService extends BaseService {
  /**
   * Creates a workspace for the caller.
   * @throws WorkspacesError 409 when the caller already has that workspace name.
   */
  async createWorkspace({
    userId,
    name,
  }: {
    /** Owner of the new workspace (never taken from the body). */
    userId: string;
    /** Workspace name, unique per user. */
    name: string;
  }): Promise<ReturnType<typeof toWorkspaceResponse>> {
    try {
      const created = await this.repos.workspaces.create({
        id: crypto.randomUUID(),
        userId,
        name,
      });
      // Nothing can reference a workspace that did not exist a moment ago.
      return toWorkspaceResponse(created, 0);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new WorkspacesError("duplicate", "You already have a workspace with that name", 409);
      }
      throw err;
    }
  }

  /** Lists the caller's workspaces with each pane tally. */
  async listWorkspaces(userId: string): Promise<ReturnType<typeof toWorkspaceResponse>[]> {
    // Two queries regardless of list size: the rows, then every pane count
    // grouped by workspace — merging beats an N+1.
    const workspaces = await this.repos.workspaces.listByUser(userId);
    const counts = await this.repos.workspacePanes.countByUser(userId);
    return workspaces.map((w) => toWorkspaceResponse(w, counts.get(w.id) ?? 0));
  }

  /**
   * Gets one workspace with its panes and each pane's session summary.
   * @throws WorkspacesError 404 when absent or owned by someone else.
   */
  async getWorkspace(userId: string, id: string): Promise<WorkspaceDetail> {
    const workspace = await this.repos.workspaces.findByIdForUser(id, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

    const paneRows = await this.repos.workspacePanes.listByWorkspace(workspace.id);
    const sessionsRepo = this.repos.sessions;
    const panes: WorkspacePaneView[] = [];
    for (const pane of paneRows) {
      const session = await sessionsRepo.findById(pane.sessionId);
      // The FK cascade means the session always exists; the guard keeps the
      // types honest rather than covering a real case.
      if (!session) continue;
      panes.push({
        id: pane.id,
        sessionId: pane.sessionId,
        sessionName: session.name,
        sessionStatus: session.status,
        sessionAlive: session.alive === 1,
        sessionExitCode: session.exitCode,
        sessionWaitingSince: session.waitingSince,
        workingDir: session.workingDir,
      });
    }

    // layout_json is not touched when a session delete cascades a pane away,
    // so it is filtered against the surviving panes here rather than swept.
    const stored = workspace.layoutJson ? safeParse(workspace.layoutJson) : null;
    const layout = pruneLayout(stored, new Set(panes.map((p) => p.id)));

    // The panes were just fetched for the response body; counting them here
    // is free and keeps `sessionCount` consistent with `panes.length`.
    return { workspace: { ...toWorkspaceResponse(workspace, panes.length), layout }, panes };
  }

  /**
   * Renames or updates a workspace.
   * @throws WorkspacesError 404 when absent or owned by someone else.
   * @throws WorkspacesError 409 when the new name collides with the caller's own.
   */
  async updateWorkspace(
    userId: string,
    id: string,
    update: { name?: string | undefined },
  ): Promise<ReturnType<typeof toWorkspaceResponse>> {
    const repo = this.repos.workspaces;
    const existing = await repo.findByIdForUser(id, userId);
    if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
    try {
      const updated = await repo.update(id, update);
      if (!updated) throw new WorkspacesError("not_found", "Workspace not found", 404);
      const sessionCount = await this.repos.workspacePanes.countForWorkspace(id);
      return toWorkspaceResponse(updated, sessionCount);
    } catch (err) {
      if (err instanceof WorkspacesError) throw err;
      if (isUniqueViolation(err)) {
        throw new WorkspacesError("duplicate", "You already have a workspace with that name", 409);
      }
      throw err;
    }
  }

  /**
   * Deletes a workspace; its panes cascade away.
   * @throws WorkspacesError 404 when absent or owned by someone else.
   */
  async deleteWorkspace(userId: string, id: string): Promise<{ ok: true }> {
    const repo = this.repos.workspaces;
    const existing = await repo.findByIdForUser(id, userId);
    if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
    await repo.delete(id);
    return { ok: true };
  }

  /**
   * Adds a pane holding one of the caller's sessions.
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the session is absent or not the caller's
   *   (reported as 404 so the endpoint never confirms another user's session id).
   */
  async addWorkspacePane(userId: string, workspaceId: string, sessionId: string): Promise<{ id: string }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

    // A pane may only reference the caller's own session.
    const session = await this.repos.sessions.findById(sessionId);
    if (!session || session.userId !== userId) {
      throw new WorkspacesError("not_found", "Session not found", 404);
    }

    const panesRepo = this.repos.workspacePanes;
    const created = await panesRepo.create({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      sessionId,
    });
    return { id: created.id };
  }

  /**
   * Saves the workspace's tiling layout (stored verbatim as JSON).
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   */
  async saveWorkspaceLayout(userId: string, id: string, layout: unknown): Promise<{ ok: true }> {
    const repo = this.repos.workspaces;
    const workspace = await repo.findByIdForUser(id, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
    await repo.update(id, { layoutJson: JSON.stringify(layout) });
    return { ok: true };
  }

  /**
   * Removes a pane from a workspace (the session is untouched).
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the pane is not part of that workspace.
   */
  async removeWorkspacePane(userId: string, workspaceId: string, paneId: string): Promise<{ ok: true }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
    const panesRepo = this.repos.workspacePanes;
    const panes = await panesRepo.listByWorkspace(workspace.id);
    if (!panes.some((p) => p.id === paneId)) {
      throw new WorkspacesError("not_found", "Pane not found", 404);
    }
    await panesRepo.delete(paneId);
    return { ok: true };
  }
}
