import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import { closeLandingFor } from "@/lib/subshell-close-landing";

/**
 * The workspace a close was made beside: its id, and the panes it held. The
 * id decides exactly one thing: that the workspace a close empties is the page
 * on screen, which the chooser then leaves (the same DELETE retires the
 * emptied workspace, so there is nothing to stay on). Callers pass it because
 * the holder object is what they have.
 */
export interface CloseWorkspaceContext {
  id: string;
  panes: readonly { subshellId: string }[];
}

/**
 * The one wiring of the close-landing rule: every surface that closes a
 * subshell from beside the workspace (the dock's Close, the pane-focus bar's
 * menu, the rail's row and cell menus) calls this where the DELETE resolves,
 * passing the workspace context it has on hand — the LIST-resolved holder on
 * a rail row, `detail` on a dock. The decision itself is the pure
 * `closeLandingFor`; see `lib/subshell-close-landing` for the rule and why
 * the not-found card is not the answer to an act the viewer just took. The
 * navigation REPLACES: the page being left no longer exists on the server,
 * so it must not sit in history for a Back button to trip over.
 * @returns A callback taking the closed subshell's id and the workspace it
 *          was open in (null when no workspace context came with the close)
 */
export function useCloseSubshellLanding(): (closedId: string, holder: CloseWorkspaceContext | null) => void {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (closedId: string, holder: CloseWorkspaceContext | null) => {
      const landing = closeLandingFor({
        currentRouteId: subshellIdFromPath(location.pathname),
        currentWorkspaceRouteId: workspaceIdFromPath(location.pathname),
        closedId,
        holderWorkspaceId: holder?.id ?? null,
        workspacePanes: holder?.panes ?? [],
      });
      if (!landing) return;
      if (landing.to === "/subshells/$id")
        void navigate({ to: "/subshells/$id", params: landing.params, replace: true });
      else void navigate({ to: "/subshells", replace: true });
    },
    [location.pathname, navigate],
  );
}
