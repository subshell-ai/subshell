import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import {
  normalizePaneTitleForTests,
  SubshellManagerService,
  type SubshellTokenProvider,
} from "@/services/subshell-manager.service.js";

/**
 * Titling contract (spec 2026-09-03): a name only reaches the pane command
 * (`--name`, which pins the harness's terminal title) when a HUMAN chose it.
 * An unnamed create passes "" so the harness titles its own pane and the
 * reconcile sweep adopts the live title into `row.name`; a restart re-sends
 * the name only when `nameLocked = 1` (rename or pin). The DB row and the
 * baked SUBSHELL_NAME env keep carrying the display name (placeholder until
 * the first adoption) in every case.
 */

/** Records the assembled pane commands; nothing real is spawned. */
class MockTmux extends TmuxRunner {
  newSubshellCmds: string[] = [];
  alive = true;

  override newSubshell(_socket: string, _sessionName: string, _cwd: string, cmd: string): void {
    this.newSubshellCmds.push(cmd);
  }
  override pipePane(): void {}
  override async hasSubshell(): Promise<boolean> {
    return this.alive;
  }
  override async capturePane(): Promise<string> {
    return "";
  }
  override async sendInput(): Promise<void> {}
  override async pressEnter(): Promise<void> {}
  override async paneExitCode(): Promise<number | null> {
    return null;
  }
}

class StubTokens implements SubshellTokenProvider {
  async issue(): Promise<string> {
    return "subshell_stub";
  }
  async revoke(): Promise<void> {}
}

const testDir = mkdtempSync(join(tmpdir(), "subshell-titling-test-"));
let db: Kysely<Database>;
let presets: PresetsRepository;
let subshells: SubshellsRepository;
let tmux: MockTmux;
let manager: SubshellManagerService;
let presetId: string;
let previousClaudePath: string | undefined;

beforeAll(async () => {
  // Same hermetic harness trick as the MCP suite: CLAUDE_PATH is the first
  // thing findBinary() consults, so binary resolution never touches the host.
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
  await profileDefaultFlagMigration.up(db);
  await sessionNameLockedMigration.up(db);
  await sessionHarnessIdMigration.up(db);
  await sessionNotificationsMigration.up(db);
  await nodesMigration.up(db);
  await sharingMigration.up(db);
  await subshellRenameMigration.up(db); // renamed schema the code sees
  await presetsMigration.up(db); // profiles → presets (spec 2026-09-13 §6)
  presets = new PresetsRepository(db);
  subshells = new SubshellsRepository(db);
  presetId = await seedPreset(presets);
});

beforeEach(() => {
  tmux = new MockTmux();
  manager = new SubshellManagerService({ subshells, presets, tmux, tokens: new StubTokens(), audit: async () => {} });
});

afterAll(() => {
  if (previousClaudePath === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = previousClaudePath;
  db.destroy().catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("pane titling — who gets --name", () => {
  it("create without a user name: no --name in the pane command, row keeps the date/time placeholder", async () => {
    const created = await manager.createSubshell({
      userId: "u1",
      harnessId: "claude-code",
      presetId,
      workingDir: testDir,
    });
    const cmd = tmux.newSubshellCmds[0] ?? "";
    expect(cmd).not.toContain("'--name'");
    const row = await subshells.findById(created.id);
    expect(row?.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // The env is the once-at-launch display name and still carries the placeholder.
    expect(cmd).toContain(`SUBSHELL_NAME='${row?.name}'`);
  });

  it("create with a user name: it is forwarded verbatim as --name", async () => {
    const created = await manager.createSubshell({
      userId: "u1",
      harnessId: "claude-code",
      presetId,
      workingDir: testDir,
      name: "Ship the fix",
    });
    expect(tmux.newSubshellCmds[0]).toContain("'--name' 'Ship the fix'");
    const row = await subshells.findById(created.id);
    expect(row?.name).toBe("Ship the fix");
  });

  it("restart of an unlocked row: an auto-adopted title is NOT re-sent as --name", async () => {
    const created = await manager.createSubshell({
      userId: "u1",
      harnessId: "claude-code",
      presetId,
      workingDir: testDir,
    });
    // Simulate what the sweep does: adopt the pane title into an UNLOCKED row.
    await subshells.update(created.id, { name: "Fix auth bug" });
    await manager.restartSubshell("u1", created.id);
    const restartCmd = tmux.newSubshellCmds[1] ?? "";
    expect(restartCmd).not.toBe("");
    expect(restartCmd).not.toContain("'--name'");
    // ...while the env still carries the row's display name.
    expect(restartCmd).toContain("SUBSHELL_NAME='Fix auth bug'");
  });

  it("restart of a locked row: the pinned name IS re-sent as --name", async () => {
    const created = await manager.createSubshell({
      userId: "u1",
      harnessId: "claude-code",
      presetId,
      workingDir: testDir,
      name: "Pinned",
    });
    await subshells.update(created.id, { nameLocked: 1 });
    await manager.restartSubshell("u1", created.id);
    expect(tmux.newSubshellCmds[1]).toContain("'--name' 'Pinned'");
  });
});

/**
 * What a pane may name a subshell (operator's screenshot, 2026-09-18).
 *
 * A pane's title is program output, and programs write escape sequences into
 * the same byte stream. The cleaner used to blank control characters ONE AT A
 * TIME, which deleted the `ESC` that identified a sequence and kept its
 * payload as if it were text — and the leading-punctuation trim then removed
 * the introducer too. A Kitty graphics capability QUERY, which an agent emits
 * to ask whether the terminal can show images, therefore arrived in the
 * sidebar as a subshell named `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA`.
 *
 * The rule now: a sequence is removed WHOLE, so a title that is nothing but a
 * sequence normalizes to "" and the caller keeps the name it already had.
 */
describe("normalizePaneTitle", () => {
  const norm = normalizePaneTitleForTests;

  it("drops a Kitty graphics query instead of laundering it into a name", () => {
    expect(norm("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\")).toBe("");
  });

  // A title captured mid-sequence has no displayable remainder, and keeping
  // the tail is exactly how the payload got through before.
  it("drops an UNTERMINATED sequence rather than keeping its tail", () => {
    expect(norm("\x1b_Gi=31,s=1,v=1,a=q")).toBe("");
  });

  // The same defect in its commonest clothing: a colour code used to become
  // "31m…" glued to the front of the real title.
  it("removes CSI colour codes without gluing their parameters to the text", () => {
    expect(norm("\x1b[31mnpm run dev\x1b[0m")).toBe("npm run dev");
  });

  it("drops an OSC string whole", () => {
    expect(norm("\x1b]0;hello\x07")).toBe("");
  });

  // The behaviour that already existed and must survive the reordering.
  it("still strips the harness's cycling status glyph", () => {
    expect(norm("✳ Building the thing")).toBe("Building the thing");
  });

  it("still passes an ordinary title through, and still bounds it", () => {
    expect(norm("my-macbook")).toBe("my-macbook");
    expect(norm("x".repeat(200))).toHaveLength(120);
  });

  it("still answers empty for a title with nothing displayable", () => {
    expect(norm("   \x00\x07  ")).toBe("");
  });

  /**
   * The properties that matter because this input is ATTACKER-INFLUENCED: a
   * pane's title is program output, the result becomes a subshell NAME, and a
   * name reaches other users' sidebars and this server's log lines
   * (`.claude/rules/security-context.md`, "normalized so it cannot carry
   * control characters into another user's screen or a log line").
   */
  it("lets no control character survive, whatever the input", () => {
    const hostile = "\x1b_G;AAA\x1b\\ok\x00\x07\x1b[31m\x1b]0;t\x07\x7f more";
    const out = norm(hostile);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
    // The TEXT between the sequences survives, which is the point — this
    // strips structure, it does not censor. Only the sequences go.
    expect(out).toBe("ok     more");
  });

  /**
   * 8-bit C1 introducers (review N3). Valid UTF-8 can carry U+0080–U+009F, and
   * U+009B is CSI — the sequence sweep only knows the 7-bit `ESC x` forms, so
   * without the widened class one would ride through with its payload.
   */
  it("drops 8-bit C1 controls, which the escape sweep cannot see", () => {
    expect(norm("\u009b31mhello")).toBe("31mhello");
    expect(norm("\u009dtitle\u009c")).toBe("title");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(norm("a\u0080\u009fb")).not.toMatch(/[\u0080-\u009f]/);
  });

  it("stays bounded however long the title is", () => {
    expect(norm(`${"\x1b[31m".repeat(500)}${"n".repeat(500)}`)).toHaveLength(120);
  });

  /**
   * Linear, not quadratic. The lazy string-kind branch has `$` as a
   * terminator alternative, so the FIRST unterminated introducer consumes the
   * remainder and the scan happens once rather than per introducer — measured
   * at 1.9 ms for 1.6 MB of nothing but introducers. Pinned with a generous
   * budget because the point is the ORDER of growth, not a millisecond count
   * on any particular machine.
   */
  it("does not degrade on a title that is nothing but escape introducers", () => {
    const evil = `${"\x1b_".repeat(20_000)}x`;
    const started = performance.now();
    expect(norm(evil)).toBe("");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
