import type { Kysely } from "kysely";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { audit } from "@/services/audit.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { logger } from "@/utils/logger.js";

/**
 * The `settings` row behind LOCKDOWN MODE (operator ask, 2026-09-24): one
 * instance-wide emergency switch. ON stops every running subshell and refuses
 * every new one, everywhere, for everyone — admins and MCP sibling launches
 * included, because all creation already routes through the plane.
 *
 * It is deliberately NOT node maintenance wearing a hat. Maintenance is a
 * per-machine routing preference its owner controls and the machine mirrors;
 * clearing a lockdown must not silently clear maintenance someone set for
 * their own reasons, and an owner must not be able to unlock the instance by
 * unlocking their node. So lockdown lives here, on a settings row, and the
 * plane refuses before any machine is consulted.
 *
 * Like {@link ALLOW_SERVER_SUBSHELLS_KEY}, this is a service module rather
 * than a route constant because several readers consult it: the settings
 * routes (both reads + the PATCH), `subshells.service.ts` (the create and
 * restart gates), and eventually anything that renders the banner's truth.
 *
 * An ABSENT row means OFF, and only an explicit JSON `true` is ON — a corrupt
 * row must not lock an instance nobody locked (the asymmetry with the
 * registration gate is the same as `serverSubshellsEnabled`'s, argued there).
 */
export const LOCKDOWN_KEY = "lockdown";

/** Whether the instance is in lockdown right now. See the module header. */
export async function lockdownEnabled(db: Kysely<Database>): Promise<boolean> {
  return (await new SettingsRepository(db).get(LOCKDOWN_KEY, false)) === true;
}

/**
 * The name the lockdown confirmation is checked against — the control-plane
 * host's admin-chosen node name (default "Server", spec 2026-09-08).
 *
 * It is the machine name for this purpose because lockdown's ON is an act ON
 * THE SERVER that reaches every machine: the thing you type is the name of
 * the machine you are ordering down, and it is rendered to the admin by
 * `GET /api/settings` from this same function, so the dialog and the route
 * cannot disagree about what "typed it right" means.
 */
export async function serverNodeName(db: Kysely<Database>): Promise<string> {
  return (await new NodesRepository(db).findById(LOCAL_NODE_ID))?.name ?? "Server";
}

/** The result of one lockdown call. */
export interface LockdownEffects {
  /**
   * What the live flag was when this call re-read it — the audit's `from`
   * when the act ran. On the `expectFrom` mismatch branch NO write happens
   * and this is simply what the re-read found: every field is the empty
   * report of an act that chose to do nothing.
   */
  before: boolean;
  /** Ids this act retired. Empty unless it just turned ON. */
  stopped: string[];
  /**
   * Ids whose kill failed. Carried out of the loop the way
   * `applyMaintenanceEffects` carries them: a caller told a pane is down
   * walks away from a machine still running it.
   */
  failed: string[];
}

/**
 * Write the lockdown flag and, when turning ON, stop what is running — the
 * whole act, guarded twice over (code review 2026-09-24, finding I1):
 *
 * - **`expectFrom`** is the caller's gate-read — the state the confirmation
 *   was checked against. If the flag has moved since (a concurrent admin's
 *   flip landed mid-await), this call does NOTHING: no write, no kill loop,
 *   no audit row, and the returned `before` says what it found. The race
 *   this closes is the loud one — a no-op echo whose gate-read saw OFF
 *   landing after another ON landed, which without the guard would lift an
 *   emergency lockdown nobody typed for, or run the seconds-long loop twice
 *   over the same rows and audit one semantic flip twice.
 * - The flag still lands FIRST, so within a single accepted act a concurrent
 *   reader refusing launches never waits on the loop, and a row that dies on
 *   its own mid-loop is already retired by the time the sweep reaches it.
 *
 * Each row goes through `terminateForMaintenance`, the maintenance suite's
 * proven one-row stop: token revoked, row marked, owner notified, and a kill
 * failure ISOLATED per row — one stubborn pane must not abandon the window,
 * because the remaining subshells and the audit row come after the loop and
 * a rethrow takes all of them down. The notify kind says `maintenance` and
 * that wording is a known rough edge (spec-owner call): it beats the
 * alternative of an owner never being told their pane died.
 *
 * Turning OFF stops nothing and restarts nothing — running panes simply keep
 * running and creation reopens. (The confirmation lives at the route, which
 * now asks for it in both directions; this service is the act, not the ritual.)
 */
export async function applyLockdown(
  db: Kysely<Database>,
  opts: { on: boolean; expectFrom: boolean; actorUserId: string | null },
): Promise<LockdownEffects> {
  const settings = new SettingsRepository(db);
  const subshells = new SubshellsRepository(db);
  const before = await lockdownEnabled(db);
  if (before !== opts.expectFrom) {
    // The world moved between the gate and the act. Someone already did
    // (this|the opposite) flip; the correct act is none.
    return { before, stopped: [], failed: [] };
  }
  await settings.set(LOCKDOWN_KEY, opts.on);

  const stopped: string[] = [];
  const failed: string[] = [];
  if (opts.on) {
    // Read AFTER the flag write, for the same reason maintenance reads after
    // its own: rows that die mid-loop are already retired by the time here
    // reaches them, and a second writer finds nothing to stop.
    const rows = await subshells.listRunning();
    const manager = new SubshellManagerService({ subshells, presets: new PresetsRepository(db) });
    for (const row of rows) {
      // Sequential on purpose — these are kills, some of them RPCs to
      // machines being told to stop, and the last place to open N concurrent
      // commands on one socket is a machine in the middle of being locked
      // down. (maintenance.ts argues the identical choice.)
      try {
        await manager.terminateForMaintenance(row);
        stopped.push(row.id);
      } catch (err) {
        failed.push(row.id);
        logger
          .withError(err)
          .warn(`lockdown: subshell ${row.id} could not be stopped; the flag holds and the window continues`);
      }
    }
  }

  // Audited on REAL flips only, like every settings sibling. The stopped/
  // failed lists ride the metadata the way `node.maintenance.update` carries
  // its own — "who locked this down, and what went down with it" is the whole
  // question this row answers afterwards.
  if (before !== opts.on) {
    await audit({
      actorUserId: opts.actorUserId,
      action: "settings.update",
      targetType: "settings",
      targetId: LOCKDOWN_KEY,
      metadataJson: JSON.stringify({
        from: before,
        to: opts.on,
        stopped,
        ...(failed.length > 0 ? { failed } : {}),
      }),
    });
  }
  return { before, stopped, failed };
}
