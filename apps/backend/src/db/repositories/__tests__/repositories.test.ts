import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const repos = {
  harnessPlugins: new HarnessPluginsRepository(db),
  profiles: new ProfilesRepository(db),
  sessions: new SessionsRepository(db),
  recentPaths: new RecentPathsRepository(db),
  settings: new SettingsRepository(db),
  userMeta: new UserMetaRepository(db),
};

beforeAll(async () => {
  // Run the app migrations against the in-memory DB (tables only, no migrator
  // bookkeeping needed since the DB is recreated each run).
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await profileDefaultFlagMigration.up(db); // ProfilesRepository.create writes is_default
  await sessionNameLockedMigration.up(db); // SessionsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // sessions.harness_session_id
  await sessionNotificationsMigration.up(db); // sessions.notify / waiting_since + subscriptions
});

beforeEach(async () => {
  // fresh data per test
  await db.deleteFrom("recentPaths").execute();
  await db.deleteFrom("sessions").execute();
  await db.deleteFrom("profiles").execute();
  await db.deleteFrom("harnessPlugins").execute();
  await db.deleteFrom("userMeta").execute();
  await db.deleteFrom("settings").execute();
});

describe("harness plugins repository", () => {
  it("reports only plugins with a row — the caller owns the default", async () => {
    const states = await repos.harnessPlugins.getEnabledStates(["claude-code", "hermes"]);
    // Absent, NOT pre-filled `true`: every reader applies the plugin's own
    // enabledByDefault (`states.get(id) ?? h.enabledByDefault`), so a future
    // ship-disabled plugin can still say so.
    expect(states.has("claude-code")).toBe(false);
    expect(states.has("hermes")).toBe(false);
  });

  it("can disable and re-enable a plugin", async () => {
    await repos.harnessPlugins.setEnabled("claude-code", false);
    let states = await repos.harnessPlugins.getEnabledStates(["claude-code"]);
    expect(states.get("claude-code")).toBe(false);

    await repos.harnessPlugins.setEnabled("claude-code", true);
    states = await repos.harnessPlugins.getEnabledStates(["claude-code"]);
    expect(states.get("claude-code")).toBe(true);
  });
});

describe("profiles repository", () => {
  it("insertIfNoneForPair lands once per (user, harness) pair", async () => {
    // The seeder's race guard: one statement, so overlapping seams cannot
    // both insert — a duplicate Default would be permanently undeletable.
    const mk = () => ({
      id: crypto.randomUUID(),
      userId: "race-user",
      harnessId: "claude-code",
      name: "Default",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      isDefault: 1,
    });
    expect(await repos.profiles.insertIfNoneForPair(mk())).toBe(true);
    expect(await repos.profiles.insertIfNoneForPair(mk())).toBe(false);
    // The race shape: with the pair empty again, two overlapping inserts must
    // land exactly one row (the WHERE NOT EXISTS is re-evaluated per
    // statement, and SQLite serialises the writers).
    await db.deleteFrom("profiles").where("userId", "=", "race-user").execute();
    const both = await Promise.all([
      repos.profiles.insertIfNoneForPair(mk()),
      repos.profiles.insertIfNoneForPair(mk()),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    const rows = await repos.profiles.listByUser("race-user");
    expect(rows.length).toBe(1);
    expect(rows[0]?.isDefault).toBe(1);
    await db.deleteFrom("profiles").where("userId", "=", "race-user").execute();
  });

  it("creates and lists profiles for a user, filtered by harness", async () => {
    const created = await repos.profiles.create({
      id: crypto.randomUUID(),
      userId: "u1",
      harnessId: "claude-code",
      name: "Default",
      description: null,
      envJson: '{"ANTHROPIC_MODEL":"sonnet"}',
      flagsJson: '["--permission-mode","plan"]',
      settingsJson: null,
      configIsolation: 0,
    });
    expect(created.id).toBeTruthy();

    const all = await repos.profiles.listByUser("u1");
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Default");

    const filtered = await repos.profiles.listByUser("u1", "hermes");
    expect(filtered).toHaveLength(0);
  });

  it("updates and deletes profiles", async () => {
    const created = await repos.profiles.create({
      id: crypto.randomUUID(),
      userId: "u1",
      harnessId: "claude-code",
      name: "A",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });

    const updated = await repos.profiles.update(created.id, { name: "B", configIsolation: 1 });
    expect(updated?.name).toBe("B");
    expect(updated?.configIsolation).toBe(1);

    await repos.profiles.delete(created.id);
    const gone = await repos.profiles.findById(created.id);
    expect(gone).toBeUndefined();
  });
});

describe("sessions repository", () => {
  it("creates and lists sessions by owner and status", async () => {
    const created = await repos.sessions.create({
      id: crypto.randomUUID(),
      userId: "u1",
      profileId: "p1",
      harnessId: "claude-code",
      name: "My Session",
      workingDir: "/tmp/work",
      tmuxSocket: "mote-abc",
    });
    expect(created.status).toBe("running");

    const running = await repos.sessions.listByUser("u1", "running");
    expect(running).toHaveLength(1);

    const terminated = await repos.sessions.listByUser("u1", "terminated");
    expect(terminated).toHaveLength(0);
  });

  it("marks sessions terminated and running", async () => {
    const created = await repos.sessions.create({
      id: crypto.randomUUID(),
      userId: "u1",
      profileId: "p1",
      harnessId: "claude-code",
      name: "S",
      workingDir: "/tmp",
      tmuxSocket: "mote-def",
    });

    const now = new Date().toISOString();
    await repos.sessions.markTerminated(created.id, now);
    const after = await repos.sessions.findById(created.id);
    expect(after?.status).toBe("terminated");
    expect(after?.endedAt).toBe(now);

    await repos.sessions.markRunning(created.id);
    const revived = await repos.sessions.findById(created.id);
    expect(revived?.status).toBe("running");
    expect(revived?.endedAt).toBeNull();
  });

  it("updateIfRunning applies while running and no-ops once terminated", async () => {
    // The auto-restart race guard: a post-spawn patch must report whether it
    // actually landed. (Regression pin: kysely-bun-sqlite-dialect names the
    // affected-rows count `numUpdatedRows`, not Kysely's `numUpdated` — a
    // wrong read makes every call report 0 and turns successful restarts
    // into "orphans" that get killed.)
    const created = await repos.sessions.create({
      id: crypto.randomUUID(),
      userId: "u-guard",
      profileId: "p1",
      harnessId: "claude-code",
      name: "Guarded",
      workingDir: "/tmp",
      tmuxSocket: "mote-guard",
    });
    expect(await repos.sessions.updateIfRunning(created.id, { alive: 1, backoffCount: 3 })).toBe(1);
    expect((await repos.sessions.findById(created.id))?.backoffCount).toBe(3);

    await repos.sessions.markTerminated(created.id, new Date().toISOString());
    expect(await repos.sessions.updateIfRunning(created.id, { alive: 1, backoffCount: 9 })).toBe(0);
    const after = await repos.sessions.findById(created.id);
    expect(after?.alive).toBe(1); // untouched by the rejected patch
    expect(after?.backoffCount).toBe(3);
    expect(after?.status).toBe("terminated");
  });

  it("parkForRestart matches the observed state and no-ops once it changed", async () => {
    // The manual-restart park is optimistic: it flips the row to
    // running/alive:0 only while the row is STILL as the restart read it.
    // (Regression pin, review #3: a terminate that lands after the read must
    // make this no-op so a killed session is never resurrected by the park.)
    const created = await repos.sessions.create({
      id: crypto.randomUUID(),
      userId: "u-park",
      profileId: "p1",
      harnessId: "claude-code",
      name: "Parked",
      workingDir: "/tmp",
      tmuxSocket: "mote-park",
    });
    // Expected state matches (running/alive 1) → parks.
    expect(await repos.sessions.parkForRestart(created.id, { status: "running", alive: 1 }, { alive: 0 })).toBe(1);
    expect((await repos.sessions.findById(created.id))?.alive).toBe(0);
    // Replaying with the pre-park expectation now misses (alive moved 1→0).
    expect(await repos.sessions.parkForRestart(created.id, { status: "running", alive: 1 }, { alive: 0 })).toBe(0);
  });
});

describe("recent paths repository", () => {
  it("touches paths and lists newest first without duplicates", async () => {
    await repos.recentPaths.touch("u1", "/a");
    await repos.recentPaths.touch("u1", "/b");
    await repos.recentPaths.touch("u1", "/a");

    const list = await repos.recentPaths.listByUser("u1");
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.path)).toEqual(expect.arrayContaining(["/a", "/b"]));
  });
});

describe("settings repository", () => {
  it("gets fallback for missing and round-trips values", async () => {
    expect(await repos.settings.get("missing", "fallback")).toBe("fallback");
    await repos.settings.set("allow_registrations", true);
    expect(await repos.settings.get("allow_registrations", false)).toBe(true);
  });
});

describe("user meta repository", () => {
  it("assigns admin to the first user and counts users", async () => {
    expect(await repos.userMeta.countUsers()).toBe(0);
    await repos.userMeta.upsert({ userId: "u1", role: "admin" });
    expect(await repos.userMeta.getRole("u1")).toBe("admin");
    expect(await repos.userMeta.countUsers()).toBe(1);
  });
});
