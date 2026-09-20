import { BackendErrorCodes } from "@internal/backend-errors";
import { ApiError, errMessage } from "@internal/node-admin";

/**
 * Display text for a failed `POST /api/subshells` — the one copy both launch
 * surfaces (`/new` and the workspace dialog) show under the form.
 *
 * Node-aware copy only for the codes whose server text the operator can
 * act on better than the generic body: a remote pick that raced the picker
 * answers 409 `NODE_OFFLINE`, and
 * the `NODE_UNREACHABLE` sibling (the node answered nothing) gets its own
 * line, and `NODE_IN_MAINTENANCE` (spec 2026-09-14) gets a third: that node is
 * up and answering everything except launches, so the offline copy would send
 * the reader to stare at a healthy machine. Invisible/absent nodes 404 and
 * harness-unusable-on-that-node 409s — both already carry honest server
 * messages, so they fall through to {@link errMessage} untouched. Never
 * promise a 403: sharing widened access means an unlaunchable foreign node
 * simply never appears in the picker, one that vanished answers 404 (spec
 * 2026-08-31 §2, 404-not-403), and the maintenance refusal above is a 409 —
 * so the 403 remains unpromised.
 * @param err - The error from the create mutation
 * @param fallback - Text when the error carries no message at all
 * @returns The line to render under the form
 */
export function createSubshellErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === BackendErrorCodes.NODE_OFFLINE) {
      return "That node is offline. Start its subshell or pick another node.";
    }
    if (err.code === BackendErrorCodes.NODE_UNREACHABLE) {
      return "The node did not answer. Try again shortly.";
    }
    if (err.code === BackendErrorCodes.NODE_IN_MAINTENANCE) {
      return "That node is in maintenance. Pick another node, or end maintenance from its node page.";
    }
  }
  return errMessage(err, fallback);
}
