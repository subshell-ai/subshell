import type { ServerDeployment } from "@/types/server-deployment";

/** The two answers to "what starts this server", as the page shows them. */
export type SupervisionMode = "service" | "app";

/**
 * Which mode this machine is in, or `null` when it is in NEITHER.
 *
 * `null` is not a missing answer, it is an answer: a server started by hand —
 * `bun run start`, a container, the e2e stack — is supervised by nothing, and
 * this used to report it as "In the background" on the reasoning that a
 * background service is what an operator would install if they installed
 * anything. That is a fair default for a pending CHOICE and wrong for this
 * control, whose whole documented contract is that it shows the MACHINE. It
 * also put two sentences on one screen that could not both be true: the radio
 * naming a launchd agent that keeps the server running, directly under the
 * Service card's "Running, not supervised".
 *
 * It is the ordinary state of every non-desktop deployment — which is the
 * audience this card was widened for.
 */
export function currentMode(view: ServerDeployment): SupervisionMode | null {
  const service = view.service;
  if (service.manager === "app") return "app";
  // **`installed` alone.** A definition on disk is what "in the background"
  // MEANS here, and it stays the answer while the service is merely stopped.
  //
  // NOT `manager`, which this first read and which is not what it looks like:
  // the server derives it from the PLATFORM — `darwin ? "launchd" : linux ?
  // "systemd" : null` — so it names the manager this machine WOULD use, never
  // one that is managing anything. Reading it here made every macOS and Linux
  // host report "In the background" whatever was true, which put "A launchd
  // agent runs it" on screen directly above "No service is installed on this
  // machine", and made the null answer below unreachable on the platforms
  // that have a manager name at all.
  if (service.installed) return "service";
  return null;
}

/**
 * Whether the login box is usable, or `null` when it is — with the reason.
 *
 * The three cases mirror `POST /api/admin/server/autostart`'s own 409s: the
 * UI must not offer what the server will refuse.
 *
 * The switch sits BELOW both mode options, not nested under one. It was
 * nested, and that expressed a true dependency in the wrong medium: the
 * indentation wedged a control between the two radios so they stopped
 * reading as a pair, while claiming the toggle belonged to one option when
 * what is true is that "does this come back at login?" is a question about
 * the machine that only one mode can honour today. So the layout is the one
 * every settings pane uses — pick the mode, then its settings — and the
 * dependency is carried the way this codebase carries every other one: a
 * disabled control that says why, and names what would answer instead.
 */
export function loginDisabledReason(view: ServerDeployment): string | null {
  const service = view.service;
  if (service.manager === "app") {
    // Not "unavailable" — the question is real in this mode too, it just has
    // a different answer, and that answer is actionable by the person.
    return "The server starts when the app does. To have it back at login, open Subshell Server at login.";
  }
  if (!service.installed) return "No service is installed on this machine.";
  if (service.enabled === null) return "The service manager did not say.";
  return null;
}

/** How this mode reads in a sentence about what is happening. */
export function modeLabel(mode: SupervisionMode): string {
  return mode === "app" ? "the Subshell Server app" : "the background";
}
