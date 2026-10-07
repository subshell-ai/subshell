import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { listDesktopBrokers, pairDesktopBroker, revokeDesktopBroker } from "@/services/ssh-runtime/desktop-broker.js";
import { assertCookieWriteOrigin } from "@/services/ssh-runtime/ssh-actor.js";

export const desktopBrokerRoutes = new Elysia()
  .use(authGuard)
  .get("/desktop-brokers", async ({ user, actor }) => {
    requireCookieActor(actor, "Desktop SSH brokers require a signed-in person.");
    return await listDesktopBrokers(user.id);
  })
  .post(
    "/desktop-brokers",
    async ({ user, actor, request, body }) => {
      requireCookieActor(actor, "Desktop SSH brokers require a signed-in person.");
      assertCookieWriteOrigin(actor, request);
      return await pairDesktopBroker(user.id, body);
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 60, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
        id: t.Optional(t.String()),
      }),
    },
  )
  .delete("/desktop-brokers/:id", async ({ user, actor, request, params }) => {
    requireCookieActor(actor, "Desktop SSH brokers require a signed-in person.");
    assertCookieWriteOrigin(actor, request);
    await revokeDesktopBroker(user.id, params.id);
    return { ok: true };
  });
