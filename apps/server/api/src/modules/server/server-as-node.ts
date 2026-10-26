import type { Kysely } from "kysely";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * The `settings` row governing whether the control-plane host is a launch
 * target at all (operator ask, 2026-09-24).
 *
 * A service module, not a route constant, because four modules consult it —
 * the settings routes (write + both reads), `subshells.service.ts` (explicit
 * 403, implicit step 2, and the restart gate), `api/nodes/node-view.ts` (the
 * `canLaunch` every picker filters on), and `subshell-manager.service.ts`
 * (the auto-restart deferral, without which a swept death would respawn a
 * pane onto the refused host minutes later). That is the repo's rule from
 * `ALLOW_NODE_ENROLLMENT_KEY`: a settings key with more than one reader lives
 * where every reader can import it without dragging a route's Elysia graph
 * along.
 *
 * An ABSENT row means true: an instance that never touched this keeps the
 * behaviour it always had — the Server runs subshells. This flag is a
 * convenience, not a security boundary (containment of a machine is delete /
 * key rotation / shares, all cookie-gated), so unlike the registration gate
 * it does not fail closed on a damaged row: only an explicit JSON `false`
 * switches it off, and corruption reads as "unchanged", which is the honest
 * answer for a feature with nothing to protect.
 */
export const ALLOW_SERVER_SUBSHELLS_KEY = "allow_server_subshells";

/**
 * Whether the control-plane host may run subshells right now.
 *
 * One function for all four readers, so the view, the gate, the restart path
 * and the switch on Settings can never disagree — the `registrationOpen`
 * discipline applied to a non-security flag.
 */
export async function serverSubshellsEnabled(db: Kysely<Database>): Promise<boolean> {
  const stored = await new SettingsRepository(db).get(ALLOW_SERVER_SUBSHELLS_KEY, true);
  // `!== false`, not `Boolean(...)`: the repository hands back whatever JSON
  // parsed to, and only the explicit off is off. A junk value reads as the
  // untouched default rather than an outage nobody asked for.
  return stored !== false;
}
