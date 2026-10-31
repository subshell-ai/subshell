import { BaseService } from "@/app/base.service.js";
import type { SubshellStatus } from "@/db/types/subshell-status.js";
import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";
import { isNodeOffline } from "@/modules/nodes/node-registry.js";
import { accessAtLeast, loadSubshellAccess } from "@/modules/subshells/access.js";
import { backfillLayout, type LayoutPaneInput, panelIdsInLayout, pruneLayout } from "@/modules/workspaces/layout.js";
import { logger } from "@/shared/logger.js";

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

/** Parses stored layout JSON, treating anything unparseable as "no layout". */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** A workspace in API shape: parsed `layout` instead of `layoutJson`, plus the pane tally. */
export type WorkspaceResponse = Omit<WorkspaceTable, "layoutJson"> & {
  /** The serialized dockview layout, or null when absent/unparseable. */
  layout: unknown;
  /** Number of subshells (tabs) the workspace currently holds. */
  subshellCount: number;
};

/** A workspace in the LIST shape: the row plus every pane, so the rail tree renders from one request. */
export interface WorkspaceListItem extends WorkspaceResponse {
  /** Panes in membership order (`createdAt`), each with its subshell summary. */
  panes: WorkspacePaneView[];
}

/**
 * Maps a workspace row to its API shape, replacing the stored `layoutJson`
 * string with the parsed `layout` and attaching the pane tally the cards show.
 */
function toWorkspaceResponse(workspace: WorkspaceTable, subshellCount: number): WorkspaceResponse {
  const { layoutJson, ...rest } = workspace;
  return { ...rest, layout: layoutJson ? safeParse(layoutJson) : null, subshellCount };
}

/** One pane joined with a summary of the subshell it renders, as returned by reads. */
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
 * Workspace CRUD is owner-scoped — anything outside the caller's ownership
 * reads as 404, never 403, so ids cannot be probed. Two rules define the
 * model (spec 2026-10-17): a workspace is a SET OF REFERENCES (it never owns
 * a subshell, a subshell may sit in many workspaces, and deleting either
 * side never reaches through to stop a pane), and it EXISTS EXACTLY AS LONG
 * AS IT HOLDS A TAB (the empty-retire below, on both removal paths).
 */
export class WorkspacesService extends BaseService {
  /**
   * The ONE rule for which subshell a pane may hold: any the caller can SEE —
   * their own or one shared to them (spec 2026-08-31 §4.3). Invisible (absent
   * or unshared) is a 404, so neither endpoint ever confirms another user's
   * subshell id. Shared by create-with-pane and add-pane so the two cannot
   * drift.
   * @throws WorkspacesError 404
   */
  private async requireVisibleSubshell(userId: string, subshellId: string): Promise<void> {
    const { row, access } = await loadSubshellAccess(
      { subshells: this.repos.subshells, shares: this.repos.subshellShares },
      userId,
      subshellId,
    );
    if (!row || !accessAtLeast(access, "view")) {
      throw new WorkspacesError("not_found", "Subshell not found", 404);
    }
  }

  /**
   * The ids of every subshell the caller can see, as a set. Both workspace
   * reads run their panes through this (review 2026-10-17): a pane filed
   * while a share was open keeps pointing at someone else's session after
   * the grant closes, and a read that joined its name, directory and live
   * state unconditionally kept re-disclosing exactly what the revocation
   * withdrew. `listVisibleTo` is the same resolver the subshells list
   * answers with, so a revoked pane simply leaves the tree and the dock the
   * way the revoked subshell leaves the list. The pane ROW stays: the grant
   * may come back, and a vanished tab is a case the client already handles
   * (it is what a subshell delete does to every workspace holding the pane).
   */
  async #visibleSubshellIds(userId: string): Promise<Set<string>> {
    const visible = await this.repos.subshells.listVisibleTo(userId);
    return new Set(visible.map((s) => s.id));
  }

  /**
   * The tally `subshellCount` answers everywhere: the panes the caller can
   * actually see. A rename response that counted raw rows would give the one
   * field two definitions — visible on the LIST, total here — and the moment
   * a caller writes the response into the workspace caches the rail badge
   * contradicts the tree beside it (review 2026-10-17, round 4).
   */
  async #visiblePaneCount(userId: string, workspaceId: string): Promise<number> {
    const [rows, visible] = await Promise.all([
      this.repos.workspacePanes.listByWorkspace(workspaceId),
      this.#visibleSubshellIds(userId),
    ]);
    return rows.filter((r) => visible.has(r.subshellId)).length;
  }

  /**
   * Creates a workspace for the caller, optionally with its first pane already
   * in it — the shape "open a workspace holding this pane" needs, so the
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
   * Names are not unique since migration 0058: auto-created workspaces reuse
   * their default title freely, and nothing reads the name as a key.
   *
   * @throws WorkspacesError 404 when `subshellId` names a subshell the caller
   *   cannot see (absent, or another user's and unshared — reported as 404 so
   *   the endpoint never confirms someone else's subshell id).
   */
  async createWorkspace({
    userId,
    name,
    subshellId,
  }: {
    /** Owner of the new workspace (never taken from the body). */
    userId: string;
    /** Workspace name. */
    name: string;
    /** When given, the workspace is created holding one pane for this subshell. */
    subshellId?: string | undefined;
  }): Promise<WorkspaceResponse> {
    // Before the insert: a refusal here must leave no workspace row behind, and
    // it is the same check `addWorkspacePane` applies (spec 2026-08-31 §4.3).
    if (subshellId !== undefined) await this.requireVisibleSubshell(userId, subshellId);

    const created = await this.repos.workspaces.create({
      id: crypto.randomUUID(),
      userId,
      name,
    });

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
      // The same retirement race `addWorkspacePane` answers: the row was
      // momentarily empty between the two writes, and a sweep (or a tab
      // closed in another window) took it out before the pane landed. The FK
      // refusal means "the workspace you asked about is gone" — the plain
      // 404, never a raw driver error as a 500 (review 2026-10-17).
      if (err instanceof Error && err.message.includes("FOREIGN KEY")) {
        throw new WorkspacesError("not_found", "Workspace not found", 404);
      }
      throw err;
    }
    return toWorkspaceResponse(created, 1);
  }

  /**
   * Lists the caller's workspaces, each with its pane tally AND its panes in
   * membership order — the rail tree renders the whole workspace branch from
   * this one request (spec 2026-10-17). `subshellId` narrows to the workspaces
   * holding that subshell, ordered by recency: that is the pane-header link's
   * "which of my arrangements is this pane in". Panes whose subshell the
   * caller can no longer see are omitted from `panes` — the same
   * `listVisibleTo` rule the pane-add guard applies, now on reads; the row
   * and its workspace survive.
   *
   * @param userId - Owner whose workspaces to list
   * @param opts.subshellId - Restrict to workspaces holding a pane for this subshell
   */
  async listWorkspaces(userId: string, opts?: { subshellId?: string | undefined }): Promise<WorkspaceListItem[]> {
    const workspaces = opts?.subshellId
      ? await this.repos.workspaces.listBySubshellForUser(userId, opts.subshellId)
      : await this.repos.workspaces.listByUser(userId);
    // Three queries regardless of list size: the rows, every pane of the
    // user joined with its subshell, and the caller's visible subshell ids —
    // grouping the flat pane list in memory beats an N+1 per workspace.
    const paneRows = await this.repos.workspacePanes.listForUserWithSubshells(userId);
    const visible = await this.#visibleSubshellIds(userId);
    const byWorkspace = new Map<string, WorkspacePaneView[]>();
    for (const row of paneRows) {
      // A pane whose subshell the caller can no longer see (the share closed)
      // carries nothing here; `subshellCount` counts what is shown, not the
      // rows still held server-side.
      if (!visible.has(row.subshellId)) continue;
      const list = byWorkspace.get(row.workspaceId) ?? [];
      list.push({
        id: row.id,
        subshellId: row.subshellId,
        subshellName: row.subshellName,
        subshellStatus: row.subshellStatus,
        subshellAlive: row.subshellAlive === 1,
        subshellExitCode: row.subshellExitCode,
        subshellWaitingSince: row.subshellWaitingSince,
        workingDir: row.workingDir,
        subshellNodeId: row.subshellNodeId,
        subshellNodeOffline: isNodeOffline(row.subshellNodeId),
      });
      byWorkspace.set(row.workspaceId, list);
    }
    return workspaces.map((w) => {
      const panes = byWorkspace.get(w.id) ?? [];
      return { ...toWorkspaceResponse(w, panes.length), panes };
    });
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
    // Same visibility screen as the list: a pane whose subshell the caller lost
    // access to drops out of `panes`, and because the layout below prunes
    // against the surviving ids, its tile leaves the dock too rather than
    // rendering a dead tab.
    const visible = await this.#visibleSubshellIds(userId);
    const panes: WorkspacePaneView[] = [];
    for (const pane of paneRows) {
      if (!visible.has(pane.subshellId)) continue;
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
   * Renames a workspace.
   * @throws WorkspacesError 404 when absent or owned by someone else.
   */
  async updateWorkspace(userId: string, id: string, update: { name?: string | undefined }): Promise<WorkspaceResponse> {
    const repo = this.repos.workspaces;
    const existing = await repo.findByIdForUser(id, userId);
    if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
    // Built key by key rather than spread: an explicit `undefined` would reach
    // the UPDATE as a column to set. An empty body answers the current row
    // WITHOUT stamping `updated_at`, which used to reorder the recency lists
    // for a change that never happened.
    if (update.name === undefined) {
      return toWorkspaceResponse(existing, await this.#visiblePaneCount(userId, id));
    }
    const updated = await repo.update(id, { name: update.name });
    if (!updated) throw new WorkspacesError("not_found", "Workspace not found", 404);
    return toWorkspaceResponse(updated, await this.#visiblePaneCount(userId, id));
  }

  /**
   * Deletes a workspace; its panes cascade away (the subshells keep running).
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
   *
   * **Idempotent by design (spec 2026-10-17):** adding a subshell the
   * workspace already holds returns the EXISTING pane row's id with a plain
   * 200. The unique `(workspace_id, subshell_id)` index makes a double
   * impossible, and racing inserts land on the re-read branch below (and one
   * racing the workspace's own retirement lands on the FK branch), so four
   * client surfaces no longer need their own dedupe guard to be correct —
   * "already a tab" is the same answer as "now it is".
   *
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the subshell is absent or invisible to the
   *   caller (reported as 404 so the endpoint never confirms another user's id).
   */
  async addWorkspacePane(
    userId: string,
    workspaceId: string,
    subshellId: string,
  ): Promise<{ id: string; alreadyPresent: boolean }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

    await this.requireVisibleSubshell(userId, subshellId);

    const panesRepo = this.repos.workspacePanes;
    const existing = await panesRepo.findByWorkspaceAndSubshell(workspace.id, subshellId);
    if (existing) return { id: existing.id, alreadyPresent: true };

    try {
      const created = await panesRepo.create({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        subshellId,
      });
      return { id: created.id, alreadyPresent: false };
    } catch (err) {
      // The race: a concurrent insert took the unique slot between the re-read
      // and this write. Answer it with the row that won, not with an error.
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        const raced = await panesRepo.findByWorkspaceAndSubshell(workspace.id, subshellId);
        if (raced) return { id: raced.id, alreadyPresent: true };
      }
      // The OTHER race, and the one the empty-retire makes possible: the last
      // pane closed (retiring the workspace) between the existence check
      // above and this insert, so the FK refuses the write. The auto-retire is
      // NOT one transaction with the pane removal — this codebase has no
      // transaction helper — so a racing add really does meet the FK refusal,
      // and it means exactly "the workspace you asked about is gone": answer
      // the plain 404, never a 500 (spec 2026-10-17, error handling).
      if (err instanceof Error && err.message.includes("FOREIGN KEY")) {
        throw new WorkspacesError("not_found", "Workspace not found", 404);
      }
      throw err;
    }
  }

  /**
   * Saves the workspace's tiling layout (stored as JSON, one repair applied).
   *
   * A submitted layout is kept verbatim EXCEPT that any pane row it has no
   * panel for is appended to it first (`backfillLayout`): a stale client's
   * flush — a second device whose dock mounted before a pane existed and then
   * saves on hide or unmount — must not be able to silently delete a live
   * pane from the arrangement, which would make every other reader re-append
   * the tile on its own terms. Read-side visibility pruning (`getWorkspace`'s
   * `pruneLayout`) still decides per caller what a reader actually sees.
   *
   * The backfill consults the saver's VISIBLE subshells, not raw rows: a pane
   * whose grant closed stays in the table (see `#visibleSubshellIds`), and
   * re-appending it would write the revoked subshell's name back into the
   * stored layout on every flush — a channel the list response ships
   * unpruned. A grant that comes back re-files the tab through the client's
   * own reconciliation, and that flush persists it.
   *
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   */
  async saveWorkspaceLayout(userId: string, id: string, layout: unknown): Promise<{ ok: true }> {
    const repo = this.repos.workspaces;
    const workspace = await repo.findByIdForUser(id, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
    let toStore = layout;
    const paneRows = await this.repos.workspacePanes.listByWorkspace(workspace.id);
    const known = new Set(panelIdsInLayout(layout));
    const missing = paneRows.filter((pane) => !known.has(pane.id));
    if (missing.length > 0) {
      // Only a flush that forgot something pays the second read; the steady
      // state costs one SELECT. id → name is what `backfillLayout` titles the
      // returned panels with.
      const visibleNames = new Map(
        (await this.repos.subshells.listVisibleTo(userId)).map((subshell) => [subshell.id, subshell.name]),
      );
      const titled: LayoutPaneInput[] = [];
      for (const pane of missing) {
        const title = visibleNames.get(pane.subshellId);
        // A pane whose grant closed stays in the table but is not the saver's
        // to write back; one whose subshell was deleted has no name to title.
        if (title === undefined) continue;
        titled.push({ id: pane.id, title });
      }
      if (titled.length > 0) toStore = backfillLayout(layout, titled);
    }
    await repo.update(id, { layoutJson: JSON.stringify(toStore) });
    return { ok: true };
  }

  /**
   * Removes a pane from a workspace (the subshell itself is untouched).
   *
   * A workspace exists exactly as long as it holds a tab (spec 2026-10-17,
   * conforming the remove side 2026-10-20): removing the last one RETIRES the
   * workspace, and the subshell keeps running unfiled. The retire is the same
   * repository call the close path uses (`retireEmptyAmong`), and its NOT
   * EXISTS guard is the race idiom: a pane added between this delete and the
   * retire statement keeps the workspace alive, and a racing add that lands
   * after the retire meets `addWorkspacePane`'s FK branch and hears the
   * plain 404.
   *
   * @returns Whether the workspace retired along with the pane. A retire that
   *   throws answers `false` with the pane already gone: the removal succeeded
   *   either way, and the empty row stays for the viewer's next read to find.
   * @throws WorkspacesError 404 when the workspace is absent or not the caller's.
   * @throws WorkspacesError 404 when the pane is not part of that workspace —
   *   including a pane a concurrent client removed first, which reads the
   *   same because it IS the same answer: it is no longer here.
   */
  async removeWorkspacePane(
    userId: string,
    workspaceId: string,
    paneId: string,
  ): Promise<{ ok: true; workspaceDeleted: boolean }> {
    const workspace = await this.repos.workspaces.findByIdForUser(workspaceId, userId);
    if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
    // Check-and-delete in one statement: a pane of a DIFFERENT workspace and
    // an already-gone pane both come back false, and both answer the 404 the
    // old list-then-delete dance gave them.
    if (!(await this.repos.workspacePanes.deleteWithin(workspace.id, paneId))) {
      throw new WorkspacesError("not_found", "Pane not found", 404);
    }
    // The pane row is committed: the removal succeeded whatever the retire
    // statement answers now, so a throw here must not become a 500 — the
    // client would report a failed removal, and its retry could only hear a
    // 404 (the pane is gone) while an empty workspace sat orphaned. The close
    // side swallows this same statement with a warn (subshell-manager's
    // delete); match it, and answer as "the workspace is still there" so the
    // viewer's next read sees the truth.
    let retired = 0;
    try {
      retired = await this.repos.workspaces.retireEmptyAmong(userId, [workspace.id]);
    } catch (err) {
      logger.warn(`empty-workspace retire after removing a pane from ${workspace.id} failed: ${String(err)}`);
    }
    return { ok: true, workspaceDeleted: retired > 0 };
  }
}
