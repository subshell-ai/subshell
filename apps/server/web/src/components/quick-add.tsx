import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { LaunchSubshellDialog } from "@/components/sidebar/launch-subshell-dialog";
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";

/** Triggers for the rail's quick-add dialogs, callable from anywhere. */
export interface QuickAddApi {
  /** Open the New-subshell launch dialog. */
  openLaunch: () => void;
  /** Open the New-workspace dialog. */
  openNewWorkspace: () => void;
}

const QuickAddContext = createContext<QuickAddApi | null>(null);

/** The host's quick-add triggers. Must be called under {@link QuickAddProvider}. */
export function useQuickAdd(): QuickAddApi {
  const api = useContext(QuickAddContext);
  if (!api) throw new Error("useQuickAdd must be used inside <QuickAddProvider>");
  return api;
}

/**
 * Mounts the sidebar's two quick-add dialogs once, at the app-shell root, and
 * hands out triggers. They used to live inside `AppSidebar` itself — which
 * means on phones they were mounted INSIDE the nav drawer's modal dialog. Two
 * stacked modal dialogs each install Base UI's touch scroll-lock, and the
 * launch dialog's Agent dropdown tripped the pair: the dialog's own
 * scroller was flung to its bottom and the header vanished off-screen
 * (iPhone report, 2026-09-04, pinned by the e2e repro). Opening a quick-add
 * now also closes the drawer (`AppSidebar.onQuickAdd`), so exactly one modal
 * is ever up — and because these dialogs live here rather than in the
 * sidebar, closing the drawer no longer unmounts a dialog that just opened.
 */
export function QuickAddProvider({ children }: { children: ReactNode }): ReactNode {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // A fresh object here would be a new context value on every render of this
  // provider, which re-runs every consumer effect that depends on it — the
  // desktop bridge re-subscribed its listener on each one. Setters are stable,
  // so the empty dependency list is honest.
  const api = useMemo<QuickAddApi>(
    () => ({ openLaunch: () => setLaunchOpen(true), openNewWorkspace: () => setWorkspaceOpen(true) }),
    [],
  );
  return (
    <QuickAddContext.Provider value={api}>
      {children}
      <LaunchSubshellDialog open={launchOpen} onOpenChange={setLaunchOpen} />
      <NewWorkspaceDialog open={workspaceOpen} onOpenChange={setWorkspaceOpen} />
    </QuickAddContext.Provider>
  );
}
