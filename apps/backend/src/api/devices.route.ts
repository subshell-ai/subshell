import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { apiModels } from "@/schema/index.js";

// One policy string for both verbs — the notifications route does the same with
// NOTIFICATIONS_403 so the wire bytes can't drift per endpoint.
const DEVICES_403 = "Device enrollment is restricted to browser subshells";

/**
 * Native-device push enrollment (spec 2026-08-31-mobile-native-app §Backend
 * diff). Cookie-only like `notifications.route.ts`: enrolling a phone is a
 * human-in-the-device act, so machine credentials get 403. Deliberately NOT
 * gated on VAPID — the Expo transport is independent, and an instance with a
 * broken `vapid.json` must still be able to reach phones.
 */

const EnrollBodySchema = t.Object({
  token: t.String({
    minLength: 10,
    maxLength: 256,
    description: "Expo push token (ExponentPushToken[...])",
  }),
  platform: t.Union([t.Literal("ios"), t.Literal("android")], {
    description: "OS the token was minted on",
  }),
});

const ForgetBodySchema = t.Object({
  token: t.String({ minLength: 10, maxLength: 256, description: "Token to forget" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

export const devicesRoutes = new Elysia({ prefix: "/api/devices" })
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, DEVICES_403);
      await new DeviceTokensRepository(db).upsertForUser(user.id, body.token, body.platform);
      return { ok: true } as const;
    },
    {
      body: EnrollBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "enrollDevice",
        tags: ["devices"],
        description: "Store this device's Expo push token (session cookies only)",
      },
    },
  )
  .delete(
    "/",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, DEVICES_403);
      // Owner-scoped and idempotent: sign-out deregistration must succeed even
      // if the row is already gone (pruned by a DeviceNotRegistered ticket).
      await new DeviceTokensRepository(db).deleteForUser(user.id, body.token);
      return { ok: true } as const;
    },
    {
      body: ForgetBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "forgetDevice",
        tags: ["devices"],
        description: "Forget a device token (session cookies only, idempotent)",
      },
    },
  );
