import { Elysia, t } from "elysia";
import type { GuardActor } from "@/api/auth-guard.js";
import { authGuard, HttpError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { apiModels } from "@/schema/index.js";
import { getNotifyService } from "@/services/notify.service.js";
import { logger } from "@/utils/logger.js";

/**
 * Per-device Web Push subscriptions (spec 2026-08-30-harness-notifications).
 *
 * Cookie-only like the files routes: enabling push on a device is a
 * human-in-the-browser act; machine credentials get 403. Whether any
 * notification is ever SENT is decided per session by `sessions.notify`,
 * checked at send time — this route is plumbing, not policy.
 */

const SubscribeBodySchema = t.Object({
  endpoint: t.String({
    minLength: 10,
    maxLength: 4096,
    description: "Push endpoint URL from pushManager.subscribe()",
  }),
  p256dh: t.String({ minLength: 10, maxLength: 256, description: "P-256 ECDH public key (base64url)" }),
  auth: t.String({ minLength: 5, maxLength: 256, description: "Auth secret (base64url)" }),
});

const UnsubscribeBodySchema = t.Object({
  endpoint: t.String({ minLength: 10, maxLength: 4096, description: "Endpoint to forget" }),
});

const ConfigResponseSchema = t.Object({
  publicKey: t.String({ description: "VAPID public key ('' when unconfigured)" }),
  vapidConfigured: t.Boolean({ description: "False when the data dir cannot hold vapid.json" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/** Throws 403 unless the request authenticated through a browser session cookie. */
function browserOnly(actor: GuardActor): void {
  if (actor !== "cookie") throw new HttpError(403, "Notifications are restricted to browser sessions");
}

/**
 * Probes the VAPID public key (the same source `/config` degrades on) and
 * throws 503 when this instance cannot hold push keys — the spec's "not
 * configured on this instance" state. Guards ENROLLMENT only: subscribe must
 * refuse rather than store a subscription that could never be sent to, while
 * unsubscribe stays usable so users can clean up after a config regression.
 */
async function requireVapidConfigured(): Promise<void> {
  try {
    await getNotifyService().vapidPublicKey();
  } catch (err) {
    // Same posture as the /config probe: an unconfigured instance is a
    // normal state, but the underlying failure is still worth a log line.
    logger.withError(err).warn("push subscribe refused — VAPID unconfigured");
    throw new HttpError(503, "Push notifications are not configured on this instance");
  }
}

export const notificationsRoutes = new Elysia({ prefix: "/api/notifications" })
  .use(authGuard)
  .use(apiModels)
  .get(
    "/config",
    async ({ actor }) => {
      browserOnly(actor);
      try {
        return { publicKey: await getNotifyService().vapidPublicKey(), vapidConfigured: true };
      } catch (err) {
        // The probe must never 500 — an unconfigured instance is a normal
        // state the frontend handles — but a real failure (bad key file,
        // unwritable dir) must not vanish silently, so log before reporting.
        logger.withError(err).warn("vapid public key probe failed");
        return { publicKey: "", vapidConfigured: false };
      }
    },
    {
      response: { 200: ConfigResponseSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "notificationsConfig",
        tags: ["notifications"],
        description: "VAPID public key (browser sessions only)",
      },
    },
  )
  .post(
    "/subscribe",
    async ({ body, user, actor }) => {
      browserOnly(actor);
      await requireVapidConfigured();
      await new NotificationsRepository(db).upsertForUser(user.id, body.endpoint, body.p256dh, body.auth);
      return { ok: true } as const;
    },
    {
      body: SubscribeBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        503: "ApiErrorResponse",
      },
      detail: {
        operationId: "subscribePush",
        tags: ["notifications"],
        description: "Store this browser's push subscription",
      },
    },
  )
  .post(
    "/unsubscribe",
    async ({ body, user, actor }) => {
      browserOnly(actor);
      await new NotificationsRepository(db).deleteForUser(user.id, body.endpoint);
      return { ok: true } as const;
    },
    {
      body: UnsubscribeBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "unsubscribePush",
        tags: ["notifications"],
        description: "Forget this browser's push subscription",
      },
    },
  );
