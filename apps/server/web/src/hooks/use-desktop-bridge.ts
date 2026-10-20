import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuickAdd } from "@/components/quick-add";
import { signOutAndRedirect } from "@/lib/auth";
import { type DesktopAction, onDesktopAction } from "@/lib/desktop";

/**
 * Turns native-chrome actions into things this app already does.
 *
 * Every action here is ROUTER-level on purpose. A native menu item that
 * navigated by setting `location.href` would do a full document load, which
 * unmounts every live terminal, drops the live feed and forces a history replay
 * on each pane — the exact cost the desktop shell exists to avoid. So the menu
 * bar and tray ask the page, and the page navigates.
 *
 * One action is deliberately NOT here: `focus-filter` belongs to the sidebar,
 * whose filter input is private to it. `AppSidebar` subscribes to that one
 * itself rather than exporting its internals.
 */

/** Where each navigation action lands. */
const ROUTES: Partial<Record<DesktopAction, string>> = {
  "go-subshells": "/",
  "go-workspaces": "/workspaces",
  "go-nodes": "/nodes",
  "go-settings": "/settings",
  "go-preferences": "/preferences",
};

/**
 * Subscribe to the shell's actions for as long as this is mounted.
 *
 * MUST be mounted inside `QuickAddProvider` — {@link useQuickAdd} throws
 * above it, and a hook called in `Shell`'s own body would sit outside the
 * provider it needs.
 */
export function useDesktopBridge(): void {
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();

  useEffect(
    () =>
      onDesktopAction((action) => {
        const to = ROUTES[action];
        if (to) {
          void navigate({ to });
          return;
        }
        if (action === "new-subshell") quickAdd.openLaunch();
        else if (action === "new-workspace") quickAdd.openNewWorkspace();
        else if (action === "sign-out") void signOutAndRedirect();
        // Anything else is the sidebar's own (focus-filter), or from a newer
        // shell than this build knows. Ignoring it is correct: the shell
        // degrades, it does not break.
      }),
    [navigate, quickAdd],
  );
}
