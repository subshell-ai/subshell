import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { NewProfile } from "@/db/types/profiles.db-types.js";

/**
 * The three repository methods the instance plugins door (spec 2026-09-10
 * §6.1) needed that did not exist: profile list/delete BY HARNESS across all
 * users (the blast radius and the mode=delete sweep), running-subshell count
 * by harness (the impact endpoint), and the `plugin_state` store behind the
 * enable flag.
 */

const HARNESS = `harness-${crypto.randomUUID().slice(0, 8)}`;
const profiles = new ProfilesRepository(db);
const subshells = new SubshellsRepository(db);

function mkProfile(userId: string, isDefault = 0): NewProfile {
  return {
    id: crypto.randomUUID(),
    userId,
    harnessId: HARNESS,
    name: `p-${crypto.randomUUID().slice(0, 8)}`,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    isDefault,
  };
}

describe("ProfilesRepository.listByHarness / deleteByHarness", () => {
  const alice = `byh-alice-${crypto.randomUUID().slice(0, 8)}`;
  const bob = `byh-bob-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations();
  });

  it("lists every user's profiles for one harness, and nothing for another", async () => {
    const a = await profiles.create(mkProfile(alice));
    const b = await profiles.create(mkProfile(bob, 1));
    // A different harness for the same user must not appear.
    const other = await profiles.create({ ...mkProfile(alice), harnessId: `${HARNESS}-other` });

    const rows = await profiles.listByHarness(HARNESS);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.id === other.id)).toBeUndefined();

    await db.deleteFrom("profiles").where("id", "in", [a.id, b.id, other.id]).execute();
  });

  it("deleteByHarness removes rows across users INCLUDING Defaults, and counts them", async () => {
    // The `isDefault === 1` guard lives in the per-profile DELETE ROUTE, not
    // here: a Default for a harness that no longer exists is meaningless, and
    // leaving one behind would be the one row its owner cannot remove. This
    // method is the deliberate bypass, used only by `uninstall?mode=delete`.
    const mine = await profiles.create(mkProfile(alice));
    const theirs = await profiles.create(mkProfile(bob));
    const theirDefault = await profiles.create(mkProfile(bob, 1));
    const otherHarness = await profiles.create({ ...mkProfile(bob), harnessId: `${HARNESS}-other` });

    const removed = await profiles.deleteByHarness(HARNESS);
    expect(removed).toBe(3);
    expect(await profiles.listByHarness(HARNESS)).toEqual([]);
    // Untouched: a different harness's row survives the sweep.
    expect(await profiles.findById(otherHarness.id)).toBeDefined();

    await profiles.delete(otherHarness.id);
    expect(mine.id && theirs.id && theirDefault.id).toBeTruthy(); // ids consumed by the sweep
  });

  it("deleteByHarness on an unknown harness is a no-op counting zero", async () => {
    expect(await profiles.deleteByHarness(`nope-${crypto.randomUUID()}`)).toBe(0);
  });
});

describe("SubshellsRepository.countRunningByHarness", () => {
  const owner = `byh-sub-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations();
  });

  async function mkSubshell(harnessId: string, running: boolean): Promise<string> {
    const id = crypto.randomUUID();
    await subshells.create({
      id,
      userId: owner,
      profileId: "p",
      harnessId,
      name: id,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    if (!running) await subshells.markTerminated(id, new Date().toISOString());
    return id;
  }

  it("counts only RUNNING subshells of the named harness, across users", async () => {
    const a = await mkSubshell(HARNESS, true);
    const b = await mkSubshell(HARNESS, true);
    const gone = await mkSubshell(HARNESS, false);
    const other = await mkSubshell(`${HARNESS}-other`, true);

    expect(await subshells.countRunningByHarness(HARNESS)).toBe(2);
    // The count is instance-wide (impact spans every user) but never leaks
    // another harness's or a terminated row into the number.
    expect(await subshells.countRunningByHarness(`${HARNESS}-other`)).toBe(1);

    for (const id of [a, b, gone, other]) await subshells.delete(id);
    expect(await subshells.countRunningByHarness(HARNESS)).toBe(0);
  });
});

describe("PluginStateRepository (absent row means enabled)", () => {
  const id = `state-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations();
  });

  it("reads an absent row as enabled without writing anything", async () => {
    const repo = new PluginStateRepository(db);
    expect(await repo.isEnabled(id)).toBe(true);
    expect(await repo.stateByPluginId().then((m) => m.has(id))).toBe(false);
  });

  it("setEnabled writes a row both ways, and disable survives a re-read", async () => {
    const repo = new PluginStateRepository(db);
    await repo.setEnabled(id, false);
    expect(await repo.isEnabled(id)).toBe(false);
    await repo.setEnabled(id, true);
    expect(await repo.isEnabled(id)).toBe(true);
    // The row EXISTS after the enable write (the ruling): absent-row semantics
    // stay for pre-existing installs, not for explicit operator choices.
    expect((await repo.stateByPluginId()).get(id)).toBe(true);
    await repo.clear(id);
  });

  it("stateByPluginId maps every stored row; clear removes it", async () => {
    const repo = new PluginStateRepository(db);
    await repo.setEnabled(id, false);
    expect((await repo.stateByPluginId()).get(id)).toBe(false);
    await repo.clear(id);
    expect((await repo.stateByPluginId()).has(id)).toBe(false);
    expect(await repo.isEnabled(id)).toBe(true); // back to the absent-row default
  });
});
