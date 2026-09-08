import { ALL_HARNESSES } from "@internal/harnesses";
import { sql } from "kysely";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { db as appDb } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import type { Database } from "@/db/types/index.js";
import { logger } from "@/utils/logger.js";

/** The typed application database handle every seam passes in. */
type Db = import("kysely").Kysely<Database>;

/**
 * Auto-defaulted profiles.
 *
 * Most users open a subshell without ever touching the CLI flags a profile
 * carries, so every (user, enabled-harness) pair is guaranteed at least one
 * profile: a blank "Default" the user can edit or replace at leisure. This
 * removes profile creation from the first-run critical path (the wizard is now
 * Account → Harness → done) without changing anything about how profiles work
 * once a user wants to customize them.
 *
 * The rule is SELF-HEALING and idempotent: it only ever INSERTS when the pair
 * has zero profiles, and never mutates or deletes an existing one. Adding your
 * own for that harness lifts the count above zero, so nothing re-appears. It
 * runs at exactly three seams — registration, harness enablement, and boot
 * (the upgrade backfill) — and deliberately NOT on the profile list read.
 *
 * Seeded rows carry `isDefault = 1`: they are unremovable (DELETE refuses
 * them, migration 0010) but fully editable — the flag is what protects them,
 * not the name, so renaming a Default keeps it protected. Disabling or
 * uninstalling the harness hides its profiles everywhere and blocks new
 * subshells (`usableHarnessIds` / `harnessUsable`); the Default waits it out
 * and returns with the harness.
 *
 * Enabled, not installed: a Default is seeded for every ENABLED harness so the
 * moment a user installs the CLI they can launch — no re-enable dance. Profiles
 * for a not-installed harness are already hidden from every picker (the list
 * filters to `usableHarnessIds`), so these sit quietly until used.
 */

/** The name given to every auto-created profile. Unique where it matters: per user + harness. */
export const DEFAULT_PROFILE_NAME = "Default";

/**
 * Harness plugin ids that are currently enabled — the `harnessPlugins` DB
 * override, falling back to each plugin's own `enabledByDefault` (the exact
 * rule `harness-utils` uses, so a seeded harness and a listed harness agree).
 */
async function enabledHarnessIds(db: Db): Promise<string[]> {
  const ids = ALL_HARNESSES.map((h) => h.id);
  const states = await new HarnessPluginsRepository(db).getEnabledStates(ids);
  return ALL_HARNESSES.filter((h) => states.get(h.id) ?? h.enabledByDefault).map((h) => h.id);
}

/**
 * Every real user's id. The `system` service user is excluded: it owns admin
 * system keys, cannot sign in, and should never collect profiles. better-auth's
 * `user` table is outside the typed schema and stores camelCase columns, so the
 * probe is raw SQL (the trap documented in `UsersRepository`).
 */
async function realUserIds(db: Db): Promise<string[]> {
  // `IS NULL OR <>` on purpose: plain `<>` evaluates to NULL for a row with a
  // NULL email (better-auth's column is nullable), silently dropping that user
  // from every global sweep.
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM user WHERE email IS NULL OR email <> ${SYSTEM_USER_EMAIL}
  `.execute(db);
  return rows.map((r) => r.id);
}

/**
 * Seeds a blank "Default" profile for every (user, harness) pair that currently
 * has none, across the given scope.
 *
 * @param opts.db - database handle (defaults to the app's shared instance)
 * @param opts.userId - restrict to one user (registration); default: all real users
 * @param opts.harnessId - restrict to one harness (enablement); default: all enabled harnesses
 * @returns how many Default profiles were created (0 = everyone already covered)
 */
export async function ensureDefaultProfiles(
  opts: { db?: Db; userId?: string; harnessId?: string } = {},
): Promise<number> {
  const db = opts.db ?? appDb;
  const profiles = new ProfilesRepository(db);

  // An explicitly targeted harness is honored regardless of the enabled filter
  // (the enable route flips the flag just before calling us); the general path
  // is gated on enabled state.
  const harnessIds = opts.harnessId ? [opts.harnessId] : await enabledHarnessIds(db);
  const userIds = opts.userId ? [opts.userId] : await realUserIds(db);
  if (harnessIds.length === 0 || userIds.length === 0) return 0;

  // One read for the pairs that already exist among the targets, so the common
  // (already-seeded) case is a single query and zero inserts.
  const existing = await db
    .selectFrom("profiles")
    .select(["userId", "harnessId"])
    .where("userId", "in", userIds)
    .where("harnessId", "in", harnessIds)
    .execute();
  const covered = new Set(existing.map((p) => `${p.userId}:${p.harnessId}`));

  let created = 0;
  for (const userId of userIds) {
    for (const harnessId of harnessIds) {
      if (covered.has(`${userId}:${harnessId}`)) continue;
      // The insert re-checks the pair inside the statement: `covered` is only
      // the fast path, and a check-then-insert race would strand a second
      // UNDELETABLE Default (there is no unique constraint to lean on).
      const inserted = await profiles.insertIfNoneForPair({
        id: crypto.randomUUID(),
        userId,
        harnessId,
        name: DEFAULT_PROFILE_NAME,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
        // The flag is what makes this row unremovable (DELETE guard); the
        // name is only what it ships with.
        isDefault: 1,
      });
      if (inserted) created++;
    }
  }
  return created;
}

/** Registration seam: guarantee the new user has a Default for each enabled harness. */
export async function ensureDefaultProfilesForUser(db: Db, userId: string): Promise<void> {
  await ensureDefaultProfiles({ db, userId });
}

/** Enablement seam: guarantee every existing user has a Default for the just-enabled harness. */
export async function ensureDefaultProfilesForHarness(db: Db, harnessId: string): Promise<void> {
  await ensureDefaultProfiles({ db, harnessId });
}

/** Boot seam (upgrade backfill): guarantee every real user × enabled harness is covered. */
export async function ensureDefaultProfilesEverywhere(db: Db): Promise<void> {
  const created = await ensureDefaultProfiles({ db });
  if (created > 0) logger.info(`seeded ${created} default profile(s) for existing users/harnesses`);
}
