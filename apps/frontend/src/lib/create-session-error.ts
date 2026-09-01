import { BackendErrorCodes } from "@internal/backend-errors";
import { ApiError, errMessage } from "@/lib/api";

/**
 * Display text for a failed `POST /api/sessions` — the one copy both launch
 * surfaces (`/new` and the workspace dialog) show under the form.
 *
 * Node-aware copy only for the codes whose server text the operator can
 * act on better than the generic body: a remote pick that raced the picker
 * (or a pinned profile whose agent is down) answers 409 `NODE_OFFLINE`, and
 * the `NODE_UNREACHABLE` sibling (the node answered nothing) gets its own
 * line. Invisible/absent nodes 404 and harness-unusable-on-that-node 409s —
 * both already carry honest server messages, so they fall through to
 * {@link errMessage} untouched. Never promise a 403: sharing widened access
 * means an unlaunchable foreign node simply never appears in the picker, and
 * one that vanished answers 404 (spec 2026-08-31 §2, 404-not-403).
 * @param err - The error from the create mutation
 * @param fallback - Text when the error carries no message at all
 * @returns The line to render under the form
 */
export function createSessionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === BackendErrorCodes.NODE_OFFLINE) {
      return "That node is offline — start its mote-agent or pick another node.";
    }
    if (err.code === BackendErrorCodes.NODE_UNREACHABLE) {
      return "The node did not answer — try again shortly.";
    }
  }
  return errMessage(err, fallback);
}
