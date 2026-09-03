import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessCommand, ClaudeCodePlugin, TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
import type { NodeCommandBody, NodeProbeEntry } from "@internal/subshell-protocol";
import { spawnSync } from "bun";
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
import { openSqliteDatabase } from "@/db/open-database.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { FakeNodeLauncher, nodeOnline } from "@/services/__tests__/helpers/node-fakes.js";
import { seedProfile } from "@/services/__tests__/helpers/seed-profile.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { previewCacheDrop, previewCacheGet, previewCachePut } from "@/services/nodes/preview-cache.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { defaultSubshellName, parseProfile, SubshellManagerService } from "@/services/subshell-manager.service.js";

let dbCleanup: (() => void) | undefined;
let subshellManager: SubshellManagerService;
let profilesRepo: ProfilesRepository;
let subshellsRepo: SubshellsRepository;
const testDir = mkdtempSync(join(tmpdir(), "subshell-test-"));

/**
 * `/tmp` as the service reports it back.
 *
 * `validateWorkingDir` resolves symlinks with `realpathSync`, and on macOS
 * `/tmp` is a symlink to `/private/tmp` — so a stored workingDir never
 * equals the literal string that was passed in. Resolving here keeps the
 * assertion true on both macOS and Linux.
 */
const TMP_RESOLVED = realpathSync("/tmp");

/** Saved so the CLAUDE_PATH override never leaks into another test file. */
let previousClaudePath: string | undefined;

/**
 * tmux sockets from servers this file may have spawned. Every test that starts
 * a real tmux subshell registers its socket here, and `afterAll` runs
 * `kill-server` on each — tmux does not reliably exit a server once its last
 * subshell dies, and a surviving stub pane (`sleep 300`) keeps the server alive
 * (regression: leaked servers outlived the whole suite). Tests still end their
 * own subshells and assert it; this net catches any future test that forgets.
 * The set is built only from sockets returned by our own spawns, so a real
 * user's subshell (a different id, a different socket) can never be reaped here.
 */
const spawnedSockets = new Set<string>();

/** Registers a spawned subshell's socket so `afterAll` can reap its server. */
function trackTmuxSocket(socket: string): void {
  spawnedSockets.add(socket);
}

beforeAll(async () => {
  // Hermetic harness. These tests used to resolve the real `claude` binary off
  // the host, so they passed on a developer machine and failed anywhere without
  // it (CI had no harness installed). CLAUDE_PATH is the first thing
  // findBinary() consults, so point it at a stub that merely stays alive long
  // enough for the tmux liveness assertions. This also stops the suite from
  // spawning the operator's actual agent.
  const harnessStub = join(testDir, "claude-stub");
  writeFileSync(harnessStub, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
  previousClaudePath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = harnessStub;

  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await profileDefaultFlagMigration.up(db); // ProfilesRepository.create writes is_default
  await sessionNameLockedMigration.up(db); // SubshellsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // subshells.harness_session_id
  await sessionNotificationsMigration.up(db); // subshells.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // subshells.node_id (SubshellsRepository.create writes it)
  await sharingMigration.up(db); // 0019 renames session_shares
  await subshellRenameMigration.up(db); // renamed schema the code sees
  profilesRepo = new ProfilesRepository(db);
  subshellsRepo = new SubshellsRepository(db);
  subshellManager = new SubshellManagerService({
    subshells: subshellsRepo,
    profiles: profilesRepo,
    tmux: new TmuxRunner(),
    // These tests exercise subshell/tmux mechanics against a hermetic DB that
    // better-auth knows nothing about; stub the token lifecycle (the real one
    // is covered by subshell-tokens.test.ts and subshell-manager-mcp.test.ts).
    tokens: { issue: async () => "subshell_stub", revoke: async () => {} },
    // Unit isolation: the default audit sink writes to the app's dev DB
    // singleton; these tests exercise subshell mechanics, not the audit trail.
    audit: async () => {},
  });
  dbCleanup = () => {
    db.destroy().catch(() => {});
  };
});

afterAll(() => {
  // Reap every tmux server this file may have left standing (see
  // spawnedSockets). kill-server tears down the whole daemon, so even a test
  // that exits before terminating its subshell cannot leak a stub pane into the
  // host. Errors (already-dead socket) are intentionally swallowed.
  for (const socket of spawnedSockets) {
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  }
  spawnedSockets.clear();
  if (previousClaudePath === undefined) {
    delete process.env.CLAUDE_PATH;
  } else {
    process.env.CLAUDE_PATH = previousClaudePath;
  }
  dbCleanup?.();
  rmSync(testDir, { recursive: true, force: true });
});

describe("SubshellManagerService", () => {
  it("creates a subshell with a default name and tmux socket", async () => {
    const workDir = mkdtempSync(join(testDir, "ws-"));
    writeFileSync(join(workDir, "file.txt"), "x");

    const profileId = await seedProfile(profilesRepo, { name: "Default" });

    const created = await subshellManager.createSubshell({
      userId: "u1",
      profileId,
      workingDir: workDir,
    });
    trackTmuxSocket(created.tmuxSocket);

    expect(created.id).toBeTruthy();
    expect(created.tmuxSocket).toMatch(/^subshell-/);
    expect(tmuxSocketFor(created.id)).toBe(created.tmuxSocket);

    // The tmux subshell should actually be alive (real tmux on this host).
    const row = await subshellsRepo.findById(created.id);
    expect(row).toBeTruthy();
    expect(subshellManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    // A fresh subshell is stamped as just-started output (shows active).
    expect(row?.lastOutputAt).toBeTruthy();

    await subshellManager.terminateSubshell("u1", created.id);
    const after = await subshellsRepo.findById(created.id);
    expect(after?.status).toBe("terminated");
    expect(after?.alive).toBe(0);
    expect(subshellManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(false);
  });

  it("rejects subshells for a nonexistent profile", async () => {
    await expect(
      subshellManager.createSubshell({ userId: "u1", profileId: "missing", workingDir: "/tmp" }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a missing working directory", async () => {
    const profileId = await seedProfile(profilesRepo);
    await expect(
      subshellManager.createSubshell({ userId: "u1", profileId, workingDir: "/definitely/not/here" }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("SubshellManagerService notes + restart", () => {
  /** Inserts a subshell row directly (no tmux involvement). */
  async function seedSubshell(userId: string, profileId: string): Promise<string> {
    const id = crypto.randomUUID();
    await subshellsRepo.create({
      id,
      userId,
      profileId,
      harnessId: "claude-code",
      name: "Original",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    return id;
  }

  /** Real profile row (restartSubshell re-validates + spawns tmux). */
  const seedProfileFor = (userId: string) => seedProfile(profilesRepo, { userId });

  it("updateNotes sets a note for the owner", async () => {
    const id = await seedSubshell("u1", "p");
    expect(await subshellManager.updateNotes("u1", id, "working on X")).toBe(true);
    const row = await subshellsRepo.findById(id);
    expect(row?.notes).toBe("working on X");
    // Clearing sets null.
    expect(await subshellManager.updateNotes("u1", id, null)).toBe(true);
    expect((await subshellsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes trims and normalizes empty notes to null", async () => {
    const id = await seedSubshell("u1", "p");
    expect(await subshellManager.updateNotes("u1", id, "  spaced  ")).toBe(true);
    expect((await subshellsRepo.findById(id))?.notes).toBe("spaced");
    expect(await subshellManager.updateNotes("u1", id, "   ")).toBe(true);
    expect((await subshellsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes rejects a foreign userId (404 path)", async () => {
    const id = await seedSubshell("u1", "p");
    expect(await subshellManager.updateNotes("u2", id, "nope")).toBe(false);
    expect((await subshellsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes returns false for a missing subshell", async () => {
    expect(await subshellManager.updateNotes("u1", "does-not-exist", "x")).toBe(false);
  });

  it("restartSubshell revives the SAME row (same id, name, profile; parked fields cleared)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSubshell("u1", profileId);
    await subshellsRepo.update(id, {
      status: "terminated",
      alive: 0,
      exitCode: 3,
      endedAt: new Date().toISOString(),
      backoffCount: 4,
      nextRestartAt: new Date().toISOString(),
    });
    const restarted = await subshellManager.restartSubshell("u1", id);
    if (!restarted) throw new Error("expected a restarted subshell");
    trackTmuxSocket(restarted.tmuxSocket);
    expect(restarted.id).toBe(id); // NOT a new id — in-place revival
    const row = await subshellsRepo.findById(id);
    expect(row?.name).toBe("Original"); // no " (2)" suffix ever
    expect(row?.profileId).toBe(profileId);
    expect(row?.status).toBe("running");
    expect(row?.alive).toBe(1);
    expect(row?.exitCode).toBeNull();
    expect(row?.endedAt).toBeNull();
    expect(row?.backoffCount).toBe(0); // operator intent resets the ladder
    expect(row?.nextRestartAt).toBeNull();
    expect(row?.tmuxSocket).toBe(restarted.tmuxSocket);

    // A REAL tmux subshell was spawned — end it here or its server outlives
    // the suite with the stub pane still attached (regression guard: the old
    // clone test used to leak exactly that).
    await subshellManager.terminateSubshell("u1", id);
    expect(subshellManager.isAlive({ id, tmuxSocket: restarted.tmuxSocket })).toBe(false);
  });

  it("restartSubshell kills a live source before respawning it (same row, same socket)", async () => {
    const profileId = await seedProfileFor("u1");
    const created = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: "/tmp" });
    trackTmuxSocket(created.tmuxSocket);
    expect(subshellManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    const restarted = await subshellManager.restartSubshell("u1", created.id);
    if (!restarted) throw new Error("expected a restarted subshell");
    expect(restarted.id).toBe(created.id);
    expect(restarted.tmuxSocket).toBe(created.tmuxSocket);
    // A pane is running again under the SAME identity (the stub sleep re-spawned).
    expect(subshellManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    await subshellManager.terminateSubshell("u1", created.id);
  });

  it("restartSubshell keeps the bell on the row (operator monitoring survives a restart)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSubshell("u1", profileId);
    await subshellsRepo.update(id, { notify: 1 });
    const restarted = await subshellManager.restartSubshell("u1", id);
    if (!restarted) throw new Error("expected a restarted subshell");
    trackTmuxSocket(restarted.tmuxSocket);
    try {
      // Same row now — the bell needs no "inheritance", it must simply survive.
      expect((await subshellsRepo.findById(id))?.notify).toBe(1);
    } finally {
      await subshellManager.terminateSubshell("u1", id);
    }
  });

  // Regression (review #1/#5): the in-flight lease is MODULE-level, not
  // per-instance — the route, the sweep, and the MCP server each build their
  // own manager. A gated token.issue lets us observe manager A mid-restart and
  // assert a SECOND instance joins it (never spawns), and that a foreign
  // caller is rejected on ownership BEFORE it can ride A's lease.
  it("concurrent restartSubshell across two manager instances joins one revival", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSubshell("u1", profileId);

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let aIssues = 0;
    let bIssues = 0;
    const mkManager = (tally: () => void, gateOnIssue = false) =>
      new SubshellManagerService({
        subshells: subshellsRepo,
        profiles: profilesRepo,
        tmux: new TmuxRunner(),
        tokens: {
          issue: async () => {
            tally();
            if (gateOnIssue) await gate; // hold A inside #reviveRow, post-park
            return "subshell_stub";
          },
          revoke: async () => {},
        },
        audit: async () => {},
      });
    const a = mkManager(() => aIssues++, true);
    const b = mkManager(() => bIssues++);

    const pA = a.restartSubshell("u1", id); // starts, parks, reaches issue, waits
    for (let i = 0; aIssues === 0 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
    expect(aIssues).toBe(1); // A is now parked + mid-revival

    // Same owner, DIFFERENT instance → must join A's lease (never spawn).
    const pB = b.restartSubshell("u1", id);
    // Foreign caller must be rejected on ownership, NOT handed A's result.
    expect(await b.restartSubshell("u2", id)).toBeNull();

    releaseGate();
    const [ra, rb] = await Promise.all([pA, pB]);
    try {
      expect(ra?.id).toBe(id);
      expect(rb?.id).toBe(id);
      expect(aIssues).toBe(1); // A did the one real revival…
      expect(bIssues).toBe(0); // …B rode A's lease and issued nothing of its own.
    } finally {
      // A real pane was spawned by the revival; reap it (and its server) even
      // if an assertion above throws, or it outlives the suite (sibling
      // tests' try/finally pattern).
      if (ra) trackTmuxSocket(ra.tmuxSocket);
      await a.terminateSubshell("u1", id);
    }
  });

  // Regression (review #4): a relaunch that can't be composed must roll the
  // parked `running` row back to `terminated`, so the sweep neither sees a
  // `running` zombie nor auto-revives it when the harness later reappears.
  it("restartSubshell rolls the row back to terminated when the relaunch throws", async () => {
    const id = await seedSubshell("u1", "no-such-profile"); // reviveRow throws: profile gone
    await subshellsRepo.update(id, { status: "terminated", alive: 0, exitCode: 1 });
    await expect(subshellManager.restartSubshell("u1", id)).rejects.toThrow(/profile/);
    const row = await subshellsRepo.findById(id);
    expect(row?.status).toBe("terminated"); // NOT left running
    expect(row?.alive).toBe(0);
  });

  it("restartSubshell rejects a foreign userId (404 path)", async () => {
    const id = await seedSubshell("u1", "p");
    expect(await subshellManager.restartSubshell("u2", id)).toBeNull();
  });

  it("restartSubshell returns null for a missing subshell", async () => {
    expect(await subshellManager.restartSubshell("u1", "does-not-exist")).toBeNull();
  });

  it("reconcile marks a dead tmux subshell as not-alive (crash)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSubshell("u1", profileId); // tmuxSocket null → not alive
    await subshellManager.reconcile("u1");
    const row = await subshellsRepo.findById(id);
    expect(row?.alive).toBe(0);
    // A crash is NOT a terminate: the row stays running so the UI can
    // distinguish exited from terminated (regression guard).
    expect(row?.status).toBe("running");
    // But it did end at this moment: ended_at is stamped so zombie rows
    // carry a truthful end time (a later auto-restart clears it again).
    expect(row?.endedAt).toBeTruthy();
  });

  it("auto-restarts a restart_on_exit subshell after backoff, same row", async () => {
    const profileId = await seedProfileFor("u1");
    await profilesRepo.update(profileId, { restartOnExit: 1 });
    const created = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: "/tmp" });
    trackTmuxSocket(created.tmuxSocket);
    const id = created.id;
    // The subshell inherits the profile's auto-restart policy at creation.
    expect((await subshellsRepo.findById(id))?.restartOnExit).toBe(1);

    // Real crash: kill the tmux tree, then stamp the row dead with a
    // past-due backoff so the next sweep is allowed to restart.
    new TmuxRunner().killSubshell(created.tmuxSocket, id);
    await subshellsRepo.update(id, {
      alive: 0,
      exitCode: 1,
      backoffCount: 0,
      endedAt: new Date(Date.now() - 2_000).toISOString(), // crash-stamped
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await subshellManager.reconcileAll();
    const after = await subshellsRepo.findById(id);
    expect(after?.alive).toBe(1); // restarted (same row)
    expect(after?.backoffCount).toBe(1); // backoff incremented
    expect(after?.nextRestartAt).toBeNull(); // no pending backoff
    expect(after?.endedAt).toBeNull(); // a running process has not ended

    // A healthy sweep (alive at sweep) resets the backoff counter.
    await subshellManager.reconcileAll();
    expect((await subshellsRepo.findById(id))?.backoffCount).toBe(0);

    // No restart while the backoff is still pending.
    new TmuxRunner().killSubshell(created.tmuxSocket, id);
    await subshellsRepo.update(id, {
      alive: 0,
      nextRestartAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await subshellManager.reconcileAll();
    expect((await subshellsRepo.findById(id))?.alive).toBe(0);

    await subshellManager.terminateSubshell("u1", id);
  });

  it("deleteSubshell removes the row and its log file", async () => {
    const id = await seedSubshell("u1", "p");
    const logFile = subshellLogPath(id);
    writeFileSync(logFile, "output");
    expect(await subshellManager.deleteSubshell("u1", id)).toBe(true);
    expect(await subshellsRepo.findById(id)).toBeUndefined();
    expect(existsSync(logFile)).toBe(false);
  });

  it("deleteSubshell rejects a foreign userId (404 path)", async () => {
    const id = await seedSubshell("u1", "p");
    expect(await subshellManager.deleteSubshell("u2", id)).toBe(false);
    expect(await subshellsRepo.findById(id)).toBeTruthy();
  });

  it("deleteSubshell returns false for a missing subshell", async () => {
    expect(await subshellManager.deleteSubshell("u1", "does-not-exist")).toBe(false);
  });
});

describe("reconcile notifications", () => {
  /**
   * A manager wired to a recording notify sink. Only this instance sees the
   * calls, and no socket is ever spawned here — sweeps run against dead
   * (never-existing) tmux targets, so no `trackTmuxSocket` registration.
   */
  function notifySpyManager(): { manager: SubshellManagerService; calls: Array<[string, string]> } {
    const calls: Array<[string, string]> = [];
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      tmux: new TmuxRunner(),
      tokens: { issue: async () => "subshell_stub", revoke: async () => {} },
      audit: async () => {},
      notify: async (id, kind) => {
        calls.push([id, kind]);
      },
    });
    return { manager, calls };
  }

  /** Inserts a running row directly; `over` steers the death-branch inputs. */
  async function seedRunning(id: string, over: Partial<Parameters<typeof subshellsRepo.create>[0]> = {}) {
    await subshellsRepo.create({
      id,
      userId: "u-notify",
      profileId: "p",
      harnessId: "claude-code",
      name: "Notify me",
      workingDir: "/tmp",
      tmuxSocket: null,
      ...over,
    });
  }

  const callsFor = (calls: Array<[string, string]>, id: string) => calls.filter((c) => c[0] === id);

  it("alive→dead sweep clears waitingSince and notifies 'exited'", async () => {
    const id = crypto.randomUUID();
    await seedRunning(id, { alive: 1, waitingSince: new Date().toISOString() });
    const { manager, calls } = notifySpyManager();
    await manager.reconcileAll();
    const row = await subshellsRepo.findById(id);
    expect(row?.alive).toBe(0);
    // Death ends the "waiting for you" state — no stale stamp left behind.
    expect(row?.waitingSince).toBeNull();
    expect(callsFor(calls, id)).toEqual([[id, "exited"]]);
  });

  it("notifies 'crashed' when the dead subshell opted into auto-restart", async () => {
    const id = crypto.randomUUID();
    // Nonexistent socket → the hasSubshell===false death branch. The future
    // nextRestartAt parks maybeAutoRestart so the test spawns no tmux.
    await seedRunning(id, {
      alive: 1,
      waitingSince: new Date().toISOString(),
      tmuxSocket: tmuxSocketFor(id),
      restartOnExit: 1,
      nextRestartAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const { manager, calls } = notifySpyManager();
    await manager.reconcileAll();
    const row = await subshellsRepo.findById(id);
    expect(row?.alive).toBe(0);
    expect(row?.waitingSince).toBeNull();
    expect(callsFor(calls, id)).toEqual([[id, "crashed"]]);
  });

  it("notifies 'crashed_final' when the auto-restart backoff is already exhausted", async () => {
    const id = crypto.randomUUID();
    // backoffCount at the give-up limit: `maybeAutoRestart` will refuse
    // permanently, so the death push must NOT promise a restart.
    await seedRunning(id, {
      alive: 1,
      waitingSince: new Date().toISOString(),
      tmuxSocket: tmuxSocketFor(id),
      restartOnExit: 1,
      backoffCount: 5,
    });
    const { manager, calls } = notifySpyManager();
    await manager.reconcileAll();
    const row = await subshellsRepo.findById(id);
    expect(row?.alive).toBe(0);
    expect(row?.waitingSince).toBeNull();
    expect(callsFor(calls, id)).toEqual([[id, "crashed_final"]]);
  });

  it("does not re-notify an already-dead row on a later sweep", async () => {
    const id = crypto.randomUUID();
    await seedRunning(id, { alive: 1 });
    const { manager, calls } = notifySpyManager();
    await manager.reconcileAll();
    expect(callsFor(calls, id)).toHaveLength(1);
    // The transition gate must hold: second sweep, same dead row → no new call.
    await manager.reconcileAll();
    expect(callsFor(calls, id)).toHaveLength(1);
  });
});

describe("buildHarnessCommand", () => {
  /** Builds a claude command with the given profile env (injection tests). */
  const cmdWithEnv = (env: Record<string, string>) =>
    buildHarnessCommand(
      new ClaudeCodePlugin(),
      "/usr/bin/claude",
      "/tmp/ws",
      { name: "p", env, flags: [], settings: null, configIsolation: false },
      "s",
    );

  it("curates env and quotes argv pieces", () => {
    const plugin = new ClaudeCodePlugin();
    const cmd = buildHarnessCommand(
      plugin,
      "/usr/bin/claude",
      "/tmp/ws",
      {
        name: "p",
        env: { ANTHROPIC_API_KEY: "abc'def" },
        flags: ["--permission-mode", "plan"],
        settings: { permissionMode: "plan" },
        configIsolation: false,
      },
      "My Subshell",
    );
    expect(cmd).toContain("env -i");
    expect(cmd).toContain("PATH=");
    expect(cmd).toContain("ANTHROPIC_API_KEY=");
    expect(cmd).toContain("'abc'\\''def'");
    expect(cmd).toContain("/usr/bin/claude");
    expect(cmd).toContain("--permission-mode");
  });

  // Pane programs decide color support from TERM; a backend started by
  // systemd/docker has none (and its own terminal type would describe the
  // wrong terminal anyway), so TERM must come from the PANE at launch time.
  // The assembled string runs under `sh -c` inside the pane — a literal
  // "$TERM" resolves to tmux's pane value (tmux-256color) there.
  it("always gives the harness a TERM, resolved from the pane at runtime", () => {
    const cmd = cmdWithEnv({ FOO: "bar" });
    expect(cmd).toContain('TERM="$TERM"');
  });

  it("honors a profile-set TERM instead of the pane default", () => {
    const cmd = cmdWithEnv({ TERM: "xterm-256color" });
    expect(cmd).toContain("TERM='xterm-256color'");
    expect(cmd).not.toContain('TERM="$TERM"');
  });

  // tmux runs the assembled string via `sh -c`, so an env KEY with shell
  // metacharacters executes BEFORE `env -i` scrubs anything (and inherits the
  // tmux server env). Values are single-quoted; keys have no safe quoting,
  // so they are rejected outright.
  it("rejects env keys that would splice shell into the pane command", () => {
    // The key itself names the payload; the message must carry it verbatim.
    expect(() => cmdWithEnv({ "A; touch /tmp/pwned #": "x" })).toThrow("A; touch /tmp/pwned #");
    // A newline ends the assignment and starts a second shell command.
    expect(() => cmdWithEnv({ "A\nB": "x" })).toThrow(/must match/);
    // Not-starting-with-letter/underscore and embedded spaces are also out.
    expect(() => cmdWithEnv({ "1BAD": "x" })).toThrow(/must match/);
    expect(() => cmdWithEnv({ "A B": "x" })).toThrow(/must match/);
    expect(() => cmdWithEnv({ "-x": "x" })).toThrow(/must match/);
  });

  it("accepts every valid POSIX env var name", () => {
    expect(() => cmdWithEnv({ GOOD: "1", _UNDER: "2", A9_z: "3" })).not.toThrow();
  });

  it("keeps shell-hostile values quoted rather than rewriting them", () => {
    // Regression pin: values pass through shellQuote unchanged-in-meaning —
    // command substitutions survive INSIDE the single quotes (inert), and an
    // embedded single quote uses the '\'' idiom (not a backslash escape).
    const cmd = cmdWithEnv({ EVIL: "$(touch /tmp/pwned)`id`", QT: "abc'def" });
    expect(cmd).toContain("EVIL='$(touch /tmp/pwned)`id`'");
    expect(cmd).toContain("QT='abc'\\''def'");
  });

  it("defaults subshell name to current datetime", () => {
    const name = defaultSubshellName();
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("parses profile JSON blobs", () => {
    const p = parseProfile({
      name: "n",
      envJson: '{"A":"1"}',
      flagsJson: '["--flag"]',
      settingsJson: '{"perm":"plan"}',
      configIsolation: 1,
    });
    expect(p.env).toEqual({ A: "1" });
    expect(p.flags).toEqual(["--flag"]);
    expect(p.settings).toEqual({ perm: "plan" });
    expect(p.configIsolation).toBe(true);
  });
});

describe("pane-title auto-naming (reconcile sweep)", () => {
  /** Sets a pane's title exactly like an inner program's OSC 2 would. */
  function setPaneTitle(socket: string, subshellName: string, title: string): void {
    const r = spawnSync(["tmux", "-L", socket, "select-pane", "-t", subshellName, "-T", title]);
    expect(r.exitCode).toBe(0);
  }

  async function liveSubshell(): Promise<{ id: string; socket: string; defaultName: string }> {
    const profileId = await seedProfile(profilesRepo);
    const created = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: TMP_RESOLVED });
    trackTmuxSocket(created.tmuxSocket);
    const row = await subshellsRepo.findById(created.id);
    return { id: created.id, socket: created.tmuxSocket, defaultName: row?.name ?? "" };
  }

  it("adopts a published title into the name of an unlocked subshell", async () => {
    const s = await liveSubshell();
    try {
      setPaneTitle(s.socket, s.id, "Adopt monorepo structure patterns");
      await subshellManager.reconcile("u1");
      expect((await subshellsRepo.findById(s.id))?.name).toBe("Adopt monorepo structure patterns");
    } finally {
      await subshellManager.terminateSubshell("u1", s.id);
    }
  });

  it("strips Claude Code's leading status glyph so the name does not churn", async () => {
    const s = await liveSubshell();
    try {
      // The spinner char cycles (✳/✻/·…) between sweeps; only the task text
      // may survive into the name.
      setPaneTitle(s.socket, s.id, "✳ Ship the rename feature");
      await subshellManager.reconcile("u1");
      expect((await subshellsRepo.findById(s.id))?.name).toBe("Ship the rename feature");
      setPaneTitle(s.socket, s.id, "✻ Ship the rename feature");
      await subshellManager.reconcile("u1");
      expect((await subshellsRepo.findById(s.id))?.name).toBe("Ship the rename feature");
    } finally {
      await subshellManager.terminateSubshell("u1", s.id);
    }
  });

  it("never overwrites a locked (renamed) name", async () => {
    const s = await liveSubshell();
    try {
      expect(await subshellManager.updateName("u1", s.id, "Keep me")).toBe(true);
      setPaneTitle(s.socket, s.id, "Some other task");
      await subshellManager.reconcile("u1");
      const row = await subshellsRepo.findById(s.id);
      expect(row?.name).toBe("Keep me");
      expect(row?.nameLocked).toBe(1);
    } finally {
      await subshellManager.terminateSubshell("u1", s.id);
    }
  });

  it("leaves an untouched pane (title = host default) at its created name", async () => {
    const s = await liveSubshell();
    try {
      await subshellManager.reconcile("u1");
      expect((await subshellsRepo.findById(s.id))?.name).toBe(s.defaultName);
    } finally {
      await subshellManager.terminateSubshell("u1", s.id);
    }
  });

  it("resumes adopting after the lock is released", async () => {
    const s = await liveSubshell();
    try {
      await subshellManager.updateName("u1", s.id, "Pinned");
      await subshellManager.setNameLocked("u1", s.id, false);
      setPaneTitle(s.socket, s.id, "Back on auto");
      await subshellManager.reconcile("u1");
      expect((await subshellsRepo.findById(s.id))?.name).toBe("Back on auto");
    } finally {
      await subshellManager.terminateSubshell("u1", s.id);
    }
  });
});

describe("SubshellManagerService restart-resume", () => {
  /**
   * Swaps in a stub harness that records its argv, plus a sandboxed
   * CLAUDE_CONFIG_DIR so `canResume` probes a temp transcript tree instead of
   * the operator's ~/.claude. Returns the argv file lines for later asserts.
   */
  async function resumeSandbox(name: string): Promise<{
    argv: () => Promise<string[]>;
    clear: () => void;
    restore: () => void;
    configDir: string;
  }> {
    const argFile = join(testDir, `${name}-argv.txt`);
    const stub = join(testDir, `${name}-stub`);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argFile}'\nexec sleep 300\n`, { mode: 0o755 });
    const savedClaudePath = process.env.CLAUDE_PATH;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = mkdtempSync(join(testDir, `${name}-claudecfg-`));
    process.env.CLAUDE_PATH = stub;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    return {
      configDir,
      // Drop the recorded argv so the next `argv()` can only resolve to bytes
      // written by the NEXT launch — otherwise a restart test could read the
      // first launch's stale command line and call it the restart's.
      clear: () => rmSync(argFile, { force: true }),
      // tmux spawns the pane asynchronously: newSubshell returning only means
      // the server accepted it, so a test may read the argv file before the
      // stub ever wrote it. Poll for the bytes instead of sleeping on hope.
      argv: async () => {
        for (let deadline = Date.now() + 5000; ; ) {
          if (existsSync(argFile)) {
            const text = readFileSync(argFile, "utf8").trim();
            if (text) return text.split("\n");
          }
          if (Date.now() > deadline) throw new Error(`stub harness argv never landed at ${argFile}`);
          await Bun.sleep(25);
        }
      },
      restore: () => {
        if (savedClaudePath === undefined) delete process.env.CLAUDE_PATH;
        else process.env.CLAUDE_PATH = savedClaudePath;
        if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
      },
    };
  }

  /** Transcript path Claude (and the plugin's canResume) uses for cwd+id. */
  function transcriptPath(configDir: string, cwd: string, id: string): string {
    return join(configDir, "projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  }

  it("pins a fresh conversation id on the row and launches with --session-id", async () => {
    const sb = await resumeSandbox("pin");
    try {
      const workDir = mkdtempSync(join(testDir, "ws-"));
      const profileId = await seedProfile(profilesRepo);
      const created = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(created.tmuxSocket);
      try {
        const row = await subshellsRepo.findById(created.id);
        expect(row?.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
        const argv = await sb.argv();
        expect(argv).toContain("--session-id");
        expect(argv[argv.indexOf("--session-id") + 1] ?? "").toBe(row?.harnessSessionId ?? "");
      } finally {
        await subshellManager.terminateSubshell("u1", created.id);
      }
    } finally {
      sb.restore();
    }
  });

  it("a terminated subshell's restart RESUMES its conversation", async () => {
    const sb = await resumeSandbox("resume");
    try {
      const workDir = mkdtempSync(join(testDir, "ws-"));
      const profileId = await seedProfile(profilesRepo);
      const first = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const row1 = await subshellsRepo.findById(first.id);
      const pinned = row1?.harnessSessionId ?? "";
      expect(pinned).toBeTruthy();
      // The stub harness never wrote a transcript; simulate the conversation
      // existing before the restart probes for it.
      const tPath = transcriptPath(sb.configDir, workDir, pinned);
      mkdirSync(tPath.slice(0, tPath.lastIndexOf("/")), { recursive: true });
      writeFileSync(tPath, "{}\n");
      await subshellManager.terminateSubshell("u1", first.id);
      sb.clear();
      const second = await subshellManager.restartSubshell("u1", first.id);
      if (!second) throw new Error("expected a restarted subshell");
      trackTmuxSocket(second.tmuxSocket);
      try {
        const row2 = await subshellsRepo.findById(second.id);
        // Same lineage id, and the launch continues it rather than pinning anew.
        expect(row2?.harnessSessionId).toBe(pinned);
        const argv = await sb.argv();
        expect(argv).toContain("--resume");
        expect(argv[argv.indexOf("--resume") + 1]).toBe(pinned);
        expect(argv).not.toContain("--session-id");
      } finally {
        await subshellManager.terminateSubshell("u1", second.id);
      }
    } finally {
      sb.restore();
    }
  });

  it("restart re-pins (never resumes) when the transcript is gone", async () => {
    const sb = await resumeSandbox("repin");
    try {
      const workDir = mkdtempSync(join(testDir, "ws-"));
      const profileId = await seedProfile(profilesRepo);
      const first = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const pinned = (await subshellsRepo.findById(first.id))?.harnessSessionId ?? "";
      await subshellManager.terminateSubshell("u1", first.id);
      sb.clear();
      // No transcript at all: `--resume <pinned>` would make claude print
      // "No conversation found" and exit — the restart must pin a NEW id.
      const second = await subshellManager.restartSubshell("u1", first.id);
      if (!second) throw new Error("expected a restarted subshell");
      trackTmuxSocket(second.tmuxSocket);
      try {
        const row2 = await subshellsRepo.findById(second.id);
        expect(row2?.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(row2?.harnessSessionId).not.toBe(pinned);
        const argv = await sb.argv();
        expect(argv[argv.indexOf("--session-id") + 1] ?? "").toBe(row2?.harnessSessionId ?? "");
      } finally {
        await subshellManager.terminateSubshell("u1", second.id);
      }
    } finally {
      sb.restore();
    }
  });

  it("a still-running source is not resumed against (its pane owns the id)", async () => {
    const sb = await resumeSandbox("live");
    try {
      const workDir = mkdtempSync(join(testDir, "ws-"));
      const profileId = await seedProfile(profilesRepo);
      const first = await subshellManager.createSubshell({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const pinned = (await subshellsRepo.findById(first.id))?.harnessSessionId ?? "";
      try {
        sb.clear();
        const second = await subshellManager.restartSubshell("u1", first.id);
        if (!second) throw new Error("expected a restarted subshell");
        trackTmuxSocket(second.tmuxSocket);
        const row2 = await subshellsRepo.findById(second.id);
        // Source pane is still appending to `pinned` — the clone gets its own.
        expect(row2?.harnessSessionId).not.toBe(pinned);
        const argv = await sb.argv();
        expect(argv).toContain("--session-id");
        await subshellManager.terminateSubshell("u1", second.id);
      } finally {
        await subshellManager.terminateSubshell("u1", first.id);
      }
    } finally {
      sb.restore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Task 10 — reconciler batching, preview cache, exit/report apply,    */
/* best-effort offline stop, and the agent meta artifact (spec §6.3).  */
/* These describes build their OWN managers (injected launcher +       */
/* scripted node wire); the file's real-tmux `subshellManager` is not   */
/* involved. The full-suite gate rule applies to every file here.      */
/* ------------------------------------------------------------------ */

/** One recorded sweep-probe call. */
interface ProbeCall {
  nodeId: string;
  subshellIds: string[];
  timeoutMs: number;
}

/**
 * A manager wired to a recording node wire + loud fakes: `probes` shows every
 * batched `probe` the reconciler sent (node, ids, deadline), `pushes` every
 * death notification, `audits` each audit's parsed metadata, and the shared
 * {@link FakeNodeLauncher} records every launcher call the partition must NOT
 * make for agent rows (`hasSubshellCalls`, `captureCalls`, `plans`, `kills`).
 * @param probe - scripted answer for the nth probe call (1-based); may return
 *   a promise to hold the sweep mid-round-trip (the race tests gate on it)
 */
function remoteFixture(
  probe?: (call: number, subshellIds: string[]) => NodeProbeEntry[] | undefined | Promise<NodeProbeEntry[] | undefined>,
): {
  manager: SubshellManagerService;
  probes: ProbeCall[];
  pushes: Array<[string, string]>;
  audits: Array<Record<string, unknown>>;
  revoked: string[];
  launcher: FakeNodeLauncher;
  issues: () => number;
  sendNode: (nodeId: string, cmd: NodeCommandBody, timeoutMs?: number) => Promise<unknown>;
} {
  const probes: ProbeCall[] = [];
  const pushes: Array<[string, string]> = [];
  const audits: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  let issued = 0;
  const launcher = new FakeNodeLauncher(testDir);
  const sendNode = async (nodeId: string, cmd: NodeCommandBody, timeoutMs = 30_000): Promise<unknown> => {
    if (cmd.type !== "probe") throw new Error(`unexpected node command: ${cmd.type}`);
    probes.push({ nodeId, subshellIds: [...cmd.subshellIds], timeoutMs });
    return probe?.(probes.length, cmd.subshellIds);
  };
  const manager = new SubshellManagerService({
    subshells: subshellsRepo,
    profiles: profilesRepo,
    launcher,
    tokens: {
      issue: async () => {
        issued++;
        return "subshell_stub";
      },
      revoke: async (id: string) => {
        revoked.push(id);
      },
    },
    audit: async (event) => {
      audits.push(JSON.parse(event.metadataJson ?? "{}") as Record<string, unknown>);
    },
    notify: async (id: string, kind: string) => {
      pushes.push([id, kind]);
    },
    sendNode,
  });
  return { manager, probes, pushes, audits, revoked, launcher, issues: () => issued, sendNode };
}

/** Seed a running agent row directly (the fake "pane" lives only on the node). */
async function seedAgentRow(
  nodeId: string,
  over: Partial<Parameters<typeof subshellsRepo.create>[0]> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await subshellsRepo.create({
    id,
    userId: "u-recon",
    profileId: "p",
    harnessId: "claude-code",
    name: "Agent row",
    workingDir: "/tmp",
    tmuxSocket: tmuxSocketFor(id),
    nodeId,
    ...over,
  });
  return id;
}

const probeAlive = (subshellId: string, extra: Partial<NodeProbeEntry> = {}): NodeProbeEntry => ({
  subshellId,
  alive: true,
  exitCode: null,
  ...extra,
});
const probeDead = (subshellId: string, exitCode: number | null): NodeProbeEntry => ({
  subshellId,
  alive: false,
  exitCode,
});

describe("reconcile partition — agent rows (spec §6.3)", () => {
  it("an online agent row with a LIVE pane sweeps clean: no death, no push, no revive, no local probe (O1)", async () => {
    const nodeId = "recon-node-o1";
    let entries: NodeProbeEntry[] = [];
    const f = remoteFixture(() => entries);
    const off = nodeOnline(nodeId, ["mcp"]);
    // The hazard shape: the injected launcher answers hasSubshell=false, so a
    // sweep that probed it for an agent row would FALSE-CRASH the row (death
    // push) and revive through `#launcherFor(nodeId)` onto the node itself.
    f.launcher.alive = false;
    const id = await seedAgentRow(nodeId, { name: "Before", backoffCount: 0 });
    try {
      entries = [probeAlive(id, { title: "Remote task", command: "claude", capture: "screen line 1\nscreen line 2" })];
      await f.manager.reconcileAll();
      const row = await subshellsRepo.findById(id);
      expect(row?.status).toBe("running");
      expect(row?.alive).toBe(1); // alive entry patches only
      expect(row?.endedAt).toBeNull();
      expect(row?.name).toBe("Remote task"); // title adopted through the same reject rules
      // NEVER the local probe path — even with the launcher wired to answer
      // "absent" (the false-crash hazard), the agent row reached it only via
      // the node `probe` (other LOCAL rows in the shared DB may use the fake).
      expect(f.launcher.probedIds).not.toContain(id);
      expect(f.launcher.plans).toHaveLength(0); // no revive attempt
      expect(f.launcher.kills).toEqual([]); // no rollback kill of the (locally invisible) pane
      expect(f.issues()).toBe(0); // …and no token churn
      expect(f.pushes).toHaveLength(0); // no death push
      expect(f.probes).toEqual([{ nodeId, subshellIds: [id], timeoutMs: 30_000 }]);
      expect(previewCacheGet(id)).toEqual(["screen line 1", "screen line 2"]); // capture → cache
    } finally {
      off();
      previewCacheDrop(id);
      await subshellsRepo.delete(id);
    }
  });

  it("an offline agent node ⇒ its rows are skipped entirely (no probe, row stays running; spec §5.6)", async () => {
    const nodeId = "recon-node-offline";
    const f = remoteFixture(() => []);
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      await f.manager.reconcileAll();
      expect(f.probes).toHaveLength(0); // never probed…
      const row = await subshellsRepo.findById(id);
      expect(row?.status).toBe("running");
      expect(row?.alive).toBe(1); // …and NOT false-crashed (absence of socket ≠ absence of process)
      expect(f.pushes).toHaveLength(0);
      expect(f.launcher.probedIds).not.toContain(id); // nor probed through the local launcher
    } finally {
      await subshellsRepo.delete(id);
    }
  });

  it("30 rows on one node ⇒ two chunked probes of ≤ 24 (PROBE_BATCH_MAX)", async () => {
    const nodeId = "recon-node-batch";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture(() => []);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await seedAgentRow(nodeId, { name: `b-${i}` }));
    try {
      await f.manager.reconcileAll();
      expect(f.probes.map((p) => p.subshellIds.length)).toEqual([24, 6]);
      expect(f.probes.every((p) => p.nodeId === nodeId)).toBe(true);
      const covered = [...f.probes[0].subshellIds, ...f.probes[1].subshellIds];
      expect([...covered].sort()).toEqual([...ids].sort());
      expect(f.pushes).toHaveLength(0);
    } finally {
      off();
      for (const id of ids) await subshellsRepo.delete(id);
    }
  });

  it("a probe error is warn-and-continue: the sweep survives, later chunks still apply", async () => {
    const nodeId = "recon-node-err";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture((call, subshellIds) => {
      if (call === 1) throw new NodeRpcError("timeout", `probe to node "${nodeId}" timed out`, nodeId);
      return subshellIds.map((id) => probeDead(id, 1));
    });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await seedAgentRow(nodeId, { name: `e-${i}` }));
    try {
      await f.manager.reconcileAll(); // must not reject
      expect(f.probes).toHaveLength(2);
      const chunk1 = new Set(f.probes[0].subshellIds);
      const chunk2 = new Set(f.probes[1].subshellIds);
      expect(chunk1.size).toBe(24);
      expect(chunk2.size).toBe(6);
      for (const id of chunk1) expect((await subshellsRepo.findById(id))?.alive).toBe(1); // errored chunk untouched
      for (const id of chunk2) {
        const row = await subshellsRepo.findById(id);
        expect(row?.alive).toBe(0); // dead entries of the healthy chunk applied
        expect(row?.exitCode).toBe(1);
      }
      expect(f.pushes).toHaveLength(6);
    } finally {
      off();
      for (const id of ids) await subshellsRepo.delete(id);
    }
  });

  it("dead entry (exit=3): alive:0 + exit + endedAt + waitingSince cleared, one push, auto-restart fired (scheduled, node-gated)", async () => {
    const nodeId = "recon-node-dead";
    const off = nodeOnline(nodeId, []);
    let entries: NodeProbeEntry[] = [];
    const f = remoteFixture(() => entries);
    const id = await seedAgentRow(nodeId, {
      alive: 1,
      restartOnExit: 1,
      backoffCount: 0,
      waitingSince: new Date().toISOString(),
    });
    try {
      entries = [probeDead(id, 3)];
      await f.manager.reconcileAll();
      const row = await subshellsRepo.findById(id);
      expect(row?.alive).toBe(0);
      expect(row?.exitCode).toBe(3);
      expect(row?.endedAt).toBeTruthy();
      expect(row?.waitingSince).toBeNull();
      expect(f.pushes).toEqual([[id, "crashed"]]); // opted-in row → crashed, exactly once
      // The agent branch runs the pre-existing crash-block semantics verbatim:
      // the sweep that STAMPS the death never starts the ladder (the row the
      // block hands `maybeAutoRestart` is still alive at read time — the same
      // guard the local path carries), so no schedule/backoff write lands here.
      expect(row?.nextRestartAt).toBeNull();
      expect(row?.backoffCount).toBe(0);
      // The NEXT sweep — snapshot alive:0, still dead per the node — is where
      // `maybeAutoRestart` actually fires. Its up-front `nextRestartAt` write
      // lands before the §6.2 per-node harness gate defers the spawn (no node
      // row/inventory in the control-plane DB for this fake), so the ladder
      // ticked WITHOUT a revive being attempted (no plans, no token churn).
      // One push still — the second sweep must not re-notify a dead row.
      await f.manager.reconcileAll();
      const row2 = await subshellsRepo.findById(id);
      expect(row2?.nextRestartAt ?? (row2?.backoffCount ?? 0) >= 1).toBeTruthy();
      expect(row2?.alive).toBe(0);
      expect(f.pushes).toHaveLength(1);
      expect(f.launcher.plans).toHaveLength(0);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("row raced to terminated mid-probe ⇒ no resurrection — the alive pane gets a best-effort kill (O2)", async () => {
    const nodeId = "recon-node-race";
    const off = nodeOnline(nodeId, []);
    let entries: NodeProbeEntry[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The probe round-trip is held open; the operator terminates the subshell
    // inside that window; the node then answers ALIVE (its kill never landed
    // — the same shape as the offline stop). The alive-apply must re-read,
    // find the row retired, and FINISH the operator's job instead of patching.
    const f = remoteFixture(() => gate.then(() => entries));
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      const sweepP = f.manager.reconcileAll();
      for (let i = 0; f.probes.length === 0 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
      expect(f.probes).toHaveLength(1);
      await subshellsRepo.markTerminated(id, new Date().toISOString());
      await subshellsRepo.update(id, { alive: 0 });
      entries = [probeAlive(id)];
      release();
      await sweepP;
      expect(f.launcher.kills).toEqual([id]); // killSubshell on the row's node (the fake stands in for all)
      const row = await subshellsRepo.findById(id);
      expect(row?.status).toBe("terminated"); // never resurrected
      expect(row?.alive).toBe(0);
      expect(f.pushes).toHaveLength(0); // an operator terminate does not notify
      expect(f.launcher.plans).toHaveLength(0);
    } finally {
      release();
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("alive-entry rules: title rejects command/host defaults, locked names untouched, backoff reset, capture optional", async () => {
    const nodeId = "recon-node-rules";
    const off = nodeOnline(nodeId, []);
    const adopt = await seedAgentRow(nodeId, { name: "Auto", backoffCount: 2 });
    const sameCmd = await seedAgentRow(nodeId, { name: "Run" });
    const locked = await seedAgentRow(nodeId, { name: "Pinned", nameLocked: 1 });
    const hostTitled = await seedAgentRow(nodeId, { name: "Hosty" });
    try {
      const entries = [
        probeAlive(adopt, { title: "✳ Ship the feature", command: "claude" }),
        probeAlive(sameCmd, { title: "sleep 300", command: "sleep 300" }),
        probeAlive(locked, { title: "Should not stick", command: "claude" }),
        probeAlive(hostTitled, { title: hostname(), command: "claude" }),
      ];
      const f = remoteFixture(() => entries);
      await f.manager.reconcileAll();
      const rAdopt = await subshellsRepo.findById(adopt);
      expect(rAdopt?.name).toBe("Ship the feature"); // status glyph stripped, adopted
      expect(rAdopt?.backoffCount).toBe(0); // healthy sweep resets the ladder
      expect((await subshellsRepo.findById(sameCmd))?.name).toBe("Run"); // title === command → rejected
      expect((await subshellsRepo.findById(locked))?.name).toBe("Pinned"); // locked names never touched
      expect((await subshellsRepo.findById(hostTitled))?.name).toBe("Hosty"); // host-name default rejected
      // No capture on any entry ⇒ nothing cached (a dropped capture = no fill).
      expect(previewCacheGet(adopt)).toBeUndefined();
    } finally {
      off();
      for (const id of [adopt, sameCmd, locked, hostTitled]) await subshellsRepo.delete(id);
    }
  });

  it("#preview for agent rows reads the cache ONLY — no launcher capture, no probe (list path)", async () => {
    const nodeId = "recon-node-view";
    const off = nodeOnline(nodeId, []);
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      previewCachePut(id, ["cached", "screen"]);
      const f = remoteFixture(() => []);
      const views = await f.manager.toViews(await subshellsRepo.listByUser("u-recon"));
      const view = views.find((v) => v.id === id);
      expect(view?.preview).toEqual(["cached", "screen"]);
      expect(f.launcher.captureCalls).toBe(0); // the list path never captures on a node…
      expect(f.probes).toHaveLength(0); // …and never probes either
    } finally {
      off();
      previewCacheDrop(id);
      await subshellsRepo.delete(id);
    }
  });
});

describe("applyRemoteExit — shared death transition (idempotent against sweep + report)", () => {
  it("two exit events ⇒ ONE death push; the row takes the agent-reported exit code and time", async () => {
    const nodeId = "exit-node-a";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      const at = new Date(Date.now() - 5_000).toISOString();
      await f.manager.applyRemoteExit(nodeId, id, 3, at);
      await f.manager.applyRemoteExit(nodeId, id, 3, at);
      expect(f.pushes).toEqual([[id, "exited"]]);
      const row = await subshellsRepo.findById(id);
      expect(row?.alive).toBe(0);
      expect(row?.exitCode).toBe(3);
      expect(row?.endedAt).toBe(at); // the agent's clock is the truthful end time
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("exit event then a sweep pass ⇒ still exactly ONE push", async () => {
    const nodeId = "exit-node-b";
    const off = nodeOnline(nodeId, []);
    const id = await seedAgentRow(nodeId, { alive: 1 });
    const f = remoteFixture(() => [probeDead(id, 3)]);
    try {
      await f.manager.applyRemoteExit(nodeId, id, 3, new Date().toISOString());
      await f.manager.reconcileAll();
      expect(f.pushes).toHaveLength(1);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("a sweep that stamped the death first swallows the LATE exit event (either order converges)", async () => {
    const nodeId = "exit-node-c";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture((_call, subshellIds) => subshellIds.map((sid) => probeDead(sid, 3)));
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      await f.manager.reconcileAll(); // sweep marks dead first — one push
      expect(f.pushes).toHaveLength(1);
      await f.manager.applyRemoteExit(nodeId, id, 3, new Date().toISOString()); // late event
      expect(f.pushes).toHaveLength(1); // …adds nothing: the transition already happened
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("the death transition drops the cached preview with the pane", async () => {
    const nodeId = "exit-node-cache";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      previewCachePut(id, ["last", "screen"]);
      await f.manager.applyRemoteExit(nodeId, id, 1, new Date().toISOString());
      expect(previewCacheGet(id)).toBeUndefined(); // a dead pane's screen never outlives its row
    } finally {
      off();
      previewCacheDrop(id);
      await subshellsRepo.delete(id);
    }
  });

  it("a foreign node cannot report a death it does not own", async () => {
    const nodeId = "exit-node-owner";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      await f.manager.applyRemoteExit("exit-node-imposter", id, 1, new Date().toISOString());
      expect(f.pushes).toHaveLength(0);
      expect((await subshellsRepo.findById(id))?.alive).toBe(1);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("a row mid-restart is off-limits: no push, no stamp (restartInFlight guard)", async () => {
    const nodeId = "exit-node-race";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let reachedIssue = false;
    // A gated token.issue holds this manager inside #reviveRow, mid-restart —
    // exactly the window the shared death helper must refuse to enter.
    const gated = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      launcher: f.launcher,
      tokens: {
        issue: async () => {
          reachedIssue = true;
          await gate;
          return "subshell_stub";
        },
        revoke: async () => {},
      },
      audit: async () => {},
      notify: async (id: string, kind: string) => {
        f.pushes.push([id, kind]);
      },
      sendNode: f.sendNode,
    });
    const liveProfile = await seedProfile(profilesRepo);
    const id = await seedAgentRow(nodeId, { alive: 0, profileId: liveProfile }); // parked row → restart revives it
    const restartP = gated.restartSubshell("u-recon", id);
    for (let i = 0; !reachedIssue && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
    expect(reachedIssue).toBe(true);
    try {
      await f.manager.applyRemoteExit(nodeId, id, 9, new Date().toISOString());
      expect(f.pushes).toHaveLength(0);
      const row = await subshellsRepo.findById(id);
      expect(row?.status).toBe("running");
      expect(row?.alive).toBe(0); // still parked — the restart owns the row
    } finally {
      releaseGate();
      await restartP; // revive completes through the fake launcher (node still online here)
      off();
      await subshellsRepo.delete(id);
    }
  });
});

describe("applySubshellsReport — reconnect census (O2 reconnect path)", () => {
  it("running + alive:0 reported ALIVE ⇒ revive patch (alive:1, endedAt cleared), no push", async () => {
    const nodeId = "report-node-revive";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 0 });
    await subshellsRepo.update(id, { endedAt: new Date().toISOString() }); // parked WITH a death stamp
    try {
      await f.manager.applySubshellsReport(nodeId, [{ subshellId: id, alive: true, exitCode: null }]);
      const row = await subshellsRepo.findById(id);
      expect(row?.alive).toBe(1);
      expect(row?.endedAt).toBeNull();
      expect(row?.status).toBe("running");
      expect(f.pushes).toHaveLength(0); // a revive never notifies
      expect(f.launcher.kills).toEqual([]);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("running + alive:1 reported DEAD ⇒ the shared death transition fires", async () => {
    const nodeId = "report-node-dead";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      await f.manager.applySubshellsReport(nodeId, [{ subshellId: id, alive: false, exitCode: 7 }]);
      const row = await subshellsRepo.findById(id);
      expect(row?.alive).toBe(0);
      expect(row?.exitCode).toBe(7);
      expect(row?.endedAt).toBeTruthy();
      expect(f.pushes).toEqual([[id, "exited"]]);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("a row NOT running (operator terminated it while the node was offline) reported ALIVE ⇒ best-effort kill, row untouched", async () => {
    const nodeId = "report-node-kill";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    await subshellsRepo.markTerminated(id, new Date().toISOString());
    await subshellsRepo.update(id, { alive: 0 });
    try {
      await f.manager.applySubshellsReport(nodeId, [{ subshellId: id, alive: true, exitCode: null }]);
      expect(f.launcher.kills).toEqual([id]); // the pane survived the offline window; the operator said stop
      const row = await subshellsRepo.findById(id);
      expect(row?.status).toBe("terminated"); // never resurrected
      expect(row?.alive).toBe(0);
      expect(f.pushes).toHaveLength(0);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("foreign-node reports and unknown ids are inert", async () => {
    const nodeId = "report-node-guard";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 1 });
    try {
      await f.manager.applySubshellsReport("report-node-imposter", [{ subshellId: id, alive: false, exitCode: 0 }]);
      await f.manager.applySubshellsReport(nodeId, [{ subshellId: crypto.randomUUID(), alive: true, exitCode: null }]);
      expect((await subshellsRepo.findById(id))?.alive).toBe(1);
      expect(f.pushes).toHaveLength(0);
      expect(f.launcher.kills).toEqual([]);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });
});

describe("terminateSubshell on an offline agent node — best-effort stop (O2 ruling)", () => {
  it("offline kill ⇒ swallowed: row retired, token revoked, audit flags killUnverified", async () => {
    // NO launcher injected: the REAL RemoteLauncher answers the kill offline
    // (NodeRpcError("offline") from sendCommand) — the stop must still finish.
    const revoked: string[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      tokens: {
        issue: async () => "subshell_stub",
        revoke: async (id: string) => {
          revoked.push(id);
        },
      },
      audit: async (event) => {
        audits.push(JSON.parse(event.metadataJson ?? "{}") as Record<string, unknown>);
      },
    });
    const id = await seedAgentRow("terminate-node-off", { alive: 1 });
    await manager.terminateSubshell("u-recon", id); // must NOT throw
    const row = await subshellsRepo.findById(id);
    expect(row?.status).toBe("terminated");
    expect(row?.alive).toBe(0);
    expect(revoked).toEqual([id]);
    expect(audits.at(-1)).toEqual({ name: "Agent row", killUnverified: true });
    await subshellsRepo.delete(id);
  });

  it("a successful kill keeps the audit metadata exactly as before (no killUnverified)", async () => {
    const f = remoteFixture();
    const id = await seedAgentRow("terminate-node-on", { alive: 1 });
    await f.manager.terminateSubshell("u-recon", id);
    expect(f.launcher.kills).toEqual([id]);
    expect(f.audits.at(-1)).toEqual({ name: "Agent row" });
    await subshellsRepo.delete(id);
  });

  it("a NON-offline kill failure still throws and leaves the row running (all other kills behave as today)", async () => {
    const f = remoteFixture();
    f.launcher.killError = new Error("tmux refused");
    const id = await seedAgentRow("terminate-node-boom", { alive: 1 });
    await expect(f.manager.terminateSubshell("u-recon", id)).rejects.toThrow("tmux refused");
    const row = await subshellsRepo.findById(id);
    expect(row?.status).toBe("running"); // the terminate aborted, as today
    await subshellsRepo.delete(id);
  });
});

describe("deleteSubshell cleans the agent meta artifact (O3)", () => {
  it("agent row: remove_paths carries log + mcp + meta", async () => {
    const nodeId = "delete-node-o3";
    const off = nodeOnline(nodeId, []);
    const f = remoteFixture();
    const id = await seedAgentRow(nodeId, { alive: 0, status: "terminated" });
    try {
      expect(await f.manager.deleteSubshell("u-recon", id)).toBe(true);
      expect(f.launcher.removedPaths.at(-1)).toEqual([
        join(testDir, `${id}.log`), // logPath (the fake composes it under the temp dir)
        `/node-data/mcp/${id}.json`, // MCP config (composed from live facts)
        `/node-data/subshells/${id}.meta.json`, // the agent's subshell-meta record (O3)
      ]);
    } finally {
      off();
      await subshellsRepo.delete(id);
    }
  });

  it("local row: byte-identical artifact list (no meta concept locally)", async () => {
    const f = remoteFixture();
    const id = await seedAgentRow(LOCAL_NODE_ID, { status: "terminated", userId: "u-recon-local" });
    expect(await f.manager.deleteSubshell("u-recon-local", id)).toBe(true);
    expect(f.launcher.removedPaths.at(-1)).toEqual([join(testDir, `${id}.log`)]);
    await subshellsRepo.delete(id);
  });
});
