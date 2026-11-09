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
/** How one focus handoff ended. */
export type PaneFocusOutcome =
  /** The terminal took keyboard focus. */
  | "focused"
  /** Focus moved somewhere else first, so the handoff gave up. */
  | "abandoned"
  /** The terminal left the DOM mid-handoff; the replacement's publish retries. */
  | "retired";

/**
 * Hands keyboard focus to a pane's terminal.
 *
 * `initial` is where focus was when the tab was clicked, not when the terminal
 * mounted: activation rebuilds a background tab's terminal, and the request
 * must not adopt focus the person gained during that gap. `settle` is called
 * exactly once with how the attempt ended.
 */
export type PaneFocus = (initial: Element | null, settle: (outcome: PaneFocusOutcome) => void) => void;

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
  /**
   * Publishes the mounted terminal's focus function for a pane, or clears it
   * (`null`) when that terminal is disposed. A click whose request outlived
   * the terminal it resolved is answered by the replacement's publish: the
   * handoff reports `retired` rather than consuming the request.
   */
  setPaneFocusTarget: (paneId: string, focus: PaneFocus | null) => void;
  /**
   * Hands keyboard focus to the pane's terminal. A tab click lands focus on
   * the tab itself, so without this the pane's harness never sees the next
   * Esc or keystroke — the docked `/mcp list` report that would not close,
   * and typing that goes nowhere, both look like rendering faults.
   */
  requestPaneFocus: (paneId: string) => void;
  /** Restarts a pane's subshell in place, repointing the pane at the newly-minted subshell. */
  onRestart: (subshellId: string) => void;
  /** Removes a pane from the workspace, leaving its subshell alone. */
  onRemovePane: (paneId: string) => void;
  /** Closes a subshell (terminate + delete), after confirming; its pane disappears via the FK cascade. */
  onCloseSubshell: (subshellId: string) => void;
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
