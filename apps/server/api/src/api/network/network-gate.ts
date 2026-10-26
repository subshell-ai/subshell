import { resolveSetupActor } from "@/api/setup.route.js";
import { ForbiddenError } from "@/shared/errors.js";

/**
 * The gate on EVERY route here: an admin COOKIE session, with no no-users
 * carve-out.
 *
 * `resolveSetupActor` rather than `requireAdmin` for the same reason the two
 * installer routes use it — it classifies the credential without mounting a
 * guard, so one call answers "anonymous" (401) and "a machine credential or a
 * plain user" (403) alike. Bearer keys are refused even when the key's owner
 * is an admin: these routes join this machine to a network and rewrite its
 * config, which has no machine consumer.
 *
 * The rest of `/api/setup` is public while the instance has no users, because
 * the wizard runs before an admin exists. This is deliberately NOT — the
 * wizard's network step sits after Create Your Account for exactly this
 * reason.
 */
export async function requireNetworkAdmin(request: Request): Promise<void> {
  if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
}
