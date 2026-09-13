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
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const repos = {
  presets: new PresetsRepository(db),
  subshells: new SubshellsRepository(db),
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
  await profileDefaultFlagMigration.up(db); // 0010's is_default flag (dropped again by 0027)
  await sessionNameLockedMigration.up(db); // SubshellsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // subshells.harness_session_id
  await sessionNotificationsMigration.up(db); // subshells.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // recent_paths.node_id + the (user, node, path) unique index
  await sharingMigration.up(db); // 0019 renames session_shares
  await subshellRenameMigration.up(db); // renamed schema the code sees
  await presetsMigration.up(db); // profiles → presets (spec 2026-09-13 §6)
});

beforeEach(async () => {
  // fresh data per test
  await db.deleteFrom("recentPaths").execute();
  await db.deleteFrom("subshells").execute();
  await db.deleteFrom("presets").execute();
  await db.deleteFrom("userMeta").execute();
  await db.deleteFrom("settings").execute();
});

describe("presets repository", () => {
  it("creates and lists presets for a user, filtered by harness", async () => {
    const created = await repos.presets.create({
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

    const all = await repos.presets.listByUser("u1");
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Default");

    const filtered = await repos.presets.listByUser("u1", "hermes");
    expect(filtered).toHaveLength(0);
  });

  it("updates and deletes presets", async () => {
    const created = await repos.presets.create({
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

    const updated = await repos.presets.update(created.id, { name: "B", configIsolation: 1 });
    expect(updated?.name).toBe("B");
    expect(updated?.configIsolation).toBe(1);

    await repos.presets.delete(created.id);
    const gone = await repos.presets.findById(created.id);
    expect(gone).toBeUndefined();
  });
});

describe("subshells repository", () => {
  it("creates and lists subshells by owner and status", async () => {
    const created = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId: "u1",
      presetId: "p1",
      harnessId: "claude-code",
      name: "My Subshell",
      workingDir: "/tmp/work",
      tmuxSocket: "subshell-abc",
    });
    expect(created.status).toBe("running");

    const running = await repos.subshells.listByUser("u1", "running");
    expect(running).toHaveLength(1);

    const terminated = await repos.subshells.listByUser("u1", "terminated");
    expect(terminated).toHaveLength(0);
  });

  it("marks subshells terminated and running", async () => {
    const created = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId: "u1",
      presetId: "p1",
      harnessId: "claude-code",
      name: "S",
      workingDir: "/tmp",
      tmuxSocket: "subshell-def",
    });

    const now = new Date().toISOString();
    await repos.subshells.markTerminated(created.id, now);
    const after = await repos.subshells.findById(created.id);
    expect(after?.status).toBe("terminated");
    expect(after?.endedAt).toBe(now);

    await repos.subshells.markRunning(created.id);
    const revived = await repos.subshells.findById(created.id);
    expect(revived?.status).toBe("running");
    expect(revived?.endedAt).toBeNull();
  });

  it("updateIfRunning applies while running and no-ops once terminated", async () => {
    // The auto-restart race guard: a post-spawn patch must report whether it
    // actually landed. (Regression pin: kysely-bun-sqlite-dialect names the
    // affected-rows count `numUpdatedRows`, not Kysely's `numUpdated` — a
    // wrong read makes every call report 0 and turns successful restarts
    // into "orphans" that get killed.)
    const created = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId: "u-guard",
      presetId: "p1",
      harnessId: "claude-code",
      name: "Guarded",
      workingDir: "/tmp",
      tmuxSocket: "subshell-guard",
    });
    expect(await repos.subshells.updateIfRunning(created.id, { alive: 1, backoffCount: 3 })).toBe(1);
    expect((await repos.subshells.findById(created.id))?.backoffCount).toBe(3);

    await repos.subshells.markTerminated(created.id, new Date().toISOString());
    expect(await repos.subshells.updateIfRunning(created.id, { alive: 1, backoffCount: 9 })).toBe(0);
    const after = await repos.subshells.findById(created.id);
    expect(after?.alive).toBe(1); // untouched by the rejected patch
    expect(after?.backoffCount).toBe(3);
    expect(after?.status).toBe("terminated");
  });

  it("parkForRestart matches the observed state and no-ops once it changed", async () => {
    // The manual-restart park is optimistic: it flips the row to
    // running/alive:0 only while the row is STILL as the restart read it.
    // (Regression pin, review #3: a terminate that lands after the read must
    // make this no-op so a killed subshell is never resurrected by the park.)
    const created = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId: "u-park",
      presetId: "p1",
      harnessId: "claude-code",
      name: "Parked",
      workingDir: "/tmp",
      tmuxSocket: "subshell-park",
    });
    // Expected state matches (running/alive 1) → parks.
    expect(await repos.subshells.parkForRestart(created.id, { status: "running", alive: 1 }, { alive: 0 })).toBe(1);
    expect((await repos.subshells.findById(created.id))?.alive).toBe(0);
    // Replaying with the pre-park expectation now misses (alive moved 1→0).
    expect(await repos.subshells.parkForRestart(created.id, { status: "running", alive: 1 }, { alive: 0 })).toBe(0);
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

  it("lists per node: the read side matches the per-node write side", async () => {
    // Same path touched under two nodes — the default (local) read must see
    // only the local row; the remote row is visible only by name.
    await repos.recentPaths.touch("u-node", "/shared", null, "node-x");
    await repos.recentPaths.touch("u-node", "/shared");
    expect(await repos.recentPaths.listByUser("u-node")).toEqual([{ path: "/shared", label: null }]);
    expect(await repos.recentPaths.listByUser("u-node", 20, "node-x")).toEqual([{ path: "/shared", label: null }]);
    // A node nobody touched reads empty even though the path exists elsewhere.
    expect(await repos.recentPaths.listByUser("u-node", 20, "node-y")).toEqual([]);
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
