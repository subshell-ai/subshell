import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { SubshellClient } from "@/lib/api";
import { PUSH_TOKEN_KEY } from "@/native/push-token";

/**
 * Native push wiring (spec §Push). The relay payload is opaque by backend
 * contract (invariant 6) — nothing here can name a subshell either: the tap
 * handler routes on the sid uuid and the app fetches detail with its own
 * authenticated session.
 */

const CHANNEL_ID = "subshell-subshells";

/** Foreground presentation: banners only, no sound storm over the 3 s poll. */
export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      // false ON PURPOSE (review, Important #2): this handler only runs while
      // foregrounded, and while foregrounded `useIconBadge` owns the icon from
      // the polled waiting count. A foreground push for a NON-active instance
      // would otherwise stamp that instance's send-time count and nothing
      // would ever correct it (the active instance's poll never changed).
      // Background delivery applies aps.badge at the OS level regardless.
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    void Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Subshells",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  // Lock-screen actions (spec §Decisions): Open · Silence bell. Nothing
  // destructive is reachable from a locked screen; both require the device
  // unlock, matching the app's own "gate USE of the token" posture.
  void Notifications.setNotificationCategoryAsync("subshell", [
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
export async function enrollPush(client: SubshellClient): Promise<string | null> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    const perm = cur.granted ? cur : await Notifications.requestPermissionsAsync();
    if (!perm.granted) return null;
    const { data } = await Notifications.getExpoPushTokenAsync();
    await client.enrollDevice(data, Platform.OS === "ios" ? "ios" : "android");
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, data);
    return data;
  } catch (err) {
    // This catch also swallows an unreachable instance (enrollDevice) and
    // AsyncStorage faults — keep the message generic (review, #4). The most
    // common cause by far: a plain `expo run:android` dev build has no
    // google-services.json, so getExpoPushTokenAsync throws ("Default
    // FirebaseApp is not initialized") and enrollment no-ops on every start;
    // deliverable builds get the FCM config from EAS (see AGENTS.md).
    console.warn("push enrollment failed", err);
    return null;
  }
}

/**
 * App-icon badge: iOS is exact, Android is launcher best-effort (spec lists
 * Android badge channels as a non-goal). Never throws — a launcher that
 * refuses the number must not take down the reconciliation loop.
 */
export async function setIconBadge(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {
    /* badge-less launcher; the tab-bar badge still tells the truth */
  }
}

/**
 * Best-effort server-side deregistration of this phone, then the local mirror
 * is dropped (spec §Push prune contract's operator-facing twin). Used by both
 * sign-out and Forget-instance — a phone must stop ringing for anything the
 * operator just untrusted (review #4: each call site hand-rolled this dance).
 * Never throws: a dead instance must not block a local sign-out.
 */
export async function deregisterPush(client: SubshellClient): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (!token) return;
    await client.forgetDevice(token);
    await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
  } catch {
    /* best effort — the enrollment mirror re-converges on the next cold start */
  }
}
