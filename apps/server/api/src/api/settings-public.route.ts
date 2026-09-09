import { Elysia, t } from "elysia";
import { db } from "@/db/index.js";
import { resolveInstanceName } from "@/services/instance-name.js";

const InstanceNameSchema = t.Object({
  instanceName: t.String({
    description: "Operator-chosen display name for this control plane, or the host's own name when unset",
  }),
});

/**
 * `GET /api/settings/instance` — this instance's display name, to an
 * UNAUTHENTICATED caller, so the sign-in page can say what you are about to
 * authenticate against (spec 2026-09-08).
 *
 * **Its own module, deliberately outside `settingsRoutes`.** `authGuard` is a
 * scoped plugin applied to that whole instance, so a public route is one that
 * does not `.use()` it — the pattern the setup endpoints already follow.
 * Keeping the split at the module boundary rather than as an exemption inside
 * the guarded group is what stops `viewerIsAdmin`, `appBaseUrl` and
 * `nodeArtifactTargets` from going anonymous the next time somebody adds a
 * field to the public payload.
 *
 * **This is a deliberate pre-auth disclosure** of one operator-chosen string,
 * the first outside the first-run setup window. Sound on the trusted-network
 * posture, and useful rather than merely tolerable: knowing which plane is
 * asking for your password is a security property. Recorded in
 * `docs/security.md`.
 *
 * **Not folded into the already-anonymous `GET /api/setup/status`**, which
 * every page including login already fetches: `__root.tsx` caches that with an
 * infinite stale time because `needsSetup` is true exactly once in an
 * instance's life, and a MUTABLE name must not inherit that cache.
 */
export const instancePublicRoutes = new Elysia({ prefix: "/api/settings" }).get(
  "/instance",
  async () => ({ instanceName: await resolveInstanceName(db) }) as const,
  {
    response: InstanceNameSchema,
    detail: {
      operationId: "getInstanceName",
      tags: ["settings"],
      description: "This control plane's display name (no credential required)",
    },
  },
);
