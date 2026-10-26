import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import type { SshRefusal } from "@/modules/ssh/ssh-launch.service.js";
/**
 * Throw a CODED service refusal as the structured `ApiError` the global
 * handler serializes (the `NODE_IN_MAINTENANCE` posture: an expected refusal
 * mapped at the service boundary, doNotLog so the 4xx never fills the error
 * log). The status rides the code's own definition, and every code here is
 * defined with exactly the status the gate doctrine gives it (403 gate, 404
 * invisible, 409 held/offline, 400 unsafe token, 502 machine-refused) — the
 * pairing is in `error-codes.ts`, not re-derived here.
 *
 * The 422 arm — the resolve outcome an ACTING endpoint refuses — is NOT an
 * error envelope (its body is `{outcome}`) and belongs to the `status(422,…)`
 * return of the launch/save routes; reaching this helper with one is a
 * routing bug in this file's own callers, so it answers 500 rather than
 * inventing a body.
 */
export function throwCodedRefusal(refusal: SshRefusal): never {
  if (refusal.status === 422) {
    throwApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "SSH refusal routed to the wrong surface",
    });
  }
  throwApiError({
    code: refusal.code,
    message: refusal.message,
    doNotLog: true,
  });
}
