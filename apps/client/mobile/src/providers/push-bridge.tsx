import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { SUBSHELLS_KEY } from "@/hooks/query-keys";
import { useIconBadge } from "@/hooks/use-icon-badge";
import { useApp } from "@/lib/app-state";
import type { SubshellNotifData } from "@/lib/notif-data";
import { decidePushAction } from "@/lib/push-routing";
import { configureNotifications, enrollPush } from "@/native/push";
import { clientForOrigin } from "@/native/subshell-client-factory";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * Notification lifecycle in one place (rendered by the root layout, mounted
 * as soon as the app is up):
 * - categories + presentation handler once at start,
 * - enrollment whenever a client exists (cold start AND after sign-in —
 *   spec: enrollment upserts on every cold start so token churn is bounded),
 * - app-icon badge = the polled waiting count while foregrounded
 *   (`useIconBadge`; pushes only stamp it at send time),
 * - response routing: the payload's `origin` selects the INSTANCE (spec
 *   §Push: a push for a subshell on B must open B, not the instance you last
 *   used) — tap switches active instance and routes to `/subshell/<sid>` (the
 *   route itself is the biometric gate, §Security notes), "Silence bell" →
 *   one PATCH against the ORIGIN's client + list refresh, without
 *   foregrounding. An origin this phone no longer knows (forgotten instance)
 *   is ignored rather than opened on the wrong server. A `grant_approval`
 *   push switches instances the same way but lands on the settings tab, and
 *   its Silence action is ignored (its sid names a grant request, not a pane;
 *   PR 338 review, Important 1).
 *
 * The response listener mounts ONCE and reads the registry via
 * `useApp.getState()` at call time: an earlier version kept activeId/instances
 * in the deps, so `setActive(origin)` re-ran the effect mid-response and the
 * cold-start `getLastNotificationResponseAsync()` replayed the tap a second
 * time (review, efficiency #3).
 */
export function PushBridge() {
  const { client } = useSubshell();
  const qc = useQueryClient();
  useIconBadge(); // icon = waiting count while foregrounded (spec §Push)

  useEffect(() => {
    configureNotifications();
  }, []);

  useEffect(() => {
    if (!client) return;
    void enrollPush(client);
  }, [client]);

  useEffect(() => {
    const respond = async (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as SubshellNotifData;
      if (!data?.sid) return;
      const { activeId, instances, setActive } = useApp.getState();
      const origin = data.origin && data.origin !== activeId ? data.origin : null;
      if (origin && !instances.some((i) => i.id === origin)) return; // unknown/forgotten instance
      // The helper decides (pure, pinned in src/lib/push-routing.ts); this
      // closure only performs. A `grant_approval` push routes to settings and
      // ignores the Silence bell: its sid is a grant request, not a pane.
      const action = decidePushAction(data, response.actionIdentifier);
      if (action.action === "ignore") return;
      // The action belongs to the ORIGIN's instance, whatever is active now.
      const actor = origin ? clientForOrigin(origin) : client;
      if (action.action === "silence") {
        // Background action: one quick PATCH; the app never opens.
        if (!actor) return;
        try {
          await actor.setNotify(action.sid, false);
          await qc.invalidateQueries({ queryKey: SUBSHELLS_KEY });
        } catch {
          /* signed-out mid-flight: the bell state re-converges on next open */
        }
        return;
      }
      if (origin) setActive(origin); // provider clears the query cache on switch
      router.push(action.href);
    };
    const sub = Notifications.addNotificationResponseReceivedListener((r) => void respond(r));
    // Cold start from a notification tap must route too, not just live taps.
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (r) void respond(r);
    });
    return () => sub.remove();
  }, [client, qc]);

  return null;
}
