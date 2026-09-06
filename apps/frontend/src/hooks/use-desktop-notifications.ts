import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { desktopInvoke } from "@/lib/desktop";
import { getMasterSwitch } from "@/lib/notifications";
import { subshellIndicator } from "@/lib/subshell-indicator";

/**
 * Native notifications for the desktop shell, driven off the feed the app
 * already has.
 *
 * The web path is VAPID push through a service worker, and `lib/notifications.ts`
 * gates on `PushManager` — which neither WKWebView nor WebKitGTK has, so the
 * desktop app would report "unsupported" and a tray-resident window would have
 * no way to say an agent is waiting. That undercuts the point of a tray.
 *
 * This needs no server work and no VAPID keys: the SSE feed already writes
 * every subshell's state into the query cache, so the only thing missing was
 * noticing a TRANSITION.
 *
 * **It must apply the same three gates the server's push path applies**, and
 * the list it reads makes that non-optional. `GET /api/subshells` returns every
 * subshell the caller can SEE — their own, ones shared with them, and for an
 * ADMIN every subshell on the instance. The server's own
 * `notify.service.ts` sends only to `row.userId`, only when `row.notify` is
 * set, and only when the owner's master switch is on;
 * `.claude/rules/security-context.md` states the invariant directly: "Sharing
 * widens who can see/act on a subshell; it never widens who gets pushed about
 * it." Without these filters an admin's desktop notifies on every user's agent
 * on the instance, and a muted bell notifies anyway.
 */
export function useDesktopNotifications(): void {
  const { subshells } = useLiveSubshells();
  // The account-wide switch, cached — it is one value shared across devices,
  // and the same endpoint `lib/notifications.ts` already wraps.
  const { data: notifyEnabled } = useQuery({
    queryKey: ["notify-master-switch"],
    queryFn: getMasterSwitch,
    staleTime: 60_000,
  });

  /**
   * Which subshells were waiting last frame.
   *
   * `undefined` until the first frame lands, which is what distinguishes "this
   * one just started waiting" from "this one was already waiting before the
   * app opened" — without it, opening the app fires one notification per idle
   * agent.
   */
  const previous = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    // Only the owner's own, belled subshells are ever notified about — the
    // list itself is much wider than that.
    const mine = subshells.filter((s) => s.access === "owner" && s.notify);
    const waiting = new Set<string>(mine.filter((s) => subshellIndicator(s) === "waiting").map((s) => s.id));
    const before = previous.current;
    previous.current = waiting;
    // Track transitions even while the master switch is off, so turning it on
    // does not immediately fire for everything already waiting.
    if (!before || notifyEnabled !== true) return;

    for (const subshell of mine) {
      if (!waiting.has(subshell.id) || before.has(subshell.id)) continue;
      void desktopInvoke("desktop_notify", {
        title: subshell.name || "Subshell",
        body: "Waiting for you.",
      });
    }
  }, [subshells, notifyEnabled]);
}
