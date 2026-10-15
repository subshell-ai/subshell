import type { Node } from "@internal/node-admin";
import { ApiError, isNetworkError } from "@internal/node-admin";
import type { SshResolveOutcome } from "@/lib/ssh";

/**
 * The launch refusal, in the client's words. `POST /api/ssh/launch` answers
 * every no with a status and a code the panel can name (the response map in
 * `apps/server/api/src/api/ssh/launch.route.ts`); this file is the ONE place
 * that maps them to copy, each cause and its next step, so the panel renders
 * a cause and a remedy rather than an `API 409:` string.
 *
 * The 422 is the special case: its body is not the error envelope but the
 * resolve outcome itself (`{outcome}`), and `ApiError.message` slices the
 * display text to 200 chars, so the settings list is read from `err.body`
 * (the node-admin un-truncation). An older or truncated body falls back to
 * the message text; nothing renders a half sentence from a missing field.
 */

/** The refused arm of the resolve outcome, narrowed from `unknown`. */
export function isSshResolveRefusal(value: unknown): value is Extract<SshResolveOutcome, { accepted: false }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.accepted === false && typeof v.code === "string" && Array.isArray(v.settings);
}

/** Which field the refusal belongs under: the token typed, or the machine chosen. */
export type RefusalField = "destination" | "machine" | "keys";

/** The red line the panel renders, and where. */
export interface SshRefusalCopy {
  text: string;
  field: RefusalField;
}

/** What the panel knows about the connecting machine at submit time. */
export type SshMachineFacts = Pick<Node, "name" | "kind" | "sshEnabled">;

/** The settings-bearing sentence names each blocked keyword verbatim; the
 *  code-only arms (empty settings) name the fact and the place to fix it. */
function refusalFromOutcome(outcome: Extract<SshResolveOutcome, { accepted: false }>): string {
  return outcome.settings.length > 0
    ? `This SSH configuration uses settings Subshell doesn't support: ${outcome.settings.join(", ")}. Update them on the connecting machine and try again.`
    : "Subshell can't connect using this SSH configuration. Update it on the connecting machine and try again.";
}

/**
 * Maps a caught launch failure to copy. A `NetworkError` returns null: the
 * app-wide offline banner already says it, and restating "server unreachable"
 * under the form would be the same sentence twice.
 * @param err - the value from the launch mutation's catch
 * @param machine - the picked node's facts (null when the row is unknown)
 */
export function sshLaunchRefusal(
  err: unknown,
  machine: SshMachineFacts | null,
  localKey = false,
): SshRefusalCopy | null {
  if (isNetworkError(err)) return null;
  // Local key parsing/unlock errors already contain safe, actionable copy.
  // They aren't API responses and must not disappear into the launch fallback.
  if (localKey && err instanceof Error && !(err instanceof ApiError)) return { field: "keys", text: err.message };
  if (err instanceof ApiError) {
    if (
      err.code?.startsWith("SSH_RELAY_") ||
      err.code?.startsWith("SSH_HOST_PIN_") ||
      err.code?.startsWith("SSH_KEYS_")
    ) {
      const message =
        err.body && typeof err.body === "object" && "message" in err.body && typeof err.body.message === "string"
          ? err.body.message
          : err.message;
      return { field: err.code.startsWith("SSH_HOST_PIN_") ? "destination" : "keys", text: message };
    }
    switch (err.status) {
      case 400:
        // ALIAS_UNSAFE: the token was refused before the machine was asked.
        return { text: "Enter a valid SSH destination, such as deploy@example.com:22.", field: "destination" };
      case 403: {
        if (err.code === "SSH_GATE_OFF" && machine !== null && !machine.sshEnabled) {
          // The gate's off-door. Naming WHO flips it follows the row's kind:
          // `local` is an admin's setting, every other machine its owner's
          // (spec 2026-10-07 decision 3).
          return {
            text:
              machine.kind === "local"
                ? "Outgoing SSH is disabled on this node. An admin can enable it in this node’s settings."
                : "Outgoing SSH is disabled on this node. Ask this node’s owner to enable it.",
            field: "machine",
          };
        }
        // Other 403s can come from launch access or instance policy.
        // Avoid naming a cause without enough information.
        return { text: "You can't connect from this machine.", field: "machine" };
      }
      case 404:
        return { text: "That machine isn't available.", field: "machine" };
      case 409: {
        const name = machine?.name ?? "That machine";
        switch (err.code) {
          case "NODE_PROTOCOL_HELD":
            return {
              text: `${name} runs a Subshell version this server doesn't support. Update it from its node page and try again.`,
              field: "machine",
            };
          case "NODE_OUTDATED":
            return {
              text: `Update Subshell on ${name} from its node page to use SSH.`,
              field: "machine",
            };
          case "NODE_UNREACHABLE":
            return {
              text: `${name} didn't answer the SSH request in time. Check its connection and try again.`,
              field: "machine",
            };
          case "NODE_IN_MAINTENANCE":
            // The create under the launch refuses in a window (`rethrow-
            // LaunchRefusal`, subshells.service.ts): the link is LIVE, it
            // just takes no new panes - saying "no live connection" here
            // would name the wrong fact and the wrong wait.
            return {
              text: `${name} is in maintenance, so you can't start new subshells on it. Try again when maintenance ends.`,
              field: "machine",
            };
          default:
            // NODE_OFFLINE and any other 409: no live link to carry the ask.
            return {
              text: `${name} is offline. Start its Subshell daemon and try again.`,
              field: "machine",
            };
        }
      }
      case 422: {
        // The resolve refused: read the outcome from the parsed body, because
        // the message is a 200-char slice of it.
        const outcome =
          typeof err.body === "object" && err.body !== null ? (err.body as { outcome?: unknown }).outcome : undefined;
        if (isSshResolveRefusal(outcome)) return { text: refusalFromOutcome(outcome), field: "destination" };
        return { text: err.message, field: "destination" };
      }
      case 502:
        // The machine answered its own refusal (no ssh binary, the mirror
        // says no); its verbatim text never rides the wire to here. This is
        // the server's own sentence (`rpcRefusal`): the two checks that
        // answer the machine's no.
        return {
          text: "This machine couldn’t start SSH. Check that outgoing SSH is enabled on this node and that the ssh command is installed.",
          field: "machine",
        };
      default:
        break;
    }
  }
  return { text: "Couldn't start the SSH connection.", field: "machine" };
}
