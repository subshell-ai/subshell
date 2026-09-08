import { useEffect } from "react";
import { desktopInvoke } from "@/lib/desktop";

/**
 * Tell the desktop shell the page is up, so it can drop the title bar and show
 * the window.
 *
 * The shell creates `main` HIDDEN with an ordinary title bar and waits for
 * this. That is a handshake rather than a version check on purpose: the
 * desktop chrome ships inside the SERVER's embedded SPA, so a desktop build
 * can meet an instance that has never heard of it — and an old SPA under a
 * chrome-less window is an UNMOVABLE window. An old SPA simply never sends
 * this, and the shell falls back to showing a decorated window.
 *
 * It lives in the shell root rather than in the desktop sidebar because the
 * sidebar does not render on `/login` or `/setup` — which are exactly the
 * routes a first launch lands on. Sending it there meant a brand-new install
 * sat looking at nothing until the shell's own six-second fallback fired.
 *
 * @param desktop - whether this is the desktop shell at all
 */
export function useDesktopShellReady(desktop: boolean): void {
  useEffect(() => {
    if (!desktop) return;
    // The shell ignores a repeat, so a remount is harmless.
    void desktopInvoke("desktop_shell_ready", { overlay: true });
  }, [desktop]);
}
