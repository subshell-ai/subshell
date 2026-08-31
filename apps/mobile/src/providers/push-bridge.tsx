import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { SESSIONS_KEY } from "@/hooks/query-keys";
import { useApp } from "@/lib/app-state";
import type { SessionNotifData } from "@/lib/notif-data";
import { clientForOrigin } from "@/native/mote-client-factory";
import { configureNotifications, enrollPush } from "@/native/push";
import { useMote } from "@/providers/mote-provider";

/**
 * Notification lifecycle in one place (rendered by the root layout, mounted
 * as soon as the app is up):
 * - categories + presentation handler once at start,
 * - enrollment whenever a client exists (cold start AND after sign-in —
 *   spec: enrollment upserts on every cold start so token churn is bounded),
 * - response routing: the payload's `origin` selects the INSTANCE (spec
 *   §Push: a push for a session on B must open B, not the instance you last
 *   used) — tap switches active instance and routes to `/session/<sid>` (the
 *   route itself is the biometric gate, §Security notes), "Silence bell" →
 *   one PATCH against the ORIGIN's client + list refresh, without
 *   foregrounding. An origin this phone no longer knows (forgotten instance)
 *   is ignored rather than opened on the wrong server.
 *
 * The response listener mounts ONCE and reads the registry via
 * `useApp.getState()` at call time: an earlier version kept activeId/instances
 * in the deps, so `setActive(origin)` re-ran the effect mid-response and the
 * cold-start `getLastNotificationResponseAsync()` replayed the tap a second
 * time (review, efficiency #3).
 */
export function PushBridge() {
  const { client } = useMote();
  const qc = useQueryClient();

  useEffect(() => {
    configureNotifications();
  }, []);

  useEffect(() => {
    if (!client) return;
    void enrollPush(client);
  }, [client]);

  useEffect(() => {
    const respond = async (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as SessionNotifData;
      if (!data?.sid) return;
      const { activeId, instances, setActive } = useApp.getState();
      const origin = data.origin && data.origin !== activeId ? data.origin : null;
      if (origin && !instances.some((i) => i.id === origin)) return; // unknown/forgotten instance
      // The action belongs to the ORIGIN's instance, whatever is active now.
      const actor = origin ? clientForOrigin(origin) : client;
      if (response.actionIdentifier === "silence") {
        // Background action: one quick PATCH; the app never opens.
        if (!actor) return;
        try {
          await actor.setNotify(data.sid, false);
          await qc.invalidateQueries({ queryKey: SESSIONS_KEY });
        } catch {
          /* signed-out mid-flight: the bell state re-converges on next open */
        }
        return;
      }
      if (origin) setActive(origin); // provider clears the query cache on switch
      router.push(`/session/${encodeURIComponent(data.sid)}`);
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
