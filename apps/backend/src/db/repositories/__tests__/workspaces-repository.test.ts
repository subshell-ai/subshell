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
import { openSqliteDatabase } from "@/db/open-database.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const workspaces = new WorkspacesRepository(db);
const panes = new WorkspacePanesRepository(db);
const profiles = new ProfilesRepository(db);
const sessions = new SessionsRepository(db);

/** Creates a profile + session owned by `userId`, returning the session id. */
async function makeSession(userId: string): Promise<string> {
  const profile = await profiles.create({
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
  await sessions.create({
    id,
    userId,
    profileId: profile.id,
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
  await profileDefaultFlagMigration.up(db); // ProfilesRepository.create writes is_default
  await sessionNameLockedMigration.up(db); // SessionsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // sessions.harness_session_id
  await sessionNotificationsMigration.up(db); // sessions.notify / waiting_since + subscriptions
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

    await workspaces.delete(created.id);
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeUndefined();
  });
});

describe("workspace panes repository", () => {
  it("creates and lists panes for a workspace", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W" });
    const sessionId = await makeSession("u1");
    const created = await panes.create({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      sessionId,
    });

    const list = await panes.listByWorkspace(ws.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("deletes a pane", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W2" });
    const paneId = crypto.randomUUID();
    await panes.create({
      id: paneId,
      workspaceId: ws.id,
      sessionId: await makeSession("u1"),
    });
    expect(await panes.listByWorkspace(ws.id)).toHaveLength(1);

    await panes.delete(paneId);

    expect(await panes.listByWorkspace(ws.id)).toHaveLength(0);
  });
});
