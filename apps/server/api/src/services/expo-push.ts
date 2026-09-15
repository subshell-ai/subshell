import { Expo, type ExpoPushTicket, type ExpoPushMessage as SdkPushMessage } from "expo-server-sdk";
import { APP_BASE_URL } from "@/constants.js";
import type { NotifyKind } from "@/services/notify.service.js";

/**
 * Native push over the Expo relay (spec 2026-08-31-mobile-native-app §Push).
 *
 * PRIVACY CONTRACT (spec invariant 6) — nothing crossing exp.host may name
 * anything: `to` is the device token, `title` is the constant "subshell", `body`
 * comes from KIND_COPY, plus an integer badge, the subshell UUID and the
 * kind. A subshell name, working directory, note or operator text in a
 * constructed message is a spec violation, caught by test.
 */

/** One native push message as this service builds and sends it. */
export interface ExpoPushMessage {
  /** Single device token (batching happens in `chunk`, never via to[]) */
  to: string;
  /** Constant app name — never the subshell name (privacy contract). */
  title: string;
  /** Generic copy for the kind — the only human-readable text. */
  body: string;
  /** App-icon badge: this user's waiting count at send time. */
  badge: number;
  /** Always the OS default sound (custom sounds are a follow-up). */
  sound: "default";
  /** Groups the conversation (iOS thread); NOT the replace mechanism. */
  threadId: string;
  /**
   * Android notification tag — the relay passes it through to the FCM data
   * payload and it is the CLIENT (expo-notifications `FirebaseMessaging
   * Delegate`/`ExpoPresentationDelegate`, checked at 57.0.15) that uses it as
   * the notification identifier, so a second push for the same subshell
   * REPLACES the first in the tray. This is the web-`tag` parity the spec
   * asks for; `threadId` alone only groups.
   */
  tag: string;
  /** iOS APNs collapse id — the same replace semantics on the other platform. */
  collapseId: string;
  /**
   * The category the app registers its lock-screen actions under (APns
   * `category`). Remote notifications only surface a registered category's
   * actions when the payload names it — omit this and Open/Silence never
   * appear on the lock screen.
   */
  categoryId: string;
  /**
   * Android channel, sent under BOTH names: `channelId` is current (docs +
   * expo-server-sdk 7.2), `_channelId` is the legacy name older relays honour.
   * The relay's schema is open (proved against exp.host: unknown keys are
   * tolerated, bad types are rejected at ticket time), so it silently ignores
   * whichever one it no longer reads — and the two values are identical, so
   * whichever wins cannot contradict the other.
   * TODO(cleanup): one release after the first device delivery is confirmed,
   * drop `_channelId` — a hedge kept forever becomes folklore (review, #7).
   */
  channelId: string;
  /** @deprecated Legacy twin of `channelId` — see above; same value always. */
  _channelId: string;
  /** Opaque routing data; `sid` is a uuid, `origin` lets the app pick the instance. */
  data: { sid: string; kind: NotifyKind; origin: string };
}

/**
 * Generic lock-screen copy. "needs you" vs "crashed" is the difference
 * between a glance and a sprint — and it names nothing.
 */
const KIND_COPY: Record<NotifyKind, string> = {
  turn_complete: "A subshell needs you",
  needs_attention: "A subshell needs you",
  exited: "A subshell exited",
  crashed: "A subshell crashed, auto-restarting",
  crashed_final: "A subshell crashed",
  maintenance: "A subshell was stopped for node maintenance",
};

/**
 * Badge number at send time: the owner's waiting count, plus 1 when THIS
 * event will put the subshell into waiting but the row is not stamped yet.
 * The two call paths stamp in opposite orders — `recordAttention` stamps
 * BEFORE notifying (`subshells.service.ts`), the idle watcher notifies THEN
 * stamps (`notify-idle.ts`) — so without the +1 a watcher-fired push badges
 * one short. Deliberate; unit-pinned; do not "simplify".
 * @param waiting - The owner's current waiting count (from the summary query)
 * @param kind - The event being delivered
 * @param waitingSince - The subject row's stamp at send time (null = not stamped)
 */
export function badgeCount(waiting: number, kind: NotifyKind, waitingSince: string | null): number {
  const makesWait = (kind === "turn_complete" || kind === "needs_attention") && waitingSince === null;
  return waiting + (makesWait ? 1 : 0);
}

/** Real Expo token shape; junk rows are pruned rather than sent to. */
const TOKEN_RE = /^ExponentPushToken\[[A-Za-z0-9_-]{1,128}\]$/;

/** @param token - Stored device token @returns Whether it can be a relay token */
export function looksLikeExpoToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * Builds one message per token. Receives ids and counts, never names —
 * the privacy contract is enforced by this signature.
 * @param tokens - Live device tokens (already filtered by looksLikeExpoToken)
 * @param subshellId - The subshell the event is about (opaque uuid)
 * @param kind - Event class for the generic copy
 * @param badge - Final badge number (see badgeCount)
 */
export function buildExpoMessages(
  tokens: readonly string[],
  subshellId: string,
  kind: NotifyKind,
  badge: number,
): ExpoPushMessage[] {
  return tokens.map((to) => ({
    to,
    title: "subshell",
    body: KIND_COPY[kind],
    badge,
    sound: "default" as const,
    threadId: subshellId,
    tag: subshellId,
    collapseId: subshellId,
    // Names registered in apps/client/mobile/src/native/push.ts — keep the three in
    // sync or the lock-screen actions silently vanish on real devices.
    categoryId: "subshell",
    channelId: "subshell-subshells",
    _channelId: "subshell-subshells",
    data: { sid: subshellId, kind, origin: APP_BASE_URL },
  }));
}

/**
 * True when the relay says the device is gone for good → prune the row.
 * Every other error class (`MessageTooBig` = our bug, `ProviderError` =
 * upstream) keeps the row, matching the web-push prune contract.
 * @param ticket - One ticket from the relay (zipped against messages by index)
 */
export function isUnregisteredTicket(ticket: ExpoPushTicket): boolean {
  return (
    ticket.status === "error" && (ticket as { details?: { error?: string } }).details?.error === "DeviceNotRegistered"
  );
}

/**
 * Batches at `size` (Expo's documented limit is 100 messages per request;
 * the pure helper is the >100-token pin from the spec's test list).
 */
export function chunk<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Function seam over the Expo push API so tests inject a fake (the sibling
 * of `PushSender` in notify.service). CONTRACT: returns one ticket per
 * message, in order — `notifySubshell` zips tickets against messages by
 * index to prune DeviceNotRegistered rows. A thrown error (transport
 * exception) is transient BY CONTRACT: every row survives.
 */
export type ExpoPushSender = (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;

let client: Expo | null = null;

/** Lazy singleton — constructed on the first real send, never in tests. */
function expoClient(): Expo {
  // EXPO_PUSH_ACCESS_TOKEN when proof-of-ownership is enforced; anonymous
  // sends to exp.host are rate-limited (spec §Infra prerequisites).
  client ??= new Expo({ accessToken: process.env.EXPO_PUSH_ACCESS_TOKEN || undefined });
  return client;
}

/** The production sender: chunk at 100, concatenate tickets in order. */
export function createExpoPushSender(): ExpoPushSender {
  return async (messages) => {
    const tickets: ExpoPushTicket[] = [];
    for (const part of chunk(messages)) {
      const res = await expoClient().sendPushNotificationsAsync(part as unknown as SdkPushMessage[]);
      tickets.push(...res);
    }
    return tickets;
  };
}
