import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { MoteClient } from "@/lib/api";
import { PUSH_TOKEN_KEY } from "@/native/push-token";

/**
 * Native push wiring (spec §Push). The relay payload is opaque by backend
 * contract (invariant 6) — nothing here can name a session either: the tap
 * handler routes on the sid uuid and the app fetches detail with its own
 * authenticated session.
 */

const CHANNEL_ID = "mote-sessions";

/** Foreground presentation: banners only, no sound storm over the 3 s poll. */
export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true, // badge rides the payload's waiting count (spec §Push)
    }),
  });
  if (Platform.OS === "android") {
    void Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Sessions",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  // Lock-screen actions (spec §Decisions): Open · Silence bell. Nothing
  // destructive is reachable from a locked screen; both require the device
  // unlock, matching the app's own "gate USE of the token" posture.
  void Notifications.setNotificationCategoryAsync("session", [
    {
      identifier: "open",
      buttonTitle: "Open",
      options: { opensAppToForeground: true, isAuthenticationRequired: true },
    },
    {
      identifier: "silence",
      buttonTitle: "Silence bell",
      options: { opensAppToForeground: false, isAuthenticationRequired: true },
    },
  ]);
}

/**
 * Enroll on cold start and after sign-in (spec: enrollment upserts on every
 * cold start so token churn stays bounded). Best-effort: an unreachable
 * instance must never block app start.
 * @returns The enrolled token, or null when permission/device/relay refused.
 */
export async function enrollPush(client: MoteClient): Promise<string | null> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    const perm = cur.granted ? cur : await Notifications.requestPermissionsAsync();
    if (!perm.granted) return null;
    const { data } = await Notifications.getExpoPushTokenAsync();
    await client.enrollDevice(data, Platform.OS === "ios" ? "ios" : "android");
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, data);
    return data;
  } catch {
    return null;
  }
}
