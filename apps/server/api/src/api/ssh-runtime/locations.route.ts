import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { runtimeCall } from "@/api/ssh-runtime/sessions.route.js";
import {
  connectLocation,
  savedLocationsRepository,
  saveLocation,
} from "@/services/ssh-runtime/saved-locations.service.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh-runtime/ssh-actor.js";

const HUMAN_ONLY = "Saved SSH locations require a signed-in person.";
export const sshSavedLocationsRoutes = new Elysia({ prefix: "/locations" })
  .use(authGuard)
  .get("/", async ({ user, actor }) => {
    requireCookieActor(actor, HUMAN_ONLY);
    return { locations: await savedLocationsRepository.list(user.id) };
  })
  .post(
    "/",
    async ({ user, actor, body, request }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      assertCookieWriteOrigin(actor, request);
      return await runtimeCall(() => saveLocation(user.id, body.sessionId, body.path));
    },
    { body: t.Object({ sessionId: t.String(), path: t.String({ maxLength: 4096 }) }) },
  )
  .delete("/:id", async ({ user, actor, params, request }) => {
    requireCookieActor(actor, HUMAN_ONLY);
    assertCookieWriteOrigin(actor, request);
    await savedLocationsRepository.delete(params.id, user.id);
    return { ok: true };
  })
  .post("/:id/connect", async (guard) => {
    requireCookieActor(guard.actor, HUMAN_ONLY);
    assertCookieWriteOrigin(guard.actor, guard.request);
    const caller = await buildSshCaller(guard);
    return await runtimeCall(() => connectLocation(caller, guard.params.id));
  });
