import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as workspaceDraftsMigration from "@/db/migrations/0029-workspace-drafts.js";
import * as crossAgentMigration from "@/db/migrations/0039-subshell-cross-agent.js";
import * as presetLaunchFieldsMigration from "@/db/migrations/0042-preset-launch-fields.js";
import * as presetCrossCommOptInMigration from "@/db/migrations/0043-preset-cross-comm-opt-in.js";
import * as subshellKeyHomeMigration from "@/db/migrations/0052-subshell-key-home.js";
import * as workspaceFirstMigration from "@/db/migrations/0058-workspace-first.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const workspaces = new WorkspacesRepository(db);
const panes = new WorkspacePanesRepository(db);
const presets = new PresetsRepository(db);
const subshells = new SubshellsRepository(db);

/** Creates a preset + subshell owned by `userId`, returning the subshell id. */
async function makeSubshell(userId: string): Promise<string> {
  const preset = await presets.create({
    id: crypto.randomUUID(),
    userId,
    harnessId: "claude-code",
    name: `p-${crypto.randomUUID().slice(0, 8)}`,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
  });
  const id = crypto.randomUUID();
  await subshells.create({
    id,
    userId,
    presetId: preset.id,
    harnessId: "claude-code",
    name: "s",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  return id;
}

beforeAll(async () => {
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await workspacesMigration.up(db);
  await profileDefaultFlagMigration.up(db); // 0010's is_default flag (dropped again by 0027)
  await sessionNameLockedMigration.up(db); // SubshellsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // subshells.harness_session_id
  await sessionNotificationsMigration.up(db); // subshells.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // subshells.node_id (SubshellsRepository.create writes it)
  await sharingMigration.up(db); // 0019 renames session_shares
  await subshellRenameMigration.up(db); // renamed schema the code sees
  await presetsMigration.up(db); // profiles → presets (spec 2026-09-13 §6)
  await workspaceDraftsMigration.up(db); // workspaces.draft — listByUser filters on it
  await crossAgentMigration.up(db); // subshells.cross_agent — SubshellsRepository.create writes it (2026-09-25)
  await presetLaunchFieldsMigration.up(db); // presets launch trio (0042) - the repository create enumerates it
  await presetCrossCommOptInMigration.up(db); // presets.cross_comm_enabled (0043) - same reason
  await subshellKeyHomeMigration.up(db); // 0052 subshells.key_home_node_id - SubshellsRepository.create mirrors it on every insert (Task 14)
  await workspaceFirstMigration.up(db); // 0058 drops workspaces.draft, adds the pane-dedupe unique index
});

beforeEach(async () => {
  await db.deleteFrom("workspacePanes").execute();
  await db.deleteFrom("workspaces").execute();
});

describe("workspaces repository", () => {
  it("lists only the owner's workspaces, ordered by name", async () => {
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Theta" });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Alpha" });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u2", name: "Other" });

    const mine = await workspaces.listByUser("u1");
    expect(mine.map((w) => w.name)).toEqual(["Alpha", "Theta"]);
  });

  it("findByIdForUser hides another user's workspace", async () => {
    const created = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Mine" });
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeTruthy();
    expect(await workspaces.findByIdForUser(created.id, "u2")).toBeUndefined();
  });

  it("updates the layout and deletes", async () => {
    const created = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W" });
    const updated = await workspaces.update(created.id, { layoutJson: '{"grid":{}}' });
    expect(updated?.layoutJson).toBe('{"grid":{}}');
    // The stamp must stay comparable with the one `create` writes, or ordering
    // by `updated_at` puts every touched row below every untouched one.
    expect(updated?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await workspaces.delete(created.id);
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeUndefined();
  });

  it("accepts duplicate names (the unique index is gone; ids are the key)", async () => {
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Oct 17, 5:21 PM" });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Oct 17, 5:21 PM" });

    expect(await workspaces.listByUser("u1")).toHaveLength(2);
  });

  it("retireEmptyForUser deletes the owner's pane-less workspaces and counts them", async () => {
    const filled = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Filled" });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Empty" });
    const foreignEmpty = await workspaces.create({ id: crypto.randomUUID(), userId: "u2", name: "Theirs" });
    const subshellId = await makeSubshell("u1");
    await panes.create({ id: crypto.randomUUID(), workspaceId: filled.id, subshellId });

    expect(await workspaces.retireEmptyForUser("u1")).toBe(1);
    expect(await workspaces.findByIdForUser(filled.id, "u1")).toBeTruthy();
    expect(await workspaces.findByIdForUser(foreignEmpty.id, "u2")).toBeTruthy();
    const left = await workspaces.listByUser("u1");
    expect(left.map((w) => w.id)).toEqual([filled.id]);
  });

  it("listBySubshellForUser returns holding workspaces newest first", async () => {
    const subshellId = await makeSubshell("u1");
    const older = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Older" });
    const newer = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Newer" });
    const foreign = await workspaces.create({ id: crypto.randomUUID(), userId: "u2", name: "Foreign" });
    const empty = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Empty" });

    await panes.create({ id: crypto.randomUUID(), workspaceId: older.id, subshellId });
    await panes.create({ id: crypto.randomUUID(), workspaceId: newer.id, subshellId });
    await panes.create({ id: crypto.randomUUID(), workspaceId: foreign.id, subshellId });

    // Stamped explicitly: inserts can land inside one millisecond, and a
    // tie would make the assertion below flaky rather than wrong.
    await db
      .updateTable("workspaces")
      .set({ updatedAt: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", older.id)
      .execute();
    await db
      .updateTable("workspaces")
      .set({ updatedAt: "2026-02-01T00:00:00.000Z" })
      .where("id", "=", newer.id)
      .execute();

    const mine = await workspaces.listBySubshellForUser("u1", subshellId);
    expect(mine.map((w) => w.id)).toEqual([newer.id, older.id]);
    expect(mine.map((w) => w.id)).not.toContain(empty.id);
    // Another user's workspace holding the same subshell is invisible here.
    expect(await workspaces.listBySubshellForUser("u2", subshellId)).toHaveLength(1);
  });
});

describe("workspace panes repository", () => {
  it("creates and lists panes for a workspace", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W" });
    const subshellId = await makeSubshell("u1");
    const created = await panes.create({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      subshellId,
    });

    const list = await panes.listByWorkspace(ws.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("refuses a second pane for the same subshell in one workspace (0058 unique index)", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W-dedupe" });
    const subshellId = await makeSubshell("u1");
    await panes.create({ id: crypto.randomUUID(), workspaceId: ws.id, subshellId });

    expect(await panes.findByWorkspaceAndSubshell(ws.id, subshellId)).toBeTruthy();
    // Regression #13 made impossible at the schema level: the double insert
    // throws instead of quietly making a second tab.
    await expect(panes.create({ id: crypto.randomUUID(), workspaceId: ws.id, subshellId })).rejects.toThrow("UNIQUE");
    expect(await panes.listByWorkspace(ws.id)).toHaveLength(1);

    // The same subshell in ANOTHER workspace is the many-homes rule, still fine.
    const other = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W-also" });
    expect(await panes.create({ id: crypto.randomUUID(), workspaceId: other.id, subshellId })).toBeTruthy();
  });

  it("deletes a pane", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W2" });
    const paneId = crypto.randomUUID();
    await panes.create({
      id: paneId,
      workspaceId: ws.id,
      subshellId: await makeSubshell("u1"),
    });
    expect(await panes.listByWorkspace(ws.id)).toHaveLength(1);

    await panes.delete(paneId);

    expect(await panes.listByWorkspace(ws.id)).toHaveLength(0);
  });
});
