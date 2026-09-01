import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessCommand, ClaudeCodePlugin, TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
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
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { Database } from "@/db/types/index.js";
import { seedProfile } from "@/services/__tests__/helpers/seed-profile.js";
import { sessionLogPath } from "@/services/nodes/session-paths.js";
import { defaultSessionName, parseProfile, SessionManagerService } from "@/services/session-manager.service.js";

let dbCleanup: (() => void) | undefined;
let sessionManager: SessionManagerService;
let profilesRepo: ProfilesRepository;
let sessionsRepo: SessionsRepository;
const testDir = mkdtempSync(join(tmpdir(), "mote-test-"));

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
 * a real tmux session registers its socket here, and `afterAll` runs
 * `kill-server` on each — tmux does not reliably exit a server once its last
 * session dies, and a surviving stub pane (`sleep 300`) keeps the server alive
 * (regression: leaked servers outlived the whole suite). Tests still end their
 * own sessions and assert it; this net catches any future test that forgets.
 * The set is built only from sockets returned by our own spawns, so a real
 * user's session (a different id, a different socket) can never be reaped here.
 */
const spawnedSockets = new Set<string>();

/** Registers a spawned session's socket so `afterAll` can reap its server. */
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
  await sessionNameLockedMigration.up(db); // SessionsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // sessions.harness_session_id
  await sessionNotificationsMigration.up(db); // sessions.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // sessions.node_id (SessionsRepository.create writes it)
  profilesRepo = new ProfilesRepository(db);
  sessionsRepo = new SessionsRepository(db);
  sessionManager = new SessionManagerService({
    sessions: sessionsRepo,
    profiles: profilesRepo,
    tmux: new TmuxRunner(),
    // These tests exercise session/tmux mechanics against a hermetic DB that
    // better-auth knows nothing about; stub the token lifecycle (the real one
    // is covered by session-tokens.test.ts and session-manager-mcp.test.ts).
    tokens: { issue: async () => "mote_stub", revoke: async () => {} },
    // Unit isolation: the default audit sink writes to the app's dev DB
    // singleton; these tests exercise session mechanics, not the audit trail.
    audit: async () => {},
  });
  dbCleanup = () => {
    db.destroy().catch(() => {});
  };
});

afterAll(() => {
  // Reap every tmux server this file may have left standing (see
  // spawnedSockets). kill-server tears down the whole daemon, so even a test
  // that exits before terminating its session cannot leak a stub pane into the
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

describe("SessionManagerService", () => {
  it("creates a session with a default name and tmux socket", async () => {
    const workDir = mkdtempSync(join(testDir, "ws-"));
    writeFileSync(join(workDir, "file.txt"), "x");

    const profileId = await seedProfile(profilesRepo, { name: "Default" });

    const created = await sessionManager.createSession({
      userId: "u1",
      profileId,
      workingDir: workDir,
    });
    trackTmuxSocket(created.tmuxSocket);

    expect(created.id).toBeTruthy();
    expect(created.tmuxSocket).toMatch(/^mote-/);
    expect(tmuxSocketFor(created.id)).toBe(created.tmuxSocket);

    // The tmux session should actually be alive (real tmux on this host).
    const row = await sessionsRepo.findById(created.id);
    expect(row).toBeTruthy();
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    // A fresh session is stamped as just-started output (shows active).
    expect(row?.lastOutputAt).toBeTruthy();

    await sessionManager.terminateSession("u1", created.id);
    const after = await sessionsRepo.findById(created.id);
    expect(after?.status).toBe("terminated");
    expect(after?.alive).toBe(0);
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(false);
  });

  it("rejects sessions for a nonexistent profile", async () => {
    await expect(
      sessionManager.createSession({ userId: "u1", profileId: "missing", workingDir: "/tmp" }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a missing working directory", async () => {
    const profileId = await seedProfile(profilesRepo);
    await expect(
      sessionManager.createSession({ userId: "u1", profileId, workingDir: "/definitely/not/here" }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("SessionManagerService notes + restart", () => {
  /** Inserts a session row directly (no tmux involvement). */
  async function seedSession(userId: string, profileId: string): Promise<string> {
    const id = crypto.randomUUID();
    await sessionsRepo.create({
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

  /** Real profile row (restartSession re-validates + spawns tmux). */
  const seedProfileFor = (userId: string) => seedProfile(profilesRepo, { userId });

  it("updateNotes sets a note for the owner", async () => {
    const id = await seedSession("u1", "p");
    expect(await sessionManager.updateNotes("u1", id, "working on X")).toBe(true);
    const row = await sessionsRepo.findById(id);
    expect(row?.notes).toBe("working on X");
    // Clearing sets null.
    expect(await sessionManager.updateNotes("u1", id, null)).toBe(true);
    expect((await sessionsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes trims and normalizes empty notes to null", async () => {
    const id = await seedSession("u1", "p");
    expect(await sessionManager.updateNotes("u1", id, "  spaced  ")).toBe(true);
    expect((await sessionsRepo.findById(id))?.notes).toBe("spaced");
    expect(await sessionManager.updateNotes("u1", id, "   ")).toBe(true);
    expect((await sessionsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes rejects a foreign userId (404 path)", async () => {
    const id = await seedSession("u1", "p");
    expect(await sessionManager.updateNotes("u2", id, "nope")).toBe(false);
    expect((await sessionsRepo.findById(id))?.notes).toBeNull();
  });

  it("updateNotes returns false for a missing session", async () => {
    expect(await sessionManager.updateNotes("u1", "does-not-exist", "x")).toBe(false);
  });

  it("restartSession revives the SAME row (same id, name, profile; parked fields cleared)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);
    await sessionsRepo.update(id, {
      status: "terminated",
      alive: 0,
      exitCode: 3,
      endedAt: new Date().toISOString(),
      backoffCount: 4,
      nextRestartAt: new Date().toISOString(),
    });
    const restarted = await sessionManager.restartSession("u1", id);
    if (!restarted) throw new Error("expected a restarted session");
    trackTmuxSocket(restarted.tmuxSocket);
    expect(restarted.id).toBe(id); // NOT a new id — in-place revival
    const row = await sessionsRepo.findById(id);
    expect(row?.name).toBe("Original"); // no " (2)" suffix ever
    expect(row?.profileId).toBe(profileId);
    expect(row?.status).toBe("running");
    expect(row?.alive).toBe(1);
    expect(row?.exitCode).toBeNull();
    expect(row?.endedAt).toBeNull();
    expect(row?.backoffCount).toBe(0); // operator intent resets the ladder
    expect(row?.nextRestartAt).toBeNull();
    expect(row?.tmuxSocket).toBe(restarted.tmuxSocket);

    // A REAL tmux session was spawned — end it here or its server outlives
    // the suite with the stub pane still attached (regression guard: the old
    // clone test used to leak exactly that).
    await sessionManager.terminateSession("u1", id);
    expect(sessionManager.isAlive({ id, tmuxSocket: restarted.tmuxSocket })).toBe(false);
  });

  it("restartSession kills a live source before respawning it (same row, same socket)", async () => {
    const profileId = await seedProfileFor("u1");
    const created = await sessionManager.createSession({ userId: "u1", profileId, workingDir: "/tmp" });
    trackTmuxSocket(created.tmuxSocket);
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    const restarted = await sessionManager.restartSession("u1", created.id);
    if (!restarted) throw new Error("expected a restarted session");
    expect(restarted.id).toBe(created.id);
    expect(restarted.tmuxSocket).toBe(created.tmuxSocket);
    // A pane is running again under the SAME identity (the stub sleep re-spawned).
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    await sessionManager.terminateSession("u1", created.id);
  });

  it("restartSession keeps the bell on the row (operator monitoring survives a restart)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);
    await sessionsRepo.update(id, { notify: 1 });
    const restarted = await sessionManager.restartSession("u1", id);
    if (!restarted) throw new Error("expected a restarted session");
    trackTmuxSocket(restarted.tmuxSocket);
    try {
      // Same row now — the bell needs no "inheritance", it must simply survive.
      expect((await sessionsRepo.findById(id))?.notify).toBe(1);
    } finally {
      await sessionManager.terminateSession("u1", id);
    }
  });

  // Regression (review #1/#5): the in-flight lease is MODULE-level, not
  // per-instance — the route, the sweep, and the MCP server each build their
  // own manager. A gated token.issue lets us observe manager A mid-restart and
  // assert a SECOND instance joins it (never spawns), and that a foreign
  // caller is rejected on ownership BEFORE it can ride A's lease.
  it("concurrent restartSession across two manager instances joins one revival", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let aIssues = 0;
    let bIssues = 0;
    const mkManager = (tally: () => void, gateOnIssue = false) =>
      new SessionManagerService({
        sessions: sessionsRepo,
        profiles: profilesRepo,
        tmux: new TmuxRunner(),
        tokens: {
          issue: async () => {
            tally();
            if (gateOnIssue) await gate; // hold A inside #reviveRow, post-park
            return "mote_stub";
          },
          revoke: async () => {},
        },
        audit: async () => {},
      });
    const a = mkManager(() => aIssues++, true);
    const b = mkManager(() => bIssues++);

    const pA = a.restartSession("u1", id); // starts, parks, reaches issue, waits
    for (let i = 0; aIssues === 0 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
    expect(aIssues).toBe(1); // A is now parked + mid-revival

    // Same owner, DIFFERENT instance → must join A's lease (never spawn).
    const pB = b.restartSession("u1", id);
    // Foreign caller must be rejected on ownership, NOT handed A's result.
    expect(await b.restartSession("u2", id)).toBeNull();

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
      await a.terminateSession("u1", id);
    }
  });

  // Regression (review #4): a relaunch that can't be composed must roll the
  // parked `running` row back to `terminated`, so the sweep neither sees a
  // `running` zombie nor auto-revives it when the harness later reappears.
  it("restartSession rolls the row back to terminated when the relaunch throws", async () => {
    const id = await seedSession("u1", "no-such-profile"); // reviveRow throws: profile gone
    await sessionsRepo.update(id, { status: "terminated", alive: 0, exitCode: 1 });
    await expect(sessionManager.restartSession("u1", id)).rejects.toThrow(/profile/);
    const row = await sessionsRepo.findById(id);
    expect(row?.status).toBe("terminated"); // NOT left running
    expect(row?.alive).toBe(0);
  });

  it("restartSession rejects a foreign userId (404 path)", async () => {
    const id = await seedSession("u1", "p");
    expect(await sessionManager.restartSession("u2", id)).toBeNull();
  });

  it("restartSession returns null for a missing session", async () => {
    expect(await sessionManager.restartSession("u1", "does-not-exist")).toBeNull();
  });

  it("reconcile marks a dead tmux session as not-alive (crash)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId); // tmuxSocket null → not alive
    await sessionManager.reconcile("u1");
    const row = await sessionsRepo.findById(id);
    expect(row?.alive).toBe(0);
    // A crash is NOT a terminate: the row stays running so the UI can
    // distinguish exited from terminated (regression guard).
    expect(row?.status).toBe("running");
    // But it did end at this moment: ended_at is stamped so zombie rows
    // carry a truthful end time (a later auto-restart clears it again).
    expect(row?.endedAt).toBeTruthy();
  });

  it("auto-restarts a restart_on_exit session after backoff, same row", async () => {
    const profileId = await seedProfileFor("u1");
    await profilesRepo.update(profileId, { restartOnExit: 1 });
    const created = await sessionManager.createSession({ userId: "u1", profileId, workingDir: "/tmp" });
    trackTmuxSocket(created.tmuxSocket);
    const id = created.id;
    // The session inherits the profile's auto-restart policy at creation.
    expect((await sessionsRepo.findById(id))?.restartOnExit).toBe(1);

    // Real crash: kill the tmux tree, then stamp the row dead with a
    // past-due backoff so the next sweep is allowed to restart.
    new TmuxRunner().killSession(created.tmuxSocket, id);
    await sessionsRepo.update(id, {
      alive: 0,
      exitCode: 1,
      backoffCount: 0,
      endedAt: new Date(Date.now() - 2_000).toISOString(), // crash-stamped
      nextRestartAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await sessionManager.reconcileAll();
    const after = await sessionsRepo.findById(id);
    expect(after?.alive).toBe(1); // restarted (same row)
    expect(after?.backoffCount).toBe(1); // backoff incremented
    expect(after?.nextRestartAt).toBeNull(); // no pending backoff
    expect(after?.endedAt).toBeNull(); // a running process has not ended

    // A healthy sweep (alive at sweep) resets the backoff counter.
    await sessionManager.reconcileAll();
    expect((await sessionsRepo.findById(id))?.backoffCount).toBe(0);

    // No restart while the backoff is still pending.
    new TmuxRunner().killSession(created.tmuxSocket, id);
    await sessionsRepo.update(id, {
      alive: 0,
      nextRestartAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await sessionManager.reconcileAll();
    expect((await sessionsRepo.findById(id))?.alive).toBe(0);

    await sessionManager.terminateSession("u1", id);
  });

  it("deleteSession removes the row and its log file", async () => {
    const id = await seedSession("u1", "p");
    const logFile = sessionLogPath(id);
    writeFileSync(logFile, "output");
    expect(await sessionManager.deleteSession("u1", id)).toBe(true);
    expect(await sessionsRepo.findById(id)).toBeUndefined();
    expect(existsSync(logFile)).toBe(false);
  });

  it("deleteSession rejects a foreign userId (404 path)", async () => {
    const id = await seedSession("u1", "p");
    expect(await sessionManager.deleteSession("u2", id)).toBe(false);
    expect(await sessionsRepo.findById(id)).toBeTruthy();
  });

  it("deleteSession returns false for a missing session", async () => {
    expect(await sessionManager.deleteSession("u1", "does-not-exist")).toBe(false);
  });
});

describe("reconcile notifications", () => {
  /**
   * A manager wired to a recording notify sink. Only this instance sees the
   * calls, and no socket is ever spawned here — sweeps run against dead
   * (never-existing) tmux targets, so no `trackTmuxSocket` registration.
   */
  function notifySpyManager(): { manager: SessionManagerService; calls: Array<[string, string]> } {
    const calls: Array<[string, string]> = [];
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
      profiles: profilesRepo,
      tmux: new TmuxRunner(),
      tokens: { issue: async () => "mote_stub", revoke: async () => {} },
      audit: async () => {},
      notify: async (id, kind) => {
        calls.push([id, kind]);
      },
    });
    return { manager, calls };
  }

  /** Inserts a running row directly; `over` steers the death-branch inputs. */
  async function seedRunning(id: string, over: Partial<Parameters<typeof sessionsRepo.create>[0]> = {}) {
    await sessionsRepo.create({
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
    const row = await sessionsRepo.findById(id);
    expect(row?.alive).toBe(0);
    // Death ends the "waiting for you" state — no stale stamp left behind.
    expect(row?.waitingSince).toBeNull();
    expect(callsFor(calls, id)).toEqual([[id, "exited"]]);
  });

  it("notifies 'crashed' when the dead session opted into auto-restart", async () => {
    const id = crypto.randomUUID();
    // Nonexistent socket → the hasSession===false death branch. The future
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
    const row = await sessionsRepo.findById(id);
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
    const row = await sessionsRepo.findById(id);
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
      "My Session",
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

  it("defaults session name to current datetime", () => {
    const name = defaultSessionName();
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
  function setPaneTitle(socket: string, sessionName: string, title: string): void {
    const r = spawnSync(["tmux", "-L", socket, "select-pane", "-t", sessionName, "-T", title]);
    expect(r.exitCode).toBe(0);
  }

  async function liveSession(): Promise<{ id: string; socket: string; defaultName: string }> {
    const profileId = await seedProfile(profilesRepo);
    const created = await sessionManager.createSession({ userId: "u1", profileId, workingDir: TMP_RESOLVED });
    trackTmuxSocket(created.tmuxSocket);
    const row = await sessionsRepo.findById(created.id);
    return { id: created.id, socket: created.tmuxSocket, defaultName: row?.name ?? "" };
  }

  it("adopts a published title into the name of an unlocked session", async () => {
    const s = await liveSession();
    try {
      setPaneTitle(s.socket, s.id, "Adopt monorepo structure patterns");
      await sessionManager.reconcile("u1");
      expect((await sessionsRepo.findById(s.id))?.name).toBe("Adopt monorepo structure patterns");
    } finally {
      await sessionManager.terminateSession("u1", s.id);
    }
  });

  it("strips Claude Code's leading status glyph so the name does not churn", async () => {
    const s = await liveSession();
    try {
      // The spinner char cycles (✳/✻/·…) between sweeps; only the task text
      // may survive into the name.
      setPaneTitle(s.socket, s.id, "✳ Ship the rename feature");
      await sessionManager.reconcile("u1");
      expect((await sessionsRepo.findById(s.id))?.name).toBe("Ship the rename feature");
      setPaneTitle(s.socket, s.id, "✻ Ship the rename feature");
      await sessionManager.reconcile("u1");
      expect((await sessionsRepo.findById(s.id))?.name).toBe("Ship the rename feature");
    } finally {
      await sessionManager.terminateSession("u1", s.id);
    }
  });

  it("never overwrites a locked (renamed) name", async () => {
    const s = await liveSession();
    try {
      expect(await sessionManager.updateName("u1", s.id, "Keep me")).toBe(true);
      setPaneTitle(s.socket, s.id, "Some other task");
      await sessionManager.reconcile("u1");
      const row = await sessionsRepo.findById(s.id);
      expect(row?.name).toBe("Keep me");
      expect(row?.nameLocked).toBe(1);
    } finally {
      await sessionManager.terminateSession("u1", s.id);
    }
  });

  it("leaves an untouched pane (title = host default) at its created name", async () => {
    const s = await liveSession();
    try {
      await sessionManager.reconcile("u1");
      expect((await sessionsRepo.findById(s.id))?.name).toBe(s.defaultName);
    } finally {
      await sessionManager.terminateSession("u1", s.id);
    }
  });

  it("resumes adopting after the lock is released", async () => {
    const s = await liveSession();
    try {
      await sessionManager.updateName("u1", s.id, "Pinned");
      await sessionManager.setNameLocked("u1", s.id, false);
      setPaneTitle(s.socket, s.id, "Back on auto");
      await sessionManager.reconcile("u1");
      expect((await sessionsRepo.findById(s.id))?.name).toBe("Back on auto");
    } finally {
      await sessionManager.terminateSession("u1", s.id);
    }
  });
});

describe("SessionManagerService restart-resume", () => {
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
      // tmux spawns the pane asynchronously: newSession returning only means
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
      const created = await sessionManager.createSession({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(created.tmuxSocket);
      try {
        const row = await sessionsRepo.findById(created.id);
        expect(row?.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
        const argv = await sb.argv();
        expect(argv).toContain("--session-id");
        expect(argv[argv.indexOf("--session-id") + 1] ?? "").toBe(row?.harnessSessionId ?? "");
      } finally {
        await sessionManager.terminateSession("u1", created.id);
      }
    } finally {
      sb.restore();
    }
  });

  it("a terminated session's restart RESUMES its conversation", async () => {
    const sb = await resumeSandbox("resume");
    try {
      const workDir = mkdtempSync(join(testDir, "ws-"));
      const profileId = await seedProfile(profilesRepo);
      const first = await sessionManager.createSession({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const row1 = await sessionsRepo.findById(first.id);
      const pinned = row1?.harnessSessionId ?? "";
      expect(pinned).toBeTruthy();
      // The stub harness never wrote a transcript; simulate the conversation
      // existing before the restart probes for it.
      const tPath = transcriptPath(sb.configDir, workDir, pinned);
      mkdirSync(tPath.slice(0, tPath.lastIndexOf("/")), { recursive: true });
      writeFileSync(tPath, "{}\n");
      await sessionManager.terminateSession("u1", first.id);
      sb.clear();
      const second = await sessionManager.restartSession("u1", first.id);
      if (!second) throw new Error("expected a restarted session");
      trackTmuxSocket(second.tmuxSocket);
      try {
        const row2 = await sessionsRepo.findById(second.id);
        // Same lineage id, and the launch continues it rather than pinning anew.
        expect(row2?.harnessSessionId).toBe(pinned);
        const argv = await sb.argv();
        expect(argv).toContain("--resume");
        expect(argv[argv.indexOf("--resume") + 1]).toBe(pinned);
        expect(argv).not.toContain("--session-id");
      } finally {
        await sessionManager.terminateSession("u1", second.id);
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
      const first = await sessionManager.createSession({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const pinned = (await sessionsRepo.findById(first.id))?.harnessSessionId ?? "";
      await sessionManager.terminateSession("u1", first.id);
      sb.clear();
      // No transcript at all: `--resume <pinned>` would make claude print
      // "No conversation found" and exit — the restart must pin a NEW id.
      const second = await sessionManager.restartSession("u1", first.id);
      if (!second) throw new Error("expected a restarted session");
      trackTmuxSocket(second.tmuxSocket);
      try {
        const row2 = await sessionsRepo.findById(second.id);
        expect(row2?.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(row2?.harnessSessionId).not.toBe(pinned);
        const argv = await sb.argv();
        expect(argv[argv.indexOf("--session-id") + 1] ?? "").toBe(row2?.harnessSessionId ?? "");
      } finally {
        await sessionManager.terminateSession("u1", second.id);
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
      const first = await sessionManager.createSession({ userId: "u1", profileId, workingDir: workDir });
      trackTmuxSocket(first.tmuxSocket);
      const pinned = (await sessionsRepo.findById(first.id))?.harnessSessionId ?? "";
      try {
        sb.clear();
        const second = await sessionManager.restartSession("u1", first.id);
        if (!second) throw new Error("expected a restarted session");
        trackTmuxSocket(second.tmuxSocket);
        const row2 = await sessionsRepo.findById(second.id);
        // Source pane is still appending to `pinned` — the clone gets its own.
        expect(row2?.harnessSessionId).not.toBe(pinned);
        const argv = await sb.argv();
        expect(argv).toContain("--session-id");
        await sessionManager.terminateSession("u1", second.id);
      } finally {
        await sessionManager.terminateSession("u1", first.id);
      }
    } finally {
      sb.restore();
    }
  });
});
