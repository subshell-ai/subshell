import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { desktopInvoke } from "@/lib/desktop";
import { getMasterSwitch } from "@/lib/notifications";
import { subshellIndicator } from "@/lib/subshell-indicator";
import { PERMISSIONS, type Permission } from "@/types/permissions";

/** What `desktop_notify` answers once it checks before posting (spec §5.1). */
interface NotifyResult {
  /** False when macOS would have swallowed it — nothing was posted. */
  shown: boolean;
  /** Why, in the OS's own words. */
  permission: Permission;
}

/** A shell older than spec 2026-09-14 answers nothing at all; that is not a denial. */
function asNotifyResult(value: unknown): NotifyResult | null {
  if (typeof value !== "object" || value === null) return null;
  const { shown, permission } = value as Record<string, unknown>;
  if (typeof shown !== "boolean" || !PERMISSIONS.includes(permission as Permission)) return null;
  return { shown, permission: permission as Permission };
}

/**
 * Whether the blocked-notifications banner has already had its run.
 *
 * Module scope, not storage: "once per session" here means once per loaded
 * page, which is exactly the lifetime of this module. `sessionStorage` would
 * buy nothing (a reload re-arms it either way, and the ban must not outlive a
 * permission the person then fixes) and can throw in a private window.
 */
let bannerRaisedThisSession = false;

/** Re-arms the once-per-session banner. Only for tests. @internal */
export function resetNotificationBannerForTests(): void {
  bannerRaisedThisSession = false;
}

/** What the watcher has to say for itself, rendered by `DesktopNotifications`. */
export interface DesktopNotificationsState {
  /** True while the "macOS is blocking notifications" banner should show. */
  blocked: boolean;
  /** Takes the banner down; it does not come back this session. */
  dismiss: () => void;
}

/**
 * Native notifications for the desktop shell, driven off the feed the app
 * already has.
 *
 * The web path is VAPID push through a service worker. Whether a webview has
 * `PushManager` is measured in `lib/notifications.ts` rather than assumed — an
 * earlier version of this comment asserted that neither WKWebView nor
 * WebKitGTK has it, and that turned out to be false. What holds regardless is
 * the reason this path exists: a tray-resident window must be able to say an
 * agent is waiting without depending on a push subscription at all.
 *
 * This needs no server work and no VAPID keys: the live feed already writes
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
 *
 * **It also reports when a notification did not happen** (spec 2026-09-14
 * §5.1). Declining the macOS prompt is one click and macOS never asks again,
 * after which this watcher went on firing into nothing and the app simply
 * stopped saying an agent was waiting. `desktop_notify` now answers
 * `{ shown, permission }`, so the failed act reports itself — this is the one
 * detection in the spec that needs no extra read.
 */
export function useDesktopNotifications(): DesktopNotificationsState {
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

  const [blocked, setBlocked] = useState(false);

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
      }).then((answer) => {
        const result = asNotifyResult(answer);
        // Only a DENIAL is worth a banner, and only one per session: the
        // watcher fires once per agent going idle, so raising it per call
        // would stack a strip for every agent on the machine. `shown: true`
        // says nothing happened worth reporting; a shell that does not
        // answer says nothing at all.
        if (!result || result.shown || result.permission !== "denied") return;
        if (bannerRaisedThisSession) return;
        bannerRaisedThisSession = true;
        setBlocked(true);
      });
    }
  }, [subshells, notifyEnabled]);

  // The session flag is already set by the time this can be called, so
  // dismissing is final for this page — the standing home for the recovery is
  // Preferences → Notifications, which says the same thing without expiring.
  const dismiss = useCallback(() => setBlocked(false), []);
  return { blocked, dismiss };
}
