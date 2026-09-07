import { apiFetch, apiPost } from "@/lib/api";

/**
 * Browser-push glue (spec 2026-08-30-harness-notifications).
 *
 * Everything the browser side needs: the VAPID key decode, the service-worker
 * registration (only ever from `enablePush` — nothing installs silently), the
 * PushSubscription round-trip and the backend `subscribe`/`unsubscribe`
 * bookkeeping. Every entry point feature-detects first and degrades to
 * `"unsupported"` when the browser (or the test environment) lacks the APIs,
 * so callers never have to try/catch for capability.
 */

/**
 * One-word summary of this device's push posture, as understood by the
 * Settings card.
 * - `"on"` — permission granted and a live subscription stored server-side
 * - `"off"` — push possible here, but not enabled on this device
 * - `"blocked"` — the user (or the OS) denied notifications for this site
 * - `"unsupported"` — no service worker / PushManager / Notification API
 * - `"unconfigured"` — the instance cannot issue a VAPID key
 */
export type PushState = "on" | "off" | "blocked" | "unsupported" | "unconfigured";

/** Shape of GET /api/notifications/config. */
type PushConfig = {
  /** VAPID public key (base64url); empty when `vapidConfigured` is false. */
  publicKey: string;
  /** False when the data directory cannot hold the instance's vapid.json. */
  vapidConfigured: boolean;
};

/**
 * The account-wide notification master switch (spec 2026-08-31). Off ⇒ the
 * user receives NO subshell pushes regardless of any per-subshell bell or
 * per-device subscription. Distinct from the per-device opt-in below: this is
 * one value shared across every device, stored in `user_meta`.
 */
export async function getMasterSwitch(): Promise<boolean> {
  const { notifyEnabled } = await apiFetch<{ notifyEnabled: boolean }>("/api/notifications/settings");
  return notifyEnabled;
}

/**
 * Sets the account-wide master switch and returns the persisted value (the
 * server echoes it, so the caller can trust the write rather than assume).
 * @param on - Whether this user should receive subshell pushes at all
 */
export async function setMasterSwitch(on: boolean): Promise<boolean> {
  const { notifyEnabled } = await apiFetch<{ notifyEnabled: boolean }>("/api/notifications/settings", {
    method: "PATCH",
    body: JSON.stringify({ notifyEnabled: on }),
  });
  return notifyEnabled;
}

/** True when this browser has the full SW + Push + Notification stack. */
function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Decodes a base64url string (the wire form of a VAPID public key) into the
 * raw bytes `pushManager.subscribe()` wants. Standard charmap helper: pad to
 * a multiple of 4, then map each character through the URL-safe alphabet
 * (`-` = 62, `_` = 63).
 * @param base64url - The unpadded or padded base64url string
 * @returns The decoded bytes
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Built over a fresh ArrayBuffer (not `Uint8Array.from`) so the result is a
  // `Uint8Array<ArrayBuffer>` — what `applicationServerKey`'s BufferSource wants.
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** POSTs what `/api/notifications/subscribe` wants from a PushSubscription. */
function subscriptionBody(sub: PushSubscription): { endpoint: string; p256dh: string; auth: string } {
  return {
    endpoint: sub.endpoint,
    p256dh: sub.toJSON().keys?.p256dh ?? "",
    auth: sub.toJSON().keys?.auth ?? "",
  };
}

/**
 * The full opt-in: read the instance's VAPID config, register `/sw.js`,
 * ask the browser for permission, subscribe, and store the subscription.
 * Stops at the first no — a refusal leaves nothing registered-or-stored
 * server-side beyond the (harmless) worker registration.
 * @returns The resulting push state for this device
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const config = await apiFetch<PushConfig>("/api/notifications/config");
  if (!config.vapidConfigured || !config.publicKey) return "unconfigured";
  const reg = await navigator.serviceWorker.register("/sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "blocked";
  // Force a RE-BIND: browsers hand back the EXISTING subscription from
  // subscribe() even when applicationServerKey has changed, so after a
  // server VAPID rotation the stale binding would 403 at the gateway
  // forever. Tear any old one down first — locally and server-side, the
  // disablePush teardown — so subscribe() mints a fresh binding against
  // the current key.
  const stale = await reg.pushManager.getSubscription();
  if (stale) {
    const { endpoint } = stale;
    await stale.unsubscribe();
    await apiPost("/api/notifications/unsubscribe", { endpoint });
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });
  await apiPost("/api/notifications/subscribe", subscriptionBody(sub));
  return "on";
}

/**
 * This device's current push posture — permission plus the presence of a
 * live PushSubscription, behind the instance's VAPID availability.
 * @returns The state to render
 */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const config = await apiFetch<PushConfig>("/api/notifications/config");
  if (!config.vapidConfigured || !config.publicKey) return "unconfigured";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/**
 * The full opt-out: tear the subscription down locally first, then ask the
 * backend to forget the endpoint. With no local subscription there is
 * nothing to forget, and `"off"` is already the truth.
 * @returns `"off"` (or `"unsupported"` on browsers without push)
 */
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const { endpoint } = sub;
    await sub.unsubscribe();
    await apiPost("/api/notifications/unsubscribe", { endpoint });
  }
  return "off";
}
