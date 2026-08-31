import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { useApp } from "@/lib/app-state";
import type { SessionNotifData } from "@/lib/notif-data";
import { configureNotifications, enrollPush } from "@/native/push";
import { useMote } from "@/providers/mote-provider";

/**
 * Notification lifecycle in one place (rendered by the root layout, mounted
 * as soon as the app is up):
 * - categories + presentation handler once at start,
 * - enrollment whenever a client exists (cold start AND after sign-in —
 *   spec: enrollment upserts on every cold start so token churn is bounded),
 * - response routing: tap → `/session/<sid>` (the route itself is the
 *   biometric gate, spec §Security notes), "Silence bell" → one PATCH +
 *   list refresh, without foregrounding.
 */
export function PushBridge() {
  const { client } = useMote();
  const _activeId = useApp((s) => s.activeId);
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
      if (response.actionIdentifier === "silence") {
        // Background action: one quick PATCH; the app never opens.
        if (!client) return;
        try {
          await client.setNotify(data.sid, false);
          await qc.invalidateQueries({ queryKey: ["sessions"] });
        } catch {
          /* signed-out mid-flight: the bell state re-converges on next open */
        }
        return;
      }
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
