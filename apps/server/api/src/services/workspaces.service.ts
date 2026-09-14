import { pruneLayout } from "@/api/workspaces/workspace-layout.js";
import type { SubshellStatus } from "@/db/types/subshell-status.js";
import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";
import { accessAtLeast, loadSubshellAccess } from "@/lib/subshell-access.js";
import { BaseService } from "@/services/base.service.js";
import { isNodeOffline } from "@/services/nodes/node-registry.js";

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
export type WorkspaceResponse = Omit<WorkspaceTable, "layoutJson" | "draft"> & {
  /** The serialized dockview layout, or null when absent/unparseable. */
  layout: unknown;
  /** Number of panes referencing this workspace. */
  subshellCount: number;
  /** True while this is an unsaved draft; saving it ("Save workspace…") clears the flag. */
  draft: boolean;
};

/**
 * Maps a workspace row to its API shape, replacing the stored `layoutJson`
 * string with the parsed `layout`, the 0/1 `draft` column with a boolean, and
 * attaching the pane tally the cards show.
 */
function toWorkspaceResponse(workspace: WorkspaceTable, subshellCount: number): WorkspaceResponse {
  const { layoutJson, draft, ...rest } = workspace;
  return { ...rest, layout: layoutJson ? safeParse(layoutJson) : null, subshellCount, draft: draft === 1 };
}

/** One pane joined with a summary of the subshell it renders, as returned by `GET /:id`. */
interface WorkspacePaneView {
  /** Pane id */
  id: string;
  /** Subshell rendered in this pane */
  subshellId: string;
  /** Subshell display name, joined for the pane title */
  subshellName: string;
  /** running | terminated */
  subshellStatus: SubshellStatus;
  /** False once the harness process has exited */
  subshellAlive: boolean;
  /**
   * Exit code of the harness process once dead, null while alive or when the
   * exit predates the code being readable. Joined here because the
   * workspace's exited-pane panel renders the same LogTail headline as the
   * detail page ("Subshell exited (code 137)").
   */
  subshellExitCode: number | null;
  /**
   * ISO ts of the attention event that put this subshell in waiting-for-you
   * state, null when not waiting. Joined here for the same reason as
   * `subshellExitCode`: the dock tab decorates its title from the pane row.
   */
  subshellWaitingSince: string | null;
  /** Absolute working directory of the subshell */
  workingDir: string;
  /** Node the subshell runs on (`local` = control-plane host) */
  subshellNodeId: string;
  /**
   * True = the pane's agent node has no live connection (spec §5.6) — the
   * subshell may still be RUNNING there, its state is just unobservable.
   * Joined so the docked pane can render the same node-offline precedence
   * the cards and the detail badge already show.
   */
  subshellNodeOffline: boolean;
}

/** Body of a detail read (`GET /:id`): the workspace plus its panes. */
export interface WorkspaceDetail {
  /** The workspace in API shape, with its layout pruned against the live panes. */
  workspace: WorkspaceResponse;
  /** Every pane with a summary of the subshell it renders. */
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
   * Creates a workspace for the caller, optionally with its first pane already
   * in it — the shape "split this subshell into a workspace" needs, so the
   * browser lands on a dock that already holds the subshell it came from.
   *
   * **Not transactional, because this codebase has no transaction helper** (no
   * service calls `db.transaction()`). Two things stand in for one: the
   * subshell visibility check runs BEFORE the workspace is inserted, so the
   * common failure leaves nothing behind at all; and a pane insert that throws
   * anyway is followed by deleting the workspace row before the error is
   * rethrown, so a create either yields a workspace with its pane or yields
   * nothing.
   *
   * @throws WorkspacesError 409 when the caller already has that workspace name
   *   (drafts are exempt — they sit outside the unique index).
   * @throws WorkspacesError 404 when `subshellId` names a subshell the caller
   *   cannot see (absent, or another user's and unshared — reported as 404 so
   *   the endpoint never confirms someone else's subshell id).
   */
  async createWorkspace({
    userId,
    name,
    draft = false,
    subshellId,
  }: {
    /** Owner of the new workspace (never taken from the body). */
    userId: string;
    /** Workspace name, unique per user unless this is a draft. */
    name: string;
    /** True creates it unsaved: hidden from the list, free to collide by name. */
    draft?: boolean | undefined;
    /** When given, the workspace is created holding one pane for this subshell. */
    subshellId?: string | undefined;
  }): Promise<WorkspaceResponse> {
    // Before the insert: a refusal here must leave no workspace row behind, and
    // it is the same check `addWorkspacePane` applies (spec 2026-08-31 §4.3).
    if (subshellId !== undefined) {
      const { row, access } = await loadSubshellAccess(
        { subshells: this.repos.subshells, shares: this.repos.subshellShares, userMeta: this.repos.userMeta },
        userId,
        subshellId,
      );
      if (!row || !accessAtLeast(access, "view")) {
        throw new WorkspacesError("not_found", "Subshell not found", 404);
      }
    }

    let created: WorkspaceTable;
    try {
      created = await this.repos.workspaces.create({
        id: crypto.randomUUID(),
        userId,
        name,
        draft: draft ? 1 : 0,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new WorkspacesError("duplicate", "You already have a workspace with that name", 409);
      }
      throw err;
    }

    // Nothing else can reference a workspace that did not exist a moment ago,
    // so the tally is exactly the pane this call adds.
    if (subshellId === undefined) return toWorkspaceResponse(created, 0);

    try {
      await this.repos.workspacePanes.create({
        id: crypto.randomUUID(),
        workspaceId: created.id,
        subshellId,
      });
    } catch (err) {
      // The compensating delete stands in for the transaction this codebase
      // has no helper for. Its own failure must not mask the real error.
      await this.repos.workspaces.delete(created.id).catch(() => {});
      throw err;
    }
    return toWorkspaceResponse(created, 1);
  }

  /**
   * Lists the caller's workspaces with each pane tally.
   *
   * Drafts are EXCLUDED by default — an unsaved workspace belongs to the page
   * that created it, not to the Workspaces list or the sidebar. Passing
   * `subshellId` answers a different question ("which of my workspaces hold
   * this subshell"), where a freshly split draft is the most interesting
   * answer, so that filter includes them and orders by recency instead of name.
   *
   * @param userId - Owner whose workspaces to list
   * @param opts.subshellId - Restrict to workspaces holding a pane for this subshell
   */
  async listWorkspaces(userId: string, opts?: { subshellId?: string | undefined }): Promise<WorkspaceResponse[]> {
    // Two queries regardless of list size: the rows, then every pane count
    // grouped by workspace — merging beats an N+1.
    const workspaces = opts?.subshellId
      ? await this.repos.workspaces.listBySubshellForUser(userId, opts.subshellId)
      : await this.repos.workspaces.listByUser(userId);
    const counts = await this.repos.workspacePanes.countByUser(userId);
    return workspaces.map((w) => toWorkspaceResponse(w, counts.get(w.id) ?? 0));
  }

  /**
   * Gets one workspace with its panes and each pane's subshell summary.
   * @throws WorkspacesError 404 when absent or owned by someone else.
   */
  async getWorkspace(userId: string, id: string): Promise<WorkspaceDetail> {
    const workspace = await this.repos.workspaces.findByIdForUser(id, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

    const paneRows = await this.repos.workspacePanes.listByWorkspace(workspace.id);
    const subshellsRepo = this.repos.subshells;
    const panes: WorkspacePaneView[] = [];
    for (const pane of paneRows) {
      const subshell = await subshellsRepo.findById(pane.subshellId);
      // The FK cascade means the subshell always exists; the guard keeps the
      // types honest rather than covering a real case.
      if (!subshell) continue;
      panes.push({
        id: pane.id,
        subshellId: pane.subshellId,
        subshellName: subshell.name,
        subshellStatus: subshell.status,
        subshellAlive: subshell.alive === 1,
        subshellExitCode: subshell.exitCode,
        subshellWaitingSince: subshell.waitingSince,
        workingDir: subshell.workingDir,
        subshellNodeId: subshell.nodeId,
        subshellNodeOffline: isNodeOffline(subshell.nodeId),
      });
    }

    // layout_json is not touched when a subshell delete cascades a pane away,
    // so it is filtered against the surviving panes here rather than swept.
    const stored = workspace.layoutJson ? safeParse(workspace.layoutJson) : null;
    const layout = pruneLayout(stored, new Set(panes.map((p) => p.id)));

    // The panes were just fetched for the response body; counting them here
    // is free and keeps `subshellCount` consistent with `panes.length`.
    return { workspace: { ...toWorkspaceResponse(workspace, panes.length), layout }, panes };
  }

  /**
   * Renames a workspace, and/or promotes a draft to a saved one.
   *
   * `draft` accepts only `false`: promotion is the one transition, and a saved
   * workspace never becomes a draft (the route's schema is a `t.Literal(false)`,
   * so the other direction cannot even be spelled). Promotion is where a draft's
   * auto-name meets the unique index for the first time, which is why the same
   * 409 a rename produces is the answer here too.
   *
   * @throws WorkspacesError 404 when absent or owned by someone else.
   * @throws WorkspacesError 409 when the name collides with one the caller has saved.
   */
  async updateWorkspace(
    userId: string,
    id: string,
    update: { name?: string | undefined; draft?: false | undefined },
  ): Promise<WorkspaceResponse> {
    const repo = this.repos.workspaces;
    const existing = await repo.findByIdForUser(id, userId);
    if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
    // Built key by key rather than spread: an explicit `undefined` would reach
    // the UPDATE as a column to set.
    const patch: { name?: string; draft?: number } = {};
    if (update.name !== undefined) patch.name = update.name;
    if (update.draft === false) patch.draft = 0;
    try {
      const updated = await repo.update(id, patch);
      if (!updated) throw new WorkspacesError("not_found", "Workspace not found", 404);
      const subshellCount = await this.repos.workspacePanes.countForWorkspace(id);
      return toWorkspaceResponse(updated, subshellCount);
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
   * Adds a pane holding a subshell the caller can see (own or shared to them).
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the subshell is absent or invisible to the
   *   caller (reported as 404 so the endpoint never confirms another user's id).
   */
  async addWorkspacePane(userId: string, workspaceId: string, subshellId: string): Promise<{ id: string }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

    // A pane may reference any subshell the caller can SEE — their own or one
    // shared to them (spec 2026-08-31 §4.3). Invisible (absent or unshared) is
    // a 404, so the endpoint never confirms another user's subshell id.
    const { row, access } = await loadSubshellAccess(
      { subshells: this.repos.subshells, shares: this.repos.subshellShares, userMeta: this.repos.userMeta },
      userId,
      subshellId,
    );
    if (!row || !accessAtLeast(access, "view")) {
      throw new WorkspacesError("not_found", "Subshell not found", 404);
    }

    const panesRepo = this.repos.workspacePanes;
    const created = await panesRepo.create({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      subshellId,
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
   * Removes a pane from a workspace (the subshell is untouched).
   *
   * **A draft left with fewer than two panes is deleted with it.** A draft only
   * exists because someone split a subshell in two, so one pane is no longer a
   * tiling of anything — the browser sends the user back to that subshell's own
   * page, and leaving the row behind would strand an unnamed workspace nothing
   * lists. A SAVED workspace is a thing the user chose to keep and is left with
   * its remaining pane (or none), exactly as before.
   *
   * @returns `workspaceDeleted` so the caller knows whether to close a panel or
   *   navigate away — it cannot infer that from the pane it asked to remove.
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the pane is not part of that workspace.
   */
  async removeWorkspacePane(
    userId: string,
    workspaceId: string,
    paneId: string,
  ): Promise<{ ok: true; workspaceDeleted: boolean }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
    const panesRepo = this.repos.workspacePanes;
    const panes = await panesRepo.listByWorkspace(workspace.id);
    if (!panes.some((p) => p.id === paneId)) {
      throw new WorkspacesError("not_found", "Pane not found", 404);
    }
    await panesRepo.delete(paneId);

    if (workspace.draft === 1 && (await panesRepo.countForWorkspace(workspace.id)) < 2) {
      await this.repos.workspaces.delete(workspace.id);
      return { ok: true, workspaceDeleted: true };
    }
    return { ok: true, workspaceDeleted: false };
  }
}
