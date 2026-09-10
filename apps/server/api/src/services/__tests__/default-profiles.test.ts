import { beforeAll, describe, expect, it } from "bun:test";
import { allHarnesses, listInstalled } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { ensureSystemUser } from "@/auth/system-user.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import {
  DEFAULT_PROFILE_NAME,
  ensureDefaultProfiles,
  ensureDefaultProfilesForHarness,
  ensureDefaultProfilesForUser,
} from "@/services/default-profiles.js";
import { installLocalPlugin, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { seedLocalPluginsForTests, setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";

/**
 * Auto-defaulted profiles. The invariant: every (user, ENABLED harness) pair
 * ends with >=1 profile, seeded as a blank "Default" only when it has zero —
 * insert-only, idempotent, never touching an existing profile. These run
 * against the shared migration-owned test DB (via setupAuthTables), so every
 * assertion is scoped to a user id this file creates, never to a global count
 * (other suites leave rows on the same database).
 */

const profiles = new ProfilesRepository(db);

// Registry-order harness used for the disable/enable cases; the registry is a
// static compile-time list, so destructuring can only fail if it were empty.
const [firstHarness] = allHarnesses();
if (!firstHarness) throw new Error("harness registry must not be empty");

/**
 * The harness ids this host OFFERS — the exact set a seed should cover.
 *
 * Was the enable table until phase 2b; it is the plugins installed here now,
 * intersected with the registry (a default profile needs plugin code this
 * build has).
 */
async function enabledIds(): Promise<string[]> {
  const installed = new Set((await listInstalled(SUBSHELL_SERVER_DATA_DIR)).map((p) => p.id));
  return allHarnesses()
    .filter((h) => installed.has(h.id))
    .map((h) => h.id);
}

/** A fresh user with no profiles, distinct email per call. */
async function freshUser(): Promise<string> {
  return new UsersRepository(db).createUser({
    email: `dprof-${crypto.randomUUID()}@subshell.local`,
    passwordHash: await hashPassword("pw-123456"),
    role: "user",
  });
}

async function harnessesWithProfile(userId: string): Promise<Set<string>> {
  const rows = await profiles.listByUser(userId);
  return new Set(rows.map((p) => p.harnessId));
}

beforeAll(async () => {
  await setupAuthTables();
  // This host offers what it has installed, so a suite about seeding profiles
  // for the offered set has to give it something to offer.
  await seedLocalPluginsForTests();
});

describe("ensureDefaultProfilesForUser", () => {
  it("seeds exactly one blank Default per enabled harness", async () => {
    const userId = await freshUser();
    await ensureDefaultProfilesForUser(db, userId);

    const expected = new Set(await enabledIds());
    const seeded = await profiles.listByUser(userId);
    // One profile per enabled harness, none for disabled ones.
    expect(new Set(seeded.map((p) => p.harnessId))).toEqual(expected);
    expect(seeded.every((p) => p.name === DEFAULT_PROFILE_NAME)).toBe(true);
    // The Default is genuinely blank.
    for (const p of seeded) {
      expect(p.envJson).toBeNull();
      expect(p.flagsJson).toBeNull();
      expect(p.settingsJson).toBeNull();
      expect(p.configIsolation).toBe(0);
      expect(p.restartOnExit).toBe(0);
      // The unremovable flag rides along — this is what the DELETE guard reads.
      expect(p.isDefault).toBe(1);
    }
  });

  it("is idempotent — a second pass creates nothing", async () => {
    const userId = await freshUser();
    await ensureDefaultProfilesForUser(db, userId);
    const before = (await profiles.listByUser(userId)).length;
    await ensureDefaultProfilesForUser(db, userId);
    expect((await profiles.listByUser(userId)).length).toBe(before);
  });

  it("leaves an existing custom profile alone (no second profile for that harness)", async () => {
    const userId = await freshUser();
    // The user already curates a claude-code profile themselves.
    await profiles.create({
      id: crypto.randomUUID(),
      userId,
      harnessId: "claude-code",
      name: "My tuned one",
      description: null,
      envJson: '{"ANTHROPIC_MODEL":"opus"}',
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });

    await ensureDefaultProfilesForUser(db, userId);

    const claudeRows = (await profiles.listByUser(userId)).filter((p) => p.harnessId === "claude-code");
    // Exactly the user's own — not clobbered, not duplicated by a Default.
    expect(claudeRows.length).toBe(1);
    expect(claudeRows[0]?.name).toBe("My tuned one");
    expect(claudeRows[0]?.isDefault).toBe(0); // a hand-made profile stays deletable
    // Other enabled harnesses still got their Default.
    const expected = new Set(await enabledIds());
    expect(await harnessesWithProfile(userId)).toEqual(expected);
  });

  it("does not seed a harness this host does not have installed", async () => {
    const userId = await freshUser();
    const target = firstHarness;
    // Restore what was there: these suites share one data dir, so leaving a
    // plugin uninstalled would change what every later case sees.
    const prior = await effectiveEnabled(target.id);
    await uninstallLocalPlugin(target.id);
    try {
      await ensureDefaultProfilesForUser(db, userId);
      expect(await harnessesWithProfile(userId)).not.toContain(target.id);
    } finally {
      if (prior) await installLocalPlugin(target.id);
    }
  });
});

describe("ensureDefaultProfilesForHarness (enable seam)", () => {
  it("seeds the targeted harness for a user who had none, ignoring the offered filter", async () => {
    const userId = await freshUser();
    const target = firstHarness;
    // An uninstalled target on purpose: the caller decides, and this function
    // must seed what it was asked for regardless of what the sweep filter
    // would have said.
    const prior = await effectiveEnabled(target.id);
    await uninstallLocalPlugin(target.id);
    try {
      await ensureDefaultProfilesForHarness(db, target.id);
      const rows = (await profiles.listByUser(userId)).filter((p) => p.harnessId === target.id);
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe(DEFAULT_PROFILE_NAME);
    } finally {
      if (prior) await installLocalPlugin(target.id);
      await db.deleteFrom("profiles").where("userId", "=", userId).where("harnessId", "=", target.id).execute();
    }
  });
});

describe("system user exclusion", () => {
  it("never seeds the service user", async () => {
    const systemId = await ensureSystemUser();
    // The any-users sweep is inherently global (that IS the boot seam), so it
    // leaves unremovable Defaults for every leftover user in the shared
    // per-process DB unless this test cleans up after itself: snapshot the
    // covered pairs, sweep, then remove exactly the rows that appeared.
    const covered = async () =>
      new Set(
        (await db.selectFrom("profiles").select(["userId", "harnessId"]).execute()).map(
          (r) => `${r.userId}:${r.harnessId}`,
        ),
      );
    const before = await covered();
    try {
      await ensureDefaultProfiles({ db });
      expect((await profiles.listByUser(systemId)).length).toBe(0);
    } finally {
      const seeded = await db
        .selectFrom("profiles")
        .select(["userId", "harnessId"])
        .where("name", "=", DEFAULT_PROFILE_NAME)
        .where("isDefault", "=", 1)
        .execute();
      for (const r of seeded) {
        if (before.has(`${r.userId}:${r.harnessId}`)) continue;
        await db
          .deleteFrom("profiles")
          .where("userId", "=", r.userId)
          .where("harnessId", "=", r.harnessId)
          .where("name", "=", DEFAULT_PROFILE_NAME)
          .where("isDefault", "=", 1)
          .execute();
      }
    }
  });
});

/** Whether this host currently has the plugin installed. */
async function effectiveEnabled(harnessId: string): Promise<boolean> {
  return (await listInstalled(SUBSHELL_SERVER_DATA_DIR)).some((p) => p.id === harnessId);
}
