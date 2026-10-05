import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { down as down0047, up as up0047 } from "@/db/migrations/0047-ssh-connections.js";
import { down as down0048, up as up0048 } from "@/db/migrations/0048-ssh-execution.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * `ssh_runs` + `ssh_panes` + `ssh_terminal_execs` (SSH-SUPPORT.md §4, Gate A),
 * applied OVER 0047 because they reference its tables. What this pins is the
 * survival grammar of run history: node and connection deletes SET NULL while
 * the row and its immutable snapshot copy stay; the pane row rides the
 * subshell by cascade; the partial active indexes carry the exact WHERE
 * clauses the quota and recovery reads are written against; and the lifecycle
 * defaults say "accepted, nothing observed" - never a fake success.
 */
interface MigrationDb {
  user: { id: string };
  nodes: { id: string };
  subshells: { id: string };
  sshConnections: {
    id: string;
    userId: string;
    nodeId: string;
    displayName: string;
    configSnapshot: string;
    remoteDir: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
  };
  sshGrants: {
    id: string;
    connectionId: string;
    connectionRevision: number;
    subshellId: string;
    apiKeyId: string;
    grantedByUserId: string;
    grantedAt: string;
    revokedAt: string | null;
  };
  // Defaulted columns are optional in the insert shape (the 0040 precedent).
  sshRuns: {
    id: string;
    userId: string;
    nodeId: string | null;
    connectionId: string | null;
    connectionRevision: number;
    configSnapshot: string;
    initiatedBy: string;
    grantId: string | null;
    apiKeyId: string | null;
    command: string;
    remoteDir: string | null;
    requestDigest: string;
    deadlineMs: number;
    status?: string;
    cancelRequested?: number;
    cancelLocalConfirmed?: number;
    deadlineHit?: number;
    remoteStatus?: number | null;
    remoteStatusConfirmed?: number;
    localExitCode?: number | null;
    localExitSignal?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    updatedAt?: string;
  };
  sshPanes: {
    subshellId: string;
    connectionId: string;
    connectionRevision: number;
    initiatedBy: string;
    grantId: string | null;
    apiKeyId: string | null;
    controlOwner: string;
    controlGeneration?: number;
    logGeneration?: number;
    createdAt?: string;
  };
  sshTerminalExecs: {
    id: string;
    subshellId: string;
    paneIncarnation: string;
    initiatedBy: string;
    grantId: string | null;
    apiKeyId: string | null;
    inputGeneration: number;
    markerToken: string;
    state?: string;
    exitCode?: number | null;
    output?: string | null;
    outputTruncated?: number;
    nextByte?: number | null;
    createdAt?: string;
    resolvedAt?: string | null;
  };
}

describe("0048 ssh execution migration", () => {
  let dbFile: string;
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<MigrationDb>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0048-${Math.random().toString(36).slice(2)}.db`;
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<MigrationDb>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE nodes (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE subshells (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO user (id) VALUES ('u1')`.execute(db);
    await sql`INSERT INTO nodes (id) VALUES ('n1')`.execute(db);
    await sql`INSERT INTO subshells (id) VALUES ('p1')`.execute(db);
    await up0047(db as unknown as Kysely<never>);
    await up0048(db as unknown as Kysely<never>);
    await sql`INSERT INTO ssh_connections (id, user_id, node_id, display_name, config_snapshot)
      VALUES ('c1', 'u1', 'n1', 'S', '{"host":"h"}')`.execute(db);
    await sql`INSERT INTO ssh_grants (id, connection_id, connection_revision, subshell_id, api_key_id, granted_by_user_id)
      VALUES ('g1', 'c1', 1, 'p1', 'k1', 'u1')`.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
    sqlite.close();
    await Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  async function insertRun(id: string, nodeId = "n1"): Promise<void> {
    await db
      .insertInto("sshRuns")
      .values({
        id,
        userId: "u1",
        nodeId,
        connectionId: "c1",
        connectionRevision: 1,
        configSnapshot: '{"host":"h"}',
        initiatedBy: "agent",
        grantId: "g1",
        apiKeyId: "k1",
        command: "id",
        remoteDir: null,
        requestDigest: "a".repeat(64),
        deadlineMs: 300_000,
      })
      .execute();
  }

  it("inserts a run defaulting to accepted/unobserved with zeroed fact flags", async () => {
    await insertRun("r1");
    const row = await db.selectFrom("sshRuns").where("id", "=", "r1").selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe("accepted");
    expect(row.cancelRequested).toBe(0);
    expect(row.cancelLocalConfirmed).toBe(0);
    expect(row.deadlineHit).toBe(0);
    expect(row.remoteStatus).toBeNull();
    expect(row.remoteStatusConfirmed).toBe(0);
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).toBeNull();
  });

  it("connection delete SET NULLs the run and keeps the immutable snapshot", async () => {
    await sql`DELETE FROM ssh_connections WHERE id = 'c1'`.execute(db);
    const row = await db.selectFrom("sshRuns").where("id", "=", "r1").selectAll().executeTakeFirstOrThrow();
    expect(row.connectionId).toBeNull();
    expect(row.configSnapshot).toBe('{"host":"h"}');
    // The grant row cascaded with the connection; the run's grant_id SET NULLed.
    const r = await sql<{ id: string }>`SELECT id FROM ssh_runs WHERE id = 'r1'`.execute(db);
    expect(r.rows[0]?.id).toBe("r1");
    // Restore the config rows for later expectations (grants recreated fresh).
    await sql`INSERT INTO ssh_connections (id, user_id, node_id, display_name, config_snapshot)
      VALUES ('c1', 'u1', 'n1', 'S', '{"host":"h"}')`.execute(db);
    await sql`INSERT INTO ssh_grants (id, connection_id, connection_revision, subshell_id, api_key_id, granted_by_user_id)
      VALUES ('g1', 'c1', 1, 'p1', 'k1', 'u1')`.execute(db);
    await db.updateTable("sshRuns").set({ grantId: "g1" }).where("id", "=", "r1").execute();
  });

  it("node delete SET NULLs the run's node while the history row survives", async () => {
    await sql`DELETE FROM nodes WHERE id = 'n1'`.execute(db);
    const row = await db.selectFrom("sshRuns").where("id", "=", "r1").selectAll().executeTakeFirstOrThrow();
    expect(row.nodeId).toBeNull();
    // The delete cascaded the connection (and with it the grant): restore the
    // config pair so the pane/exec tests below have their FK targets again.
    await sql`INSERT INTO nodes (id) VALUES ('n1')`.execute(db);
    await sql`INSERT INTO ssh_connections (id, user_id, node_id, display_name, config_snapshot)
      VALUES ('c1', 'u1', 'n1', 'S', '{"host":"h"}')`.execute(db);
    await sql`INSERT INTO ssh_grants (id, connection_id, connection_revision, subshell_id, api_key_id, granted_by_user_id)
      VALUES ('g1', 'c1', 1, 'p1', 'k1', 'u1')`.execute(db);
  });

  it("managed pane row keys on the subshell, defaults generations to 1, cascades with the pane", async () => {
    await db
      .insertInto("sshPanes")
      .values({
        subshellId: "p1",
        connectionId: "c1",
        connectionRevision: 1,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        controlOwner: "human",
      })
      .execute();
    const pane = await db.selectFrom("sshPanes").where("subshellId", "=", "p1").selectAll().executeTakeFirstOrThrow();
    expect(pane.controlGeneration).toBe(1);
    expect(pane.logGeneration).toBe(1);
    expect(typeof pane.createdAt).toBe("string");
    await sql`DELETE FROM subshells WHERE id = 'p1'`.execute(db);
    const gone = await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", "p1").executeTakeFirst();
    expect(gone).toBeUndefined();
    await sql`INSERT INTO subshells (id) VALUES ('p1')`.execute(db);
  });

  it("terminal exec defaults to outstanding with a null result", async () => {
    await db
      .insertInto("sshTerminalExecs")
      .values({
        id: "e1",
        subshellId: "p1",
        paneIncarnation: "2026-10-04T00:00:00.000Z",
        initiatedBy: "agent",
        grantId: null,
        apiKeyId: "k1",
        inputGeneration: 1,
        markerToken: "0123456789abcdef",
      })
      .execute();
    const row = await db.selectFrom("sshTerminalExecs").where("id", "=", "e1").selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe("outstanding");
    expect(row.exitCode).toBeNull();
    expect(row.nextByte).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("the partial indexes carry exactly the WHERE clauses the quota/recovery reads assume", async () => {
    const r = await sql<{ name: string; sql: string | null }>`
      SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
    `.execute(db);
    const byName = new Map(r.rows.map((row) => [row.name, row.sql ?? ""]));
    expect(byName.get("idx_ssh_runs_active")).toContain("WHERE status IN ('accepted', 'running')");
    expect(byName.get("idx_ssh_runs_grant")).toContain("WHERE status IN ('accepted', 'running')");
    expect(byName.get("idx_ssh_terminal_execs_outstanding")).toContain("WHERE state = 'outstanding'");
    const unique = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_ssh_grants_active'
    `.execute(db);
    expect(unique.rows).toHaveLength(1);
  });

  it("down drops the execution tables, leaving 0047's pair for its own down", async () => {
    await down0048(db as unknown as Kysely<never>);
    for (const name of ["ssh_runs", "ssh_panes", "ssh_terminal_execs"]) {
      const r = await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);
      expect(r.rows).toHaveLength(0);
    }
    await down0047(db as unknown as Kysely<never>);
    for (const name of ["ssh_connections", "ssh_grants"]) {
      const r = await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);
      expect(r.rows).toHaveLength(0);
    }
  });
});
