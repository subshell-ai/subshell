import { expect, test } from "bun:test";
import { allSpecs, E2E_SHARDS, e2eShardFiles, FIXTURE_HEAVY, SETUP_SPECS } from "../e2e-shard";

test("every spec lands in exactly one browser shard, and both shards run setup", () => {
  const all = allSpecs();
  for (const file of Object.keys(FIXTURE_HEAVY)) expect(all).toContain(file);
  const first = e2eShardFiles([], 1);
  const second = e2eShardFiles([], 2);
  expect(first.slice(0, SETUP_SPECS.length)).toEqual([...SETUP_SPECS]);
  expect(second.slice(0, SETUP_SPECS.length)).toEqual([...SETUP_SPECS]);
  const tests = [...first, ...second].filter((file) => !SETUP_SPECS.includes(file));
  expect(tests.toSorted()).toEqual(all.filter((file) => !SETUP_SPECS.includes(file)).toSorted());
  expect(new Set(tests).size).toBe(tests.length);
});

test("a partial selection is split, and a shard with no selected file skips", () => {
  const selected = ["tests/04-presets.spec.ts", "tests/22-ssh-terminal.spec.ts"];
  expect(e2eShardFiles(selected, 1)).toEqual([...SETUP_SPECS, "tests/04-presets.spec.ts"]);
  expect(e2eShardFiles(selected, 2)).toEqual([...SETUP_SPECS, "tests/22-ssh-terminal.spec.ts"]);
  // The heavy selection belongs entirely to shard 2; shard 1 must not boot a
  // stack just to run the wizard.
  expect(e2eShardFiles(["tests/22-ssh-terminal.spec.ts"], 1)).toEqual([]);
});

test("a setup-only selection still runs the wizard in one shard", () => {
  expect(e2eShardFiles(["tests/01-setup-wizard.spec.ts"], 1)).toEqual([...SETUP_SPECS]);
  expect(e2eShardFiles(["tests/01-setup-wizard.spec.ts"], 2)).toEqual([]);
});

test("an out-of-range shard is refused", () => {
  expect(() => e2eShardFiles([], E2E_SHARDS + 1)).toThrow();
});
