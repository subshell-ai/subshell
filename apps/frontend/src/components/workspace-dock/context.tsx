import type { SearchAddon } from "@xterm/addon-search";
import { createContext, useContext } from "react";
import type { WorkspaceDetail } from "@/types/workspace";

/**
 * Shared state and handlers reachable from inside a dockview panel, a
 * group's header actions, or a tab, all of which live in a portal-rendered
 * subtree dockview owns rather than a subtree `<WorkspaceDock>` renders
 * directly. Context is what lets `DockedPane`, `GroupHeaderActions` and
 * `SubshellTab` read the always-fresh workspace detail and call back into
 * `WorkspaceDock` without dockview ever needing to know these values exist.
 */
export interface WorkspaceDockContextValue {
  /**
   * The live workspace detail. Panels look their pane up here by id on every
   * render rather than from the `params` they were added with, which are a
   * point-in-time snapshot that goes stale as the 5s poll refreshes subshell
   * status.
   */
  detail: WorkspaceDetail;
  /** A pane's search addon, keyed by pane id; absent until its terminal has mounted. */
  searchAddons: ReadonlyMap<string, SearchAddon>;
  /** Publishes a pane's search addon on terminal mount, or clears it (`null`) on dispose. */
  setSearchAddon: (paneId: string, addon: SearchAddon | null) => void;
  /** Restarts a pane's subshell in place, repointing the pane at the newly-minted subshell. */
  onRestart: (subshellId: string) => void;
  /** Removes a pane from the workspace, leaving its subshell alone. */
  onRemovePane: (paneId: string) => void;
  /** Terminates a subshell's process, after confirming. */
  onTerminate: (subshellId: string) => void;
  /** Deletes a subshell outright, after confirming; its pane disappears via the FK cascade. */
  onDeleteSubshell: (subshellId: string) => void;
}

const WorkspaceDockContext = createContext<WorkspaceDockContextValue | null>(null);

/** Provider for {@link WorkspaceDockContext}; wraps the `<DockviewReact>` tree. */
export const WorkspaceDockProvider = WorkspaceDockContext.Provider;

/**
 * Reads {@link WorkspaceDockContextValue}. Throws outside a `<WorkspaceDock>`
 * tree — `DockedPane`, `GroupHeaderActions` and `SubshellTab` are only ever
 * rendered inside one, by dockview itself.
 */
export function useWorkspaceDockContext(): WorkspaceDockContextValue {
  const value = useContext(WorkspaceDockContext);
  if (!value) {
    throw new Error("useWorkspaceDockContext must be used within a WorkspaceDock");
  }
  return value;
}
