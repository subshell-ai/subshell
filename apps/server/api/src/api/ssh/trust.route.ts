import { BackendErrorCodes } from "@internal/backend-errors";
import { isSshKnownHostsPinLine } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { parseSshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import { apiModels } from "@/schema/index.js";
import {
  captureHostPin,
  deleteHostPin,
  hostKeyFingerprints,
  hostPinRefusal,
  listHostPins,
  SshHostPinError,
} from "@/services/ssh-host-pins.service.js";

/**
 * `/api/ssh/host-pins` - the destination trust screen (spec 2026-10-08 §8-§9,
 * Task 12): LIST the caller's host-key pins, SUPPLY an explicit pin (the §9
 * "or an explicit pin" door: the operator's key for a destination the key
 * home has not connected to yet), and DELETE one - the recovery's first half,
 * whose second half is the fresh grant-creation TOFU the next capture runs.
 *
 * The row model is the saved-hosts/grants posture verbatim: per-owner reads,
 * a foreign id the SAME 404 an absent row is, and the cookie doctrine of
 * every ssh sibling (deciding which key authenticates a destination is a
 * browser-session act). What the screen NEVER sees is the key bytes: the
 * serialized view carries the destination and the pinned key's `SHA256:`
 * fingerprint - a public identifier - and the stored line leaves this server
 * only on the signed relay-open to B.
 *
 * The audit trail (written by the service): `node.ssh_host_pin.create` and
 * `.delete`, each naming destination + fingerprint only (docs/security.md
 * §10). Supplying a pin for a destination that already stands pinned to a
 * DIFFERENT key is the §9 hard block (409, nothing written) - delete the pin
 * first, that is the whole recovery flow.
 */

/** The trust screen's row shape: destination + public fingerprint, never key bytes. */
const SshHostPinViewSchema = t.Object({
  id: t.String({ description: "Pin row id (uuid)" }),
  destination: t.String({ description: "Canonical resolved destination `user@host:port`" }),
  fingerprint: t.String({ description: "The pinned key's SHA256: display fingerprint (public identifier)" }),
  createdAt: t.String({ description: "ISO 8601 first capture (the TOFU moment)" }),
  updatedAt: t.String({ description: "ISO 8601 of the last accepted match" }),
});

export const sshTrustRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/host-pins",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH host-key trust is restricted to browser sessions");
      return { pins: await listHostPins({ ownerUserId: user.id }) };
    },
    {
      response: {
        200: t.Object({
          pins: t.Array(SshHostPinViewSchema, { description: "The caller's pinned destinations, newest first" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshHostPins",
        tags: ["ssh"],
        description:
          "Lists the caller's destination host-key pins as destination plus SHA256: fingerprint; the pinned key line itself is display-excluded by construction",
      },
    },
  )
  .post(
    "/host-pins",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "SSH host-key trust is restricted to browser sessions");
      const destination = body.destination.trim();
      if (parseSshCanonicalDestination(destination) === null) {
        return throwCodedRefusal({
          status: 400,
          code: BackendErrorCodes.SSH_HOST_PIN_INVALID,
          message: "That destination is not a canonical user@host:port.",
        });
      }
      const line = body.hostKey.trim();
      if (!isSshKnownHostsPinLine(line) || hostKeyFingerprints(line).length !== 1) {
        return throwCodedRefusal({
          status: 400,
          code: BackendErrorCodes.SSH_HOST_PIN_INVALID,
          message: "The host key must be one known_hosts line carrying exactly one public key.",
        });
      }
      try {
        const row = await captureHostPin({ ownerUserId: user.id, aNodeId: null, destination, hostKeyLine: line });
        return {
          pin: {
            id: row.id,
            destination: row.destination,
            fingerprint: hostKeyFingerprints(row.hostKey)[0] ?? "",
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        };
      } catch (err) {
        if (err instanceof SshHostPinError) return throwCodedRefusal(hostPinRefusal(err));
        throw err;
      }
    },
    {
      body: t.Object({
        destination: t.String({
          minLength: 1,
          maxLength: 512,
          description: "Canonical resolved destination `user@host:port` (the spelling the launch keys the pin by)",
        }),
        hostKey: t.String({
          minLength: 1,
          maxLength: 4096,
          description:
            "The pinned entry in OpenSSH known_hosts form (pattern, key type, base64 key material) - stored verbatim and carried verbatim to B",
        }),
      }),
      response: {
        200: t.Object({ pin: SshHostPinViewSchema }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createSshHostPin",
        tags: ["ssh"],
        description:
          "Supplies an explicit host-key pin for a destination (the §9 alternative to capturing from the key home); a destination pinned to a different key is the named hard block, never an overwrite",
      },
    },
  )
  .delete(
    "/host-pins/:destination",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, "SSH host-key trust is restricted to browser sessions");
      const deleted = await deleteHostPin({ ownerUserId: user.id, destination: params.destination });
      if (deleted === null) {
        return throwCodedRefusal({
          status: 404,
          code: BackendErrorCodes.NOT_FOUND_ERROR,
          message: "No pin for that destination",
        });
      }
      return { deleted: true };
    },
    {
      params: t.Object({ destination: t.String({ description: "Canonical destination whose pin is removed" }) }),
      response: {
        200: t.Object({ deleted: t.Boolean({ description: "True once the pin row is gone" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteSshHostPin",
        tags: ["ssh"],
        description:
          "Deletes the caller's pin for one destination (the TOFU recovery's first half): the next capture at a fresh key re-decides trust; the audit names the removed destination and fingerprint only",
      },
    },
  );
