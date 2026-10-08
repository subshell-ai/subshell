import type { Node } from "@internal/node-admin";
import { ApiError, isNetworkError } from "@internal/node-admin";
import type { SshResolveOutcome } from "@/lib/ssh";

/**
 * The launch refusal, in the client's words. `POST /api/ssh/launch` answers
 * every no with a status and a code the panel can name (the response map in
 * `apps/server/api/src/api/ssh/launch.route.ts`); this file is the ONE place
 * that maps them to copy, one sentence pair per branch, so the panel renders
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
export type RefusalField = "destination" | "machine";

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
    ? `Config needs settings Subshell does not run: ${outcome.settings.join(", ")}. Edit them on the connecting machine and retry.`
    : "Subshell cannot run this destination as its config stands. Edit that config on the connecting machine and retry.";
}

/**
 * Maps a caught launch failure to copy. A `NetworkError` returns null: the
 * app-wide offline banner already says it, and restating "server unreachable"
 * under the form would be the same sentence twice.
 * @param err - the value from the launch mutation's catch
 * @param machine - the picked node's facts (null when the row is unknown)
 */
export function sshLaunchRefusal(err: unknown, machine: SshMachineFacts | null): SshRefusalCopy | null {
  if (isNetworkError(err)) return null;
  if (err instanceof ApiError) {
    switch (err.status) {
      case 400:
        // ALIAS_UNSAFE: the token was refused before the machine was asked.
        return { text: "That destination is not a valid host name.", field: "destination" };
      case 403: {
        if (err.code === "SSH_GATE_OFF" && machine !== null && !machine.sshEnabled) {
          // The gate's off-door. Naming WHO flips it follows the row's kind:
          // `local` is an admin's setting, every other machine its owner's
          // (spec 2026-10-07 decision 3).
          return {
            text:
              machine.kind === "local"
                ? "An admin can enable SSH on this machine in its settings."
                : "SSH is off on this machine. Ask its owner to enable it.",
            field: "machine",
          };
        }
        // The owner-door (the code is shared) or any other 403: the machine
        // is open to someone else, and a share is not a remedy here.
        return { text: "You can't connect from this machine.", field: "machine" };
      }
      case 404:
        return { text: "That machine isn't available.", field: "machine" };
      case 409: {
        const name = machine?.name ?? "That machine";
        switch (err.code) {
          case "NODE_PROTOCOL_HELD":
            return {
              text: `${name} runs a Subshell version this server does not speak. Update it from its machine page and retry.`,
              field: "machine",
            };
          case "NODE_OUTDATED":
            return {
              text: `The Subshell app on ${name} is too old to speak SSH. Update it from its machine page.`,
              field: "machine",
            };
          case "NODE_UNREACHABLE":
            return {
              text: `${name} did not answer the SSH request in time. Check its connection and retry.`,
              field: "machine",
            };
          default:
            // NODE_OFFLINE and any other 409: no live link to carry the ask.
            return {
              text: `${name} has no live connection right now. Bring its Subshell app online and retry.`,
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
        // says no); its verbatim text never rides the wire to here.
        return { text: "The connecting machine did not answer.", field: "machine" };
      default:
        break;
    }
  }
  return { text: "The connection could not be started.", field: "machine" };
}
