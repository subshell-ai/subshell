import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SubshellStatus } from "@/db/types/subshell-status.js";
import type { NewWorkspacePane, WorkspacePaneTable } from "@/db/types/workspace-panes.db-types.js";

/** A pane of one user's workspace with the subshell facts the rail tree renders. */
export interface WorkspaceUserPaneRow {
  /** Pane id */
  id: string;
  /** Workspace the pane belongs to (groups the flat list per workspace) */
  workspaceId: string;
  /** Subshell rendered in this pane */
  subshellId: string;
  /** Subshell display name */
  subshellName: string;
  /** running | terminated */
  subshellStatus: SubshellStatus;
  /** 1 while the harness process lives (SQLite has no boolean) */
  subshellAlive: number;
  /** Exit code once dead, null while alive or predating the readable exit */
  subshellExitCode: number | null;
  /** ISO ts of the waiting-for-you attention event, null when not waiting */
  subshellWaitingSince: string | null;
  /** Absolute working directory of the subshell */
  workingDir: string;
  /** Node the subshell runs on (`local` = control-plane host) */
  subshellNodeId: string;
}

/**
 * Repository for workspace panes. Panes are reached through their workspace,
 * so ownership is checked one level up before any of these run.
 */
export class WorkspacePanesRepository extends BaseRepository {
  /** All panes of a workspace, oldest first — the fallback tab order. */
  async listByWorkspace(workspaceId: string): Promise<WorkspacePaneTable[]> {
    return this.db
      .selectFrom("workspacePanes")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /**
   * The pane a workspace already holds for a subshell, if any. The unique
   * `(workspace_id, subshell_id)` index (migration 0058) makes this at most
   * one row — the answer that turns a duplicate add into the idempotent 200
   * the service gives instead of a second tab.
   */
  async findByWorkspaceAndSubshell(workspaceId: string, subshellId: string): Promise<WorkspacePaneTable | undefined> {
    return this.db
      .selectFrom("workspacePanes")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("subshellId", "=", subshellId)
      .executeTakeFirst();
  }

  /**
   * Every (workspace, subshell) membership pair of one user. The subshells
   * list route filters `?workspace=none` / `?workspace=<id>` from this in
   * memory — the same posture the `q`/`nodeId` filters already take, and the
   * per-user lists are small by design (no-pagination rule).
   */
  async listMembershipForUser(userId: string): Promise<Array<{ workspaceId: string; subshellId: string }>> {
    return this.db
      .selectFrom("workspacePanes")
      .innerJoin("workspaces", "workspaces.id", "workspacePanes.workspaceId")
      .where("workspaces.userId", "=", userId)
      .select(["workspacePanes.workspaceId", "workspacePanes.subshellId"])
      .execute();
  }

  /**
   * Every pane of one user joined with the subshell facts the rail tree
   * renders, in membership order. One query for the whole workspace LIST
   * (each row carries its `workspaceId`; the service groups them) — the list
   * endpoint needed per-workspace tallies for the same reason.
   */
  async listForUserWithSubshells(userId: string): Promise<WorkspaceUserPaneRow[]> {
    return this.db
      .selectFrom("workspacePanes")
      .innerJoin("workspaces", "workspaces.id", "workspacePanes.workspaceId")
      .innerJoin("subshells", "subshells.id", "workspacePanes.subshellId")
      .where("workspaces.userId", "=", userId)
      .orderBy("workspacePanes.createdAt", "asc")
      .select([
        "workspacePanes.id",
        "workspacePanes.workspaceId",
        "workspacePanes.subshellId",
        "subshells.name as subshellName",
        "subshells.status as subshellStatus",
        "subshells.alive as subshellAlive",
        "subshells.exitCode as subshellExitCode",
        "subshells.waitingSince as subshellWaitingSince",
        "subshells.workingDir as workingDir",
        "subshells.nodeId as subshellNodeId",
      ])
      .execute();
  }

  /** Inserts a pane, stamping both timestamps. */
  async create(pane: NewWorkspacePane): Promise<WorkspacePaneTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspacePanes")
      .values({
        ...pane,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Removes a single pane. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspacePanes").where("id", "=", id).execute();
  }

  /**
   * RAW pane-row count for one workspace. The auto-retire decision is made
   * with this (a hidden-but-present row still keeps the workspace alive),
   * deliberately not with the visible tally the API responses carry — see
   * `WorkspacesService#visiblePaneCount` for the screened number.
   */
  async countForWorkspace(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("workspacePanes")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirst();
    return row?.n ?? 0;
  }
}
