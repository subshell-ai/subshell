/**
 * The un-enroll card's version gate, pure (plane-list wave, 2026-09-22).
 *
 * `subshell unenroll` is a node CLI verb; an older agent answers it with a
 * usage error, and a chain that stops and uninstalls the service BEFORE that
 * refusal leaves the machine in the worst of both worlds: no service, config
 * still there. So the card that would run it is gated on the verb existing,
 * exactly the run-at-login switch's pattern (`autostart-gate.ts`) rather than
 * a press that half-runs.
 */
import type { Probe } from "@/lib/ipc";
import { isOlder } from "@/lib/semver";

/**
 * The first node CLI with the `unenroll` verb. One 0.15.0 carries it beside
 * `service autostart`: changesets do not stack minors, so this wave's node
 * changes compose into the same cut as the pending version PR's, and both
 * gates name the same honest number.
 */
export const MIN_UNENROLL_NODE_VERSION = "0.15.0";

/**
 * Whether the resolved agent can un-enroll itself.
 *
 * Unknown version assumes capable, the autostart gate's argument verbatim: a
 * control disabled by a string this side could not parse is worse than the
 * CLI's own refusal, which arrives with its words. `nodeBinary.version` is
 * the resolved rung's answer — the binary this app would actually run.
 */
export function unenrollSupported(probe: Probe | undefined): boolean {
  const found = probe?.nodeBinary?.version;
  if (!found) return true;
  return !isOlder(found, MIN_UNENROLL_NODE_VERSION);
}
