import { useEffect, useRef } from "react";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { desktopInvoke } from "@/lib/desktop";
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
 * This needs no server work and no VAPID keys: the SSE feed is already writing
 * every subshell's state into the query cache, so the only thing missing was
 * noticing a TRANSITION. Deliberately edge-triggered — a subshell that is
 * already waiting when the window opens is not news, and re-notifying on every
 * frame would make the feature unusable within a minute.
 */
export function useDesktopNotifications(): void {
  const { subshells } = useLiveSubshells();
  /**
   * Which subshells were waiting last frame.
   *
   * `undefined` until the first frame lands, which is what distinguishes "this
   * one just started waiting" from "this one was already waiting before the
   * app opened" — without it, opening the app fires a notification per idle
   * agent.
   */
  const previous = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const waiting = new Set<string>(subshells.filter((s) => subshellIndicator(s) === "waiting").map((s) => s.id));
    const before = previous.current;
    previous.current = waiting;
    if (!before) return;

    for (const subshell of subshells) {
      if (!waiting.has(subshell.id) || before.has(subshell.id)) continue;
      void desktopInvoke("desktop_notify", {
        title: subshell.name || "Subshell",
        body: "Waiting for you.",
      });
    }
  }, [subshells]);
}
