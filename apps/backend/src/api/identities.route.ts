import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { assertImportablePublicJwk } from "@/api/public-jwk.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";

const RegisterIdentityBodySchema = t.Object({
  publicKey: t.String({
    minLength: 16,
    maxLength: 2048,
    description: "JSON-serialized JWK (P-256 ECDH-ES public key)",
  }),
  displayName: t.Optional(t.String({ maxLength: 120, description: "Convenience label (e.g. session name)" })),
});

const IdentityResponseSchema = t.Object({
  principalId: t.String({ description: "Principal label (sess:<id> | user:<id>)" }),
  publicKey: t.String({ description: "Stored JWK JSON" }),
  displayName: t.Nullable(t.String({ description: "Convenience label or null" })),
  registeredAt: t.String({ description: "ISO 8601 registration timestamp" }),
});

/**
 * Principal encryption identities. Registration is SELF-ONLY: the principal
 * is derived from the caller's credential (cookie → user:<id>, session token
 * → sess:<id>), so nobody can rotate anybody else's key. Re-registering the
 * same principal ROTATES the key (sealed delivery to old messages stops
 * working for that principal — by design, see spec §11).
 */
export const identityRoutes = new Elysia({ prefix: "/api/identities" })
  .use(authGuard)
  .post(
    "/",
    async ({ body, principal, ...ctx }) => {
      requirePerm(ctx, "channels", "write");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.publicKey);
      } catch {
        throw new HttpError(400, "publicKey must be a JSON JWK");
      }
      // Must be a P-256 PUBLIC key jose can IMPORT — a merely parseable
      // object would poison seal() for every co-member (see public-jwk.ts).
      await assertImportablePublicJwk(parsed);
      return await new IdentitiesRepository(db).register({
        principalId: principal,
        publicKey: body.publicKey,
        displayName: body.displayName ?? null,
      });
    },
    {
      body: RegisterIdentityBodySchema,
      response: IdentityResponseSchema,
      detail: {
        operationId: "registerIdentity",
        tags: ["identities"],
        description: "Registers or rotates the caller principal's encryption public key",
      },
    },
  )
  .get(
    "/:principalId",
    async (c) => {
      requirePerm(c, "channels", "read");
      const identity = await new IdentitiesRepository(db).findByPrincipal(c.params.principalId);
      if (!identity) throw new HttpError(404, "Identity not found");
      return identity;
    },
    {
      response: IdentityResponseSchema,
      detail: {
        operationId: "getIdentity",
        tags: ["identities"],
        description: "Fetches a principal's public key (senders need it to seal posts)",
      },
    },
  );
