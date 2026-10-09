import { fingerprintJwk } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { HttpError, requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { audit } from "@/services/audit.js";
import {
  ensureLocalRelayIdentity,
  localRelayIdentityDir,
  readLocalRelayIdentity,
  resetLocalRelayIdentity,
} from "@/services/ssh-local-identity.js";
import { getRelayBroker, SshRelayRefusal } from "@/services/ssh-relay.service.js";

const FingerprintsSchema = t.Object({
  signing: t.String({ description: "Verified server relay signing fingerprint" }),
  encryption: t.String({ description: "Verified server relay encryption fingerprint" }),
});

/** Admin-only recovery of the server's registered identity. Peer trust pins remain strict and require separate repair. */
export const localSshIdentityRoute = new Elysia()
  .use(requireAdmin)
  .get(
    "/local/ssh-identity",
    async () => {
      // First-use initialization is safe; a mismatched registration stays refused,
      // while inspection must still show the disk fingerprints needed for explicit recovery.
      await ensureLocalRelayIdentity().catch(() => undefined);
      const identity = await readLocalRelayIdentity(localRelayIdentityDir());
      const registered = await new IdentitiesRepository(db).findByPrincipal("node:local");
      return {
        own: {
          signing: await fingerprintJwk(identity.signingPublicJwk),
          encryption: await fingerprintJwk(identity.publicJwk),
        },
        registered: registered?.signingPublicKey
          ? {
              signing: await fingerprintJwk(registered.signingPublicKey),
              encryption: await fingerprintJwk(registered.publicKey),
            }
          : null,
        matches:
          registered?.publicKey === identity.publicJwk && registered.signingPublicKey === identity.signingPublicJwk,
      };
    },
    {
      response: t.Object({
        own: FingerprintsSchema,
        registered: t.Nullable(FingerprintsSchema, {
          description: "Currently registered public fingerprints, or null",
        }),
        matches: t.Boolean({ description: "Whether both stored public keys agree with the server identity file" }),
      }),
    },
  )
  .post(
    "/local/ssh-identity/repair",
    async ({ body, user }) => {
      const identity = await readLocalRelayIdentity(localRelayIdentityDir());
      if (
        body.signing !== (await fingerprintJwk(identity.signingPublicJwk)) ||
        body.encryption !== (await fingerprintJwk(identity.publicJwk))
      )
        throw new HttpError(409, "The server SSH identity changed; verify both fingerprints again.");
      try {
        await getRelayBroker().withNodeIdentityRepair("local", async () => {
          await new IdentitiesRepository(db).register({
            principalId: "node:local",
            publicKey: identity.publicJwk,
            signingPublicKey: identity.signingPublicJwk,
            displayName: null,
          });
          resetLocalRelayIdentity();
        });
      } catch (err) {
        if (err instanceof SshRelayRefusal && err.code === "identity-repair")
          throw new HttpError(409, "The server SSH identity is already being repaired. Retry when it finishes.");
        throw err;
      }
      await audit({
        actorUserId: user.id,
        action: "node.ssh_identity.repair",
        targetType: "node",
        targetId: "local",
        metadataJson: null,
      });
      return { repaired: true };
    },
    {
      body: FingerprintsSchema,
      response: t.Object({
        repaired: t.Boolean({ description: "Registration replaced with the explicitly verified server identity" }),
      }),
    },
  );
