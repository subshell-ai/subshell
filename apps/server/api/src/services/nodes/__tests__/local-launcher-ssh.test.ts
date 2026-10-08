import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath, getHarness, TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { TRUE_BINARY } from "@/__tests__/helpers/true-binary.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { LocalLauncher } from "../local-launcher.js";
import type { LaunchPlan } from "../node-launcher.js";
import { subshellLogPath, subshellSshConfigPath } from "../subshell-paths.js";

/**
 * Task 5 (spec 2026-10-07 decision 4): the LOCAL twin of the agent's ssh
 * config write. `LocalLauncher.launch` materializes the rendered config under
 * the SERVER's own dataDir, at the same derived path the ssh service composed,
 * BEFORE the pane spawns — and `subshellArtifacts` names it for the delete
 * sweep only when the caller says the pane was an ssh pane.
 *
 * Scripted tmux (no real spawn): the write is pure fs, and the spawn-side
 * contract is exactly "the file was there when tmux was dialed".
 */

const SSH_CONTENT = "Host *\n    StrictHostKeyChecking yes\n";
const pid = process.pid;

/** Counts the spawn and records whether the config existed at spawn time. */
class ScriptedTmux extends TmuxRunner {
  spawns = 0;
  pipes = 0;
  configAtSpawn: boolean | null = null;
  readonly #watchPath: () => string;
  constructor(watchPath: () => string) {
    super();
    this.#watchPath = watchPath;
  }
  override newSubshell(): void {
    this.spawns++;
    this.configAtSpawn = existsSync(this.#watchPath());
  }
  override pipePane(): void {
    this.pipes++;
  }
}

const sshHarness = getHarness("ssh");
if (!sshHarness) throw new Error("ssh harness plugin missing from the registry");

// An arrow const (not a hoisted function declaration): the module-level
// narrowing of `sshHarness` survives into it (the pattern
// local-launcher.test.ts uses for the pi harness).
const sshPlan = (id: string, over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  id,
  socket: tmuxSocketFor(id),
  harness: sshHarness,
  binary: TRUE_BINARY,
  cwd: tmpdir(),
  preset: {
    name: "p",
    description: null,
    env: {},
    flags: ["-F", buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id), "--"],
    settings: null,
    configIsolation: false,
    restartOnExit: false,
  },
  subshellName: "s",
  subshellEnv: {},
  ...over,
});

function cleanup(id: string): void {
  rmSync(join(SUBSHELL_SERVER_DATA_DIR, "ssh", id), { recursive: true, force: true });
  void Bun.file(subshellLogPath(id))
    .unlink()
    .catch(() => {});
}

describe("LocalLauncher ssh config write (spec 2026-10-07 decision 4)", () => {
  it("launch(plan with ssh): config at the derived path, 0600 in a 0700 dir, content byte-equal, written BEFORE the spawn", async () => {
    const id = `launcher-ssh-${pid}`;
    const configPath = buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id);
    const scripted = new ScriptedTmux(() => configPath);
    const launcher = new LocalLauncher({ tmux: scripted });
    try {
      await launcher.launch(sshPlan(id, { ssh: { configPath, fileContent: SSH_CONTENT } }));
      expect(scripted.spawns).toBe(1);
      expect(scripted.configAtSpawn).toBe(true); // the file existed when tmux was dialed
      expect(await Bun.file(configPath).text()).toBe(SSH_CONTENT);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      const parent = configPath.slice(0, configPath.lastIndexOf("/"));
      expect(statSync(parent).mode & 0o777).toBe(0o700);
    } finally {
      cleanup(id);
    }
  });

  it("the derived path is the single composition: subshellSshConfigPath == buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id)", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(subshellSshConfigPath(id)).toBe(buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id));
  });

  it("configPath mismatch: launch throws, nothing written, nothing spawned", async () => {
    const id = `launcher-ssh-mismatch-${pid}`;
    const scripted = new ScriptedTmux(() => buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id));
    const launcher = new LocalLauncher({ tmux: scripted });
    try {
      await expect(
        launcher.launch(
          sshPlan(id, {
            ssh: {
              configPath: buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, `${id}-elsewhere`),
              fileContent: SSH_CONTENT,
            },
          }),
        ),
      ).rejects.toThrow(/ssh config path/i);
      expect(scripted.spawns).toBe(0); // refused before the spawn
      expect(existsSync(join(SUBSHELL_SERVER_DATA_DIR, "ssh", id))).toBe(false);
    } finally {
      cleanup(id);
    }
  });

  it("no ssh member: the launch creates no ssh dir for an ordinary pane", async () => {
    const id = `launcher-ssh-absent-${pid}`;
    const scripted = new ScriptedTmux(() => "");
    const launcher = new LocalLauncher({ tmux: scripted });
    try {
      await launcher.launch(sshPlan(id));
      expect(scripted.spawns).toBe(1);
      expect(existsSync(join(SUBSHELL_SERVER_DATA_DIR, "ssh", id))).toBe(false);
    } finally {
      cleanup(id);
    }
  });

  it("subshellArtifacts: the ssh config path rides the list for ssh panes only", () => {
    const id = `launcher-ssh-artifacts-${pid}`;
    const launcher = new LocalLauncher({ tmux: new ScriptedTmux(() => "") });
    expect(launcher.subshellArtifacts(id)).toEqual([subshellLogPath(id)]);
    expect(launcher.subshellArtifacts(id, true)).toEqual([
      subshellLogPath(id),
      buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id),
    ]);
  });

  it("delete round-trip: launch writes it, removeArtifacts(subshellArtifacts(id, true)) unlinks it", async () => {
    const id = `launcher-ssh-delete-${pid}`;
    const configPath = buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id);
    const launcher = new LocalLauncher({ tmux: new ScriptedTmux(() => configPath) });
    try {
      await launcher.launch(sshPlan(id, { ssh: { configPath, fileContent: SSH_CONTENT } }));
      expect(existsSync(configPath)).toBe(true);
      await launcher.removeArtifacts(launcher.subshellArtifacts(id, true));
      expect(existsSync(configPath)).toBe(false);
    } finally {
      cleanup(id);
    }
  });
});

afterAll(() => {
  // Defensive: the per-case cleanups own the paths; this sweeps any leftover
  // from a mid-test throw so the shared test dataDir stays tidy.
  rmSync(join(SUBSHELL_SERVER_DATA_DIR, "ssh"), { recursive: true, force: true });
});
