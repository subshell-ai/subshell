import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { NewPreset } from "@/db/types/presets.db-types.js";

/**
 * The three repository methods the instance plugins door (spec 2026-09-10
 * §6.1) needed that did not exist: preset list/delete BY HARNESS across all
 * users (the blast radius and the mode=delete sweep), running-subshell count
 * by harness (the impact endpoint), and the `plugin_state` store behind the
 * enable flag.
 */

const HARNESS = `harness-${crypto.randomUUID().slice(0, 8)}`;
const presets = new PresetsRepository(db);
const subshells = new SubshellsRepository(db);

function mkPreset(userId: string): NewPreset {
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
  };
}

describe("PresetsRepository.listByHarness / deleteByHarness", () => {
  const alice = `byh-alice-${crypto.randomUUID().slice(0, 8)}`;
  const bob = `byh-bob-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations();
  });

  it("lists every user's presets for one harness, and nothing for another", async () => {
    const a = await presets.create(mkPreset(alice));
    const b = await presets.create(mkPreset(bob));
    // A different harness for the same user must not appear.
    const other = await presets.create({ ...mkPreset(alice), harnessId: `${HARNESS}-other` });

    const rows = await presets.listByHarness(HARNESS);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.id === other.id)).toBeUndefined();

    await db.deleteFrom("presets").where("id", "in", [a.id, b.id, other.id]).execute();
  });

  it("deleteByHarness removes rows across users, counts them, and nulls references", async () => {
    // The mode=delete sweep. Subshells that used a swept preset survive it:
    // their `preset_id` is nullled in the same transaction, so a later
    // restart composes from the empty preset (spec 2026-09-13 §6).
    const mine = await presets.create(mkPreset(alice));
    const _theirs = await presets.create(mkPreset(bob));
    const _theirs2 = await presets.create(mkPreset(bob));
    const otherHarness = await presets.create({ ...mkPreset(bob), harnessId: `${HARNESS}-other` });
    // A running-subshell-less row pointing at `mine` — the reference to null.
    const userA = crypto.randomUUID();
    await subshells.create({
      id: userA,
      userId: alice,
      presetId: mine.id,
      harnessId: HARNESS,
      name: userA,
      workingDir: "/tmp",
      tmuxSocket: null,
    });

    const removed = await presets.deleteByHarness(HARNESS);
    expect(removed).toBe(3);
    expect(await presets.listByHarness(HARNESS)).toEqual([]);
    // The reference is NULL, not a dangling id: the subshell outlives its preset.
    expect((await subshells.findById(userA))?.presetId).toBeNull();
    // Untouched: a different harness's row survives the sweep.
    expect(await presets.findById(otherHarness.id)).toBeDefined();

    await presets.delete(otherHarness.id);
    await subshells.delete(userA);
  });

  it("deleteByHarness on an unknown harness is a no-op counting zero", async () => {
    expect(await presets.deleteByHarness(`nope-${crypto.randomUUID()}`)).toBe(0);
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
      presetId: "p",
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

describe("PresetsRepository.update", () => {
  // The workspaces twin of this line wrote `datetime('now')` and every renamed
  // workspace sorted as the oldest one owned; this pins the ISO form here so
  // the same defect cannot arrive the day something orders presets by recency.
  it("stamps updated_at in the ISO form the column default uses", async () => {
    const created = await presets.create({
      id: crypto.randomUUID(),
      userId: `stamp-${crypto.randomUUID().slice(0, 8)}`,
      harnessId: "claude-code",
      name: "stamp",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    } as NewPreset);
    const updated = await presets.update(created.id, { name: "stamped" });
    expect(updated?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });
});
