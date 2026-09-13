import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxRunner } from "@internal/pane-runtime";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as channelsMigration from "@/db/migrations/0009-channels.js";
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
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import type { SubshellTable, SubshellUpdate } from "@/db/types/subshells.db-types.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { subshellMcpConfigPath } from "@/services/mcp-launch.js";
import { SubshellManagerService, type SubshellTokenProvider } from "@/services/subshell-manager.service.js";

/**
 * The MCP-facing half of the subshell lifecycle, hermetically: a scripted
 * TmuxRunner records what tmux WOULD receive (no real tmux), and a stub
 * token provider replaces better-auth. Covers: SUBSHELL_* env baking, prompt
 * delivery after pane-settle (and the not-delivered path), token revoke on
 * the lifecycle hooks, the bounded auto-restart under persistent spawn
 * failure, and the restart-vs-terminate race (including the revoke-failure
 * unlink fallback).
 */

/** Records every pane interaction; capturePane answers from a script. */
class MockTmux extends TmuxRunner {
  newSubshellCmds: string[] = [];
  inputs: string[] = [];
  enters = 0;
  kills: string[] = [];
  alive = true;
  /** When true, newSubshell records the attempt then throws (simulated spawn failure). */
  failSpawn = false;
  /** When true, pipePane throws (simulated log-attach failure). */
  failPipe = false;
  /** capturePane returns script[i] on the i-th call (last entry repeats). */
  captureScript: string[] = [""];

  override newSubshell(_socket: string, _sessionName: string, _cwd: string, cmd: string): void {
    this.newSubshellCmds.push(cmd);
    if (this.failSpawn) throw new Error("spawn failed (test)");
  }
  override pipePane(): void {
    if (this.failPipe) throw new Error("pipe-pane attach failed (test)");
  }
  override hasSubshell(): boolean {
    return this.alive;
  }
  override capturePane(): string {
    const v = this.captureScript[0] ?? "";
    if (this.captureScript.length > 1) this.captureScript.shift();
    return v;
  }
  override sendInput(_socket: string, _sessionName: string, input: string): void {
    this.inputs.push(input);
  }
  override pressEnter(): void {
    this.enters++;
  }
  override killSubshell(_socket: string, subshellName: string): void {
    this.kills.push(subshellName);
  }
  override paneExitCode(): number | null {
    return null;
  }
}

/** Counts token-provider calls; keys are obviously fake. */
class StubTokens implements SubshellTokenProvider {
  issued: string[] = [];
  revoked: string[] = [];
  async issue(subshellId: string): Promise<string> {
    this.issued.push(subshellId);
    return `subshell_stub_${subshellId.slice(0, 8)}`;
  }
  async revoke(subshellId: string): Promise<void> {
    this.revoked.push(subshellId);
  }
}

const testDir = mkdtempSync(join(tmpdir(), "subshell-mcp-test-"));
let db: Kysely<Database>;
let presets: PresetsRepository;
let subshells: SubshellsRepository;
let tmux: MockTmux;
let tokens: StubTokens;
let manager: SubshellManagerService;
let presetId: string;
let previousClaudePath: string | undefined;

beforeAll(async () => {
  const harnessStub = join(testDir, "claude-stub");
  writeFileSync(harnessStub, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
  previousClaudePath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = harnessStub;

  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await channelsMigration.up(db);
  await profileDefaultFlagMigration.up(db); // 0010's is_default flag (dropped again by 0027) // adds subshells.api_key_id
  await sessionNameLockedMigration.up(db); // SubshellsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // subshells.harness_session_id
  await sessionNotificationsMigration.up(db); // subshells.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // subshells.node_id (SubshellsRepository.create writes it)
  await sharingMigration.up(db); // 0019 renames session_shares
  await subshellRenameMigration.up(db); // renamed schema the code sees
  await presetsMigration.up(db); // profiles → presets (spec 2026-09-13 §6)
  presets = new PresetsRepository(db);
  subshells = new SubshellsRepository(db);
  presetId = await seedPreset(presets);
});

beforeEach(() => {
  tmux = new MockTmux();
  tokens = new StubTokens();
  manager = new SubshellManagerService({ subshells, presets, tmux, tokens, audit: async () => {} });
});

afterAll(() => {
  if (previousClaudePath === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = previousClaudePath;
  // The per-harness stub paths must not outlive this file (bun test runs every
  // file in one process; a stale OPENCODE_PATH would skew other suites' detection).
  delete process.env.OPENCODE_PATH;
  delete process.env.HERMES_PATH;
  db.destroy().catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("createSubshell MCP integration", () => {
  it("bakes SUBSHELL_API_KEY / SUBSHELL_BASE_URL / SUBSHELL_ID into the tmux command", async () => {
    const created = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    expect(tokens.issued).toEqual([created.id]);
    const cmd = tmux.newSubshellCmds[0] ?? "";
    expect(cmd).toContain(`SUBSHELL_API_KEY='subshell_stub_${created.id.slice(0, 8)}'`);
    expect(cmd).toContain(`SUBSHELL_ID='${created.id}'`);
    expect(cmd).toMatch(/SUBSHELL_BASE_URL='http/);
    await manager.terminateSubshell("u1", created.id);
  });

  it("types the prompt after the pane shows output, then presses Enter", async () => {
    tmux.captureScript = ["", "", "claude> ready"];
    const created = await manager.createSubshell({
      userId: "u1",
      presetId,
      workingDir: testDir,
      prompt: "fix the flaky test",
      promptSettleTimeoutMs: 1500,
      promptPollMs: 10,
    });
    expect(created.promptDelivered).toBe(true);
    expect(tmux.inputs).toEqual(["fix the flaky test"]);
    expect(tmux.enters).toBe(1);
    await manager.terminateSubshell("u1", created.id);
  });

  it("never-settling pane: subshell stays up, prompt reported undelivered", async () => {
    tmux.captureScript = [""]; // forever blank
    const created = await manager.createSubshell({
      userId: "u1",
      presetId,
      workingDir: testDir,
      prompt: "hello",
      promptSettleTimeoutMs: 100,
      promptPollMs: 10,
    });
    expect(created.promptDelivered).toBe(false);
    expect(tmux.inputs).toEqual([]);
    const row = await subshells.findById(created.id);
    expect(row?.status).toBe("running");
    await manager.terminateSubshell("u1", created.id);
  });

  it("renders the subshell-mcp config, registers it with the harness, and cleans up on delete", async () => {
    const created = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    const cfg = JSON.parse(readFileSync(subshellMcpConfigPath(created.id), "utf8")) as {
      mcpServers: { subshell: { command: string; args: string[] } };
    };
    expect(cfg.mcpServers.subshell.command).toBeTruthy();
    // Self rung (spec 2026-09-03): the launch is `<interpreter> <abs entry> mcp`
    // and under `bun test` the entry is whatever argv[1] the runner set (a test
    // file), so pin the ARGV TAIL — the contract is the `mcp` subcommand, not
    // an entry filename the resolver no longer hunts for.
    expect(cfg.mcpServers.subshell.args.at(-1)).toBe("mcp");
    expect(cfg.mcpServers.subshell.args.length).toBe(2);
    // No secrets in the on-disk config (the child inherits SUBSHELL_* from the pane).
    expect(readFileSync(subshellMcpConfigPath(created.id), "utf8")).not.toContain("subshell_stub");
    // claude-code adds the flag pointing at exactly this file.
    expect(tmux.newSubshellCmds[0]).toContain(`'--mcp-config' '${subshellMcpConfigPath(created.id)}'`);
    await manager.deleteSubshell("u1", created.id);
    expect(existsSync(subshellMcpConfigPath(created.id))).toBe(false);
  });

  it("terminate revokes the subshell's token", async () => {
    const created = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    await manager.terminateSubshell("u1", created.id);
    expect(tokens.revoked).toEqual([created.id]);
  });

  it("delete revokes too", async () => {
    const created = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    await manager.deleteSubshell("u1", created.id);
    expect(tokens.revoked).toEqual([created.id]);
  });

  it("reconcile revokes a dead non-restarting subshell", async () => {
    const created = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    tmux.alive = false; // crash: pane gone
    await manager.reconcile("u1");
    expect(tokens.revoked).toEqual([created.id]);
  });

  it("restart rotates the token on the SAME row", async () => {
    const first = await manager.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    const restarted = await manager.restartSubshell("u1", first.id);
    if (!restarted) throw new Error("restart returned null");
    expect(restarted.id).toBe(first.id);
    // Revocation of the dead process's key is the auto path's pattern:
    // revoke-then-issue on the same id, apiKeyId rewritten by `issue`.
    expect(tokens.issued).toEqual([first.id, first.id]);
    expect(tokens.revoked).toContain(first.id);
  });
});

describe("createSubshell MCP registration per harness dialect", () => {
  /** Create a preset for an arbitrary harness and a PATH-override stub binary. */
  async function harnessPreset(harnessId: string, pathEnv: string, env?: Record<string, string>): Promise<string> {
    const stub = join(testDir, `${harnessId}-stub`);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env[pathEnv] = stub;
    return seedPreset(presets, {
      harnessId,
      name: `p-${harnessId}`,
      envJson: env ? JSON.stringify(env) : null,
    });
  }

  it("opencode: writes a merged config layer and exports OPENCODE_CONFIG to the pane", async () => {
    const pid = await harnessPreset("opencode", "OPENCODE_PATH");
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    const cfgPath = subshellMcpConfigPath(created.id);
    const cmd = tmux.newSubshellCmds[0] ?? "";
    // The env is baked into the pane command (buildHarnessCommand's env -i list),
    // so BOTH the argv-less launch and the child opencode process see it.
    expect(cmd).toContain(`OPENCODE_CONFIG='${cfgPath}'`);
    const doc = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      mcp: Record<string, { type: string; command: string[] }>;
    };
    // opencode's own dialect: `mcp` + argv ARRAY — not claude's mcpServers.
    expect(doc.mcp.subshell?.type).toBe("local");
    expect(Array.isArray(doc.mcp.subshell?.command)).toBe(true);
    expect(cmd).not.toContain("--mcp-config");
    await manager.deleteSubshell("u1", created.id);
  });

  it("opencode: the wiring env beats a preset that sets OPENCODE_CONFIG itself", async () => {
    // Regression: OPENCODE_CONFIG carried only one path, and preset env used
    // to spread last — a preset setting it (the CLI documents the var!)
    // silently dropped the subshell's subshell tools while the UI promised auto.
    const pid = await harnessPreset("opencode", "OPENCODE_PATH", { OPENCODE_CONFIG: "/home/user/my.json" });
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    const cmd = tmux.newSubshellCmds[0] ?? "";
    expect(cmd).toContain(`OPENCODE_CONFIG='${subshellMcpConfigPath(created.id)}'`);
    expect(cmd).not.toContain("/home/user/my.json");
    await manager.deleteSubshell("u1", created.id);
  });

  it("hermes: registers nothing and injects no MCP wiring (manual harness)", async () => {
    const pid = await harnessPreset("hermes", "HERMES_PATH");
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    const cmd = tmux.newSubshellCmds[0] ?? "";
    expect(cmd).not.toContain("--mcp-config");
    expect(existsSync(subshellMcpConfigPath(created.id))).toBe(false);
    // Manual harnesses rely on the one-time registration; the SUBSHELL_* env is
    // still baked so the globally-registered child authenticates per subshell.
    expect(cmd).toContain("SUBSHELL_API_KEY=");
    await manager.deleteSubshell("u1", created.id);
  });

  it("auto-restart re-issues the token and rewrites the config before respawning", async () => {
    // The path a stale-token regression would hide in: crash → reconcile →
    // same subshell id, rotated credential, config file rewritten from scratch.
    const pid = await seedPreset(presets);
    await presets.update(pid, { restartOnExit: 1 });
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    const cfgPath = subshellMcpConfigPath(created.id);
    // Simulate the crash + due backoff the reconciler looks for.
    tmux.alive = false;
    writeFileSync(cfgPath, "STALE ON DISK");
    await subshells.update(created.id, {
      alive: 0,
      exitCode: 1,
      backoffCount: 0,
      endedAt: new Date(Date.now() - 2_000).toISOString(),
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await manager.reconcileAll();
    // A second pane command was built, with the token rotated through revoke+issue.
    expect(tmux.newSubshellCmds.length).toBe(2);
    expect(tmux.newSubshellCmds[1]).toContain("SUBSHELL_API_KEY=");
    expect(tokens.issued).toEqual([created.id, created.id]);
    expect(tokens.revoked).toContain(created.id);
    // The config was rewritten before the respawn, not left stale.
    expect(readFileSync(cfgPath, "utf8")).not.toContain("STALE ON DISK");
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.subshell).toBeTruthy();
    await manager.deleteSubshell("u1", created.id);
  });
});

describe("auto-restart failure bounds + terminate race", () => {
  beforeEach(async () => {
    // Earlier suites leave RUNNING rows behind (e.g. the restart-lineage test
    // never terminates its pair); reconcileAll() is server-wide, so those
    // leftovers would be swept + revoked through THIS suite's token stubs and
    // skew the exact-count assertions. Start each sweep test from empty.
    await db.deleteFrom("subshells").execute();
  });

  /** Crash-stamp a running row so the next sweep is allowed to restart it. */
  const stampCrashDue = (id: string) =>
    subshells.update(id, {
      alive: 0,
      exitCode: 1,
      endedAt: new Date(Date.now() - 2_000).toISOString(),
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });

  /** A restart-on-exit preset + a created (mock-spawned) live subshell. */
  async function liveRestartable(): Promise<string> {
    const pid = await seedPreset(presets, { name: `p-${crypto.randomUUID().slice(0, 8)}` });
    await presets.update(pid, { restartOnExit: 1 });
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    return created.id;
  }

  it("persistent spawn failure reaches the terminal revoke within bounded sweeps", async () => {
    // Regression: backoffCount used to advance only on a SUCCESSFUL spawn, so
    // a subshell whose spawn always failed (deleted binary) rotated its MCP
    // token every sweep forever and never hit the documented give-up.
    const id = await liveRestartable();
    tmux.alive = false; // pane gone
    tmux.failSpawn = true; // and every respawn attempt throws
    await stampCrashDue(id);

    const spawnCap = 12; // limit is 5 attempts; anything unbounded trips this
    let sweeps = 0;
    let row = await subshells.findById(id);
    while (sweeps < spawnCap && (row?.backoffCount ?? 0) < 5) {
      await manager.reconcileAll();
      sweeps++;
      row = await subshells.findById(id);
    }
    expect(sweeps).toBeLessThanOrEqual(6); // NOT forever — the limit is 5 attempts
    expect(row?.backoffCount).toBe(5);
    expect(row?.alive).toBe(0);
    // 1 create spawn + 5 recorded-but-failed attempts, then the sweep stops trying.
    expect(tmux.newSubshellCmds.length).toBe(6);
    expect(tokens.issued.length).toBe(6); // create + one rotation per failed attempt

    // The next sweep sees the exhausted limit and performs the terminal revoke.
    const revokedBefore = tokens.revoked.length;
    await manager.reconcileAll();
    expect(tokens.revoked.length).toBe(revokedBefore + 1);
    expect(tokens.revoked).toContain(id);

    // Exhaustion is terminal: no more rotations, no more spawn attempts.
    await manager.reconcileAll();
    expect(tokens.issued.length).toBe(6);
    expect(tmux.newSubshellCmds.length).toBe(6);
    await manager.deleteSubshell("u1", id);
  });

  it("terminate between token issue and spawn: no pane, the fresh token is revoked", async () => {
    const id = await liveRestartable();
    const revoked: string[] = [];
    // The race: the operator's terminate lands exactly in the window between
    // the (awaited) token issue and the pre-spawn row re-read.
    const racyTokens: SubshellTokenProvider = {
      issue: async (subshellId) => {
        await subshells.markTerminated(subshellId, new Date().toISOString());
        await subshells.update(subshellId, { alive: 0 });
        return "subshell_late";
      },
      revoke: async (subshellId) => {
        revoked.push(subshellId);
      },
    };
    manager = new SubshellManagerService({ subshells, presets, tmux, tokens: racyTokens, audit: async () => {} });
    tmux.alive = false;
    await stampCrashDue(id);

    await manager.reconcileAll();
    // The pre-spawn re-read caught the kill: only the create ever spawned a pane.
    expect(tmux.newSubshellCmds.length).toBe(1);
    // Old key revoked (rotation), and the just-issued one retired (cleanup).
    expect(revoked).toEqual([id, id]);
    const row = await subshells.findById(id);
    expect(row?.status).toBe("terminated");
    expect(row?.alive).toBe(0);
    await manager.deleteSubshell("u1", id);
  });

  it("row terminated under the sweep: no death stamp, no push, no revoke (async-seam TOCTOU, spec §6.3)", async () => {
    // The window the async probes open: the snapshot said running/alive,
    // hasSubshell says false, but a terminate lands during the awaits. The
    // post-probe re-read reports it (simulated here by a findById that
    // answers with the post-terminate state) — the sweep must back off
    // entirely: stamping and retiring the token belong to the terminate.
    const pid = await seedPreset(presets, { name: `toctou-${crypto.randomUUID().slice(0, 8)}` });
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    tmux.alive = false; // the pane is gone by sweep time
    const notified: string[] = [];
    class RereadingSubshells extends SubshellsRepository {
      override async findById(id: string): Promise<SubshellTable | undefined> {
        const row = await super.findById(id);
        // Exactly what the reconcile's post-probe re-read would see after a
        // terminate (which also flips alive) — a terminated row.
        return row && row.alive === 1 ? { ...row, status: "terminated" } : row;
      }
    }
    manager = new SubshellManagerService({
      subshells: new RereadingSubshells(db),
      presets,
      tmux,
      tokens,
      audit: async () => {},
      notify: async (id) => {
        notified.push(id);
      },
    });
    await manager.reconcileAll();
    expect(tokens.revoked).not.toContain(created.id);
    expect(notified).toEqual([]);
    // Untouched by the sweep (the fake terminate was read-only by design):
    const row = await subshells.findById(created.id);
    expect(row?.status).toBe("running");
    expect(row?.alive).toBe(1);
    expect(row?.endedAt).toBeNull();
  });

  it("terminate between spawn and the post-spawn patch: row stays terminated, orphan cleaned", async () => {
    // The tighter race: terminate lands after the pre-spawn check and after
    // newSubshell — deterministically simulated INSIDE updateIfRunning, which
    // is the awaited boundary between the spawn and the conditional patch.
    class RacySubshells extends SubshellsRepository {
      override async updateIfRunning(id: string, update: SubshellUpdate): Promise<number> {
        await this.markTerminated(id, new Date().toISOString());
        await this.update(id, { alive: 0 });
        return super.updateIfRunning(id, update); // must now match 0 rows
      }
    }
    const racy = new RacySubshells(db);
    const pid = await seedPreset(presets, { name: `race-${crypto.randomUUID().slice(0, 8)}` });
    await presets.update(pid, { restartOnExit: 1 });
    const id = crypto.randomUUID();
    await racy.create({
      id,
      userId: "u1",
      presetId: pid,
      harnessId: "claude-code",
      name: "Racy",
      workingDir: testDir,
      tmuxSocket: "subshell-race-test",
      alive: 0,
      backoffCount: 0,
      restartOnExit: 1,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });
    tmux.alive = false;
    manager = new SubshellManagerService({ subshells: racy, presets, tmux, tokens, audit: async () => {} });

    await manager.reconcileAll();
    // The spawn happened (the race beat the pre-spawn check) but the row was
    // NOT resurrected: the guarded update saw status != running and no-op'd.
    const row = await subshells.findById(id);
    expect(tmux.newSubshellCmds.length).toBe(1);
    expect(row?.status).toBe("terminated");
    expect(row?.alive).toBe(0);
    expect(row?.backoffCount).toBe(0); // the conditional patch carried the increment
    // Orphan cleanup: the just-spawned pane was killed…
    expect(tmux.kills).toContain(id);
    // …and the token revoked twice (rotate-old + retire-the-just-issued).
    expect(tokens.revoked).toEqual([id, id]);
    await manager.deleteSubshell("u1", id);
  });
});

describe("log-pipe attach strictness (LaunchPlan.bestEffortLog)", () => {
  beforeEach(async () => {
    // Sweep-clean like the race suite: reconcileAll is server-wide.
    await db.deleteFrom("subshells").execute();
  });

  it("createSubshell stays strict: a pipe-pane failure aborts the spawn and rolls back", async () => {
    const pid = await seedPreset(presets, { name: `pipfail-${crypto.randomUUID().slice(0, 8)}` });
    tmux.failPipe = true;
    await expect(manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir })).rejects.toThrow(
      /pipe-pane/,
    );
    // The pane DID spawn (pipePane throws after newSubshell) — the rollback
    // must kill it, or a live harness orphans under a terminated row.
    const row = (await subshells.listByUser("u1")).find((r) => r.presetId === pid);
    if (!row) throw new Error("rolled-back row missing");
    expect(row.status).toBe("terminated");
    expect(tmux.kills).toContain(row.id);
    // Rollback like any other spawn failure: the token minted pre-spawn is retired.
    expect(tokens.revoked.length).toBe(1);
  });

  it("revive survives a lost log pipe: the pane respawns and the row revives", async () => {
    // Pre-seam semantics restored: the original revive swallowed pipe-pane
    // failures — a live pane must not die over a replay log that will not
    // attach (the row just lost its pane to a crash; the pipe is re-attached
    // best-effort).
    const pid = await seedPreset(presets, { name: `pipeok-${crypto.randomUUID().slice(0, 8)}` });
    await presets.update(pid, { restartOnExit: 1 });
    const created = await manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir });
    tmux.alive = false; // crash
    tmux.failPipe = true; // and the log re-attach now fails
    await subshells.update(created.id, {
      alive: 0,
      exitCode: 1,
      backoffCount: 0,
      endedAt: new Date(Date.now() - 2_000).toISOString(),
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await manager.reconcileAll();
    expect(tmux.newSubshellCmds.length).toBe(2); // the respawn DID happen…
    const row = await subshells.findById(created.id);
    expect(row?.alive).toBe(1); // …and the swallowed pipe failure kept it revived
    expect(row?.status).toBe("running");
    await manager.deleteSubshell("u1", created.id);
  });
});

describe("revoke-failure cleanup (unlink fallback)", () => {
  it("a failed revoke on the create-failure path clears the row's apiKeyId link", async () => {
    // The guard accepts a subshell key only while row.apiKeyId matches it, so
    // a revoke that cannot reach the key store must still sever the link —
    // otherwise a live token stays bound to a terminated row, silently.
    const pid = await seedPreset(presets, {
      name: `badenv-${crypto.randomUUID().slice(0, 8)}`,
      envJson: '{"1BAD":"x"}', // rejected by buildHarnessCommand, after the issue
    });
    const failingTokens: SubshellTokenProvider = {
      // Mirrors the real issueSubshellToken: it writes the key id onto the row.
      issue: async (subshellId) => {
        await subshells.update(subshellId, { apiKeyId: `key_${subshellId}` });
        return "subshell_x";
      },
      revoke: async () => {
        throw new Error("key store down");
      },
    };
    manager = new SubshellManagerService({ subshells, presets, tmux, tokens: failingTokens, audit: async () => {} });

    await expect(manager.createSubshell({ userId: "u1", presetId: pid, workingDir: testDir })).rejects.toThrow(
      /env var name/,
    );
    const row = (await subshells.listByUser("u1")).find((r) => r.presetId === pid);
    expect(row?.status).toBe("terminated"); // cleanup still ran…
    expect(row?.apiKeyId).toBeNull(); // …and the unlink fallback severed the link
    // The guard's first read still resolves nothing usable: a mismatched/absent
    // link is exactly the documented second layer (auth-guard.ts).
    if (row) await manager.deleteSubshell("u1", row.id);
  });

  /**
   * Provider whose revoke always throws (key store down); `issue` mirrors the
   * real `issueSubshellToken` row write so the unlink has something to clear.
   */
  function throwingRevokeTokens(): SubshellTokenProvider {
    return {
      issue: async (subshellId) => {
        await subshells.update(subshellId, { apiKeyId: `key_${subshellId}` });
        return "subshell_x";
      },
      revoke: async () => {
        throw new Error("key store down");
      },
    };
  }

  it("terminateSubshell tolerates a throwing revoke: row terminated AND apiKeyId cleared", async () => {
    // Same fallback as the create path, wired at terminateSubshell's teardown
    // site — a "simplification" back to a bare revoke would hang here.
    const broken = new SubshellManagerService({
      subshells,
      presets,
      tmux,
      tokens: throwingRevokeTokens(),
      audit: async () => {},
    });
    const created = await broken.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    expect((await subshells.findById(created.id))?.apiKeyId).toBe(`key_${created.id}`);
    await broken.terminateSubshell("u1", created.id); // must not throw
    const row = await subshells.findById(created.id);
    expect(row?.status).toBe("terminated");
    expect(row?.apiKeyId).toBeNull(); // the guard's link check now rejects the key
    await broken.deleteSubshell("u1", created.id);
  });

  it("deleteSubshell tolerates a throwing revoke: unlink lands before the row goes", async () => {
    // The row disappears with the unlink effect, so capture the column AT the
    // delete call — this proves both teardown steps survived the broken store
    // and the unlink strictly precedes the delete.
    class CapturingSubshells extends SubshellsRepository {
      apiKeyIdAtDelete: string | null | "never-called" = "never-called";
      override async delete(id: string): Promise<void> {
        this.apiKeyIdAtDelete = (await this.findById(id))?.apiKeyId ?? null;
        await super.delete(id);
      }
    }
    const capturing = new CapturingSubshells(db);
    const broken = new SubshellManagerService({
      subshells: capturing,
      presets,
      tmux,
      tokens: throwingRevokeTokens(),
      audit: async () => {},
    });
    const created = await broken.createSubshell({ userId: "u1", presetId, workingDir: testDir });
    await broken.deleteSubshell("u1", created.id); // must not throw
    expect(await subshells.findById(created.id)).toBeUndefined(); // deleted despite the broken revoke
    expect(capturing.apiKeyIdAtDelete).toBeNull(); // unlink ran BEFORE the delete
  });
});
