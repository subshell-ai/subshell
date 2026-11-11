/// <reference types="bun" />
// e2e's tsconfig narrows "types" to node only (its suite is Playwright), so
// the bun ambient types must be pulled in for the one bun-test file here.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeScratchTree } from "../stack";

/**
 * The retry branch exists for Node's `rmSync`, which throws `ENOTEMPTY` when a
 * straggler creates an entry after the walk deleted its parent (measured on CI
 * 2026-11-11: 29/29 specs green, teardown exit 1). `bun test` runs this module
 * under Bun, whose `rmSync` absorbs a concurrent writer, so the remover is
 * injected here — that is the seam stack.ts documents — and the loop's own
 * outcome is what these tests pin.
 */
function flakyRemover(failures: number, code = "ENOTEMPTY"): { calls: number; remove: () => void } {
  const state = {
    calls: 0,
    remove: (): void => {
      state.calls += 1;
      if (state.calls <= failures) {
        throw Object.assign(new Error(`${code}: Directory not empty`), { code });
      }
    },
  };
  return state;
}

function scratchTree(): string {
  const target = mkdtempSync(path.join(tmpdir(), "wipe-race-"));
  mkdirSync(path.join(target, "data", "subshells"), { recursive: true });
  writeFileSync(path.join(target, "data", "subshells", "pane.log"), "");
  return target;
}

test("removeScratchTree retries an ENOTEMPTY walk until it takes", async () => {
  const target = scratchTree();
  const remover = flakyRemover(2);
  await removeScratchTree(target, 2_000, remover.remove);
  expect(remover.calls).toBe(3);
});

test("removeScratchTree gives up with the paths that kept appearing", async () => {
  const target = scratchTree();
  const remover = flakyRemover(Number.POSITIVE_INFINITY);
  await expect(removeScratchTree(target, 250, remover.remove)).rejects.toThrow(
    /could not remove .*wipe-race-.*reappeared: data/,
  );
  expect(remover.calls).toBeGreaterThan(1);
});

test("removeScratchTree does not retry any other error", async () => {
  const target = scratchTree();
  const remover = flakyRemover(Number.POSITIVE_INFINITY, "EACCES");
  await expect(removeScratchTree(target, 2_000, remover.remove)).rejects.toThrow(/could not remove .*EACCES/);
  expect(remover.calls).toBe(1);
});
