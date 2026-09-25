import { Elysia, t } from "elysia";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { asProviderKind } from "@/db/types/auth-providers.db-types.js";
import { resolveInstanceName } from "@/services/instance-name.js";

/** One sign-in provider the login page may paint a button for. */
const InstanceProviderSchema = t.Object({
  id: t.String({ description: "Provider id — the provider's row id, carried through the OAuth round trip" }),
  name: t.String({ description: "Admin-chosen display name, rendered on the sign-in button" }),
  kind: t.Union([t.Literal("google"), t.Literal("oidc")], {
    description:
      "Provider kind. Only sign-in providers are listed; the E-mail provider answers through emailSignIn instead",
  }),
});

const InstanceSettingsSchema = t.Object({
  instanceName: t.String({
    description: "Operator-chosen display name for this control plane, or the host's own name when unset",
  }),
  providers: t.Array(InstanceProviderSchema, {
    description:
      "Sign-in providers a stranger may use: enabled with sign-in enabled, ordered by the admin's arrangement. Deliberately excludes the E-mail provider and every closed one (spec 2026-09-24 §7)",
  }),
  emailSignIn: t.Boolean({
    description:
      "Whether the password form may render. True when the E-mail provider is open, and true when its row answers nothing — a seed that failed must never hide the way in",
  }),
});

/**
 * `GET /api/settings/instance` — this instance's name and the providers its
 * sign-in page should paint, to an UNAUTHENTICATED caller (spec 2026-09-08;
 * providers since spec 2026-09-24 §7 — the login page cannot ask which
 * buttons exist AFTER it asked for a password).
 *
 * **Its own module, deliberately outside `settingsRoutes`.** `authGuard` is a
 * scoped plugin applied to that whole instance, so a public route is one that
 * does not `.use()` it — the pattern the setup endpoints already follow.
 * Keeping the split at the module boundary rather than as an exemption inside
 * the guarded group is what stops `viewerIsAdmin`, `appBaseUrl` and
 * `nodeArtifactTargets` from going anonymous the next time somebody adds a
 * field to the public payload.
 *
 * **This is a deliberate pre-auth disclosure** of one operator-chosen string
 * and the provider list, the first outside the first-run setup window. Sound on
 * the trusted-network posture, and useful rather than merely tolerable:
 * knowing which plane is asking for your password is a security property, and
 * so is seeing which providers are open before choosing one. What the provider list
 * carries is id, name and kind — never issuer, client id, or any secret.
 * Recorded in `docs/security.md`.
 *
 * **Not folded into the already-anonymous `GET /api/setup/status`**, which
 * every page including login already fetches: `__root.tsx` caches that with an
 * infinite stale time because `needsSetup` is true exactly once in an
 * instance's life, and a MUTABLE name must not inherit that cache.
 */
export const instancePublicRoutes = new Elysia({ prefix: "/api/settings" }).get(
  "/instance",
  async () => {
    const providers = new AuthProvidersRepository(db);
    const rows = await providers.listAll();
    const emailRow = await providers.getById("email");
    return {
      instanceName: await resolveInstanceName(db),
      // `listAll` is already position-ordered — the admin's arrangement of the
      // providers is the order the buttons wear. The `email` kind can never
      // reach the list: it is the password form, not a button.
      providers: rows.flatMap((row) => {
        // `asProviderKind` falls back to "oidc" for a value outside the
        // union, so a hand-edited `kind` column still renders as an oidc
        // provider on this anonymous surface rather than arbitrary text — the
        // same fail-safe the type's docstring documents for every reader.
        const kind = asProviderKind(row.kind);
        return kind !== "email" && row.enabled === 1 && row.signInEnabled === 1
          ? [{ id: row.id, name: row.name, kind }]
          : [];
      }),
      // Absent row ⇒ open. The seed is migration 0037's; if it failed, the
      // password form still renders rather than the instance locking its
      // humans out of sight (§7).
      emailSignIn: emailRow ? emailRow.enabled === 1 && emailRow.signInEnabled === 1 : true,
    } as const;
  },
  {
    response: InstanceSettingsSchema,
    detail: {
      operationId: "getInstanceSettings",
      tags: ["settings"],
      description:
        "This control plane's display name, its open sign-in providers, and whether the E-mail form may render (no credential required)",
    },
  },
);
