#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This driver runs outside Turbo. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./ci-test-plan";

/**
 * Browser specs that boot their own backend, container or sshd. They depend
 * only on the admin state spec 01 creates, so CI can run them in a second
 * shard while the rest of the suite keeps its original order in the first.
 * Keep this list in step with renames: an unlisted heavy spec silently moves
 * to shard 1 and unbalances the split (coverage is unaffected).
 */
export const FIXTURE_HEAVY: Record<string, true> = {
  "tests/12-nodes.spec.ts": true,
  "tests/14-registry-install.spec.ts": true,
  "tests/22-ssh-terminal.spec.ts": true,
  "tests/23-connect-flow.spec.ts": true,
  "tests/23-ssh-relay.spec.ts": true,
  "tests/24-ssh-ux.spec.ts": true,
  "tests/25-browser-ssh-key.spec.ts": true,
  "tests/26-ssh-forwarding.spec.ts": true,
  "tests/27-ssh-security.spec.ts": true,
};

export const E2E_SHARDS = 2;
/** Both shards boot their own stack, so each needs the pristine-stack and admin specs. */
export const SETUP_SPECS: readonly string[] = ["tests/00-smoke.spec.ts", "tests/01-setup-wizard.spec.ts"];

export function allSpecs(root = ROOT): string[] {
  return readdirSync(join(root, "e2e", "tests"))
    .filter((name) => name.endsWith(".spec.ts"))
    .sort()
    .map((name) => `tests/${name}`);
}

/**
 * The files one browser shard runs. A full run means `selected` is empty and
 * every spec is partitioned; a PR's selected files are split the same way,
 * and a shard with no selected file skips Playwright entirely. The one
 * exception is a selection made only of setup specs: shard 1 runs them so a
 * change to the wizard itself is never skipped.
 */
export function e2eShardFiles(selected: readonly string[], index: number, root = ROOT): string[] {
  if (index < 1 || index > E2E_SHARDS) throw new Error(`shard ${index}/${E2E_SHARDS} is out of range`);
  const files = (selected.length ? [...selected] : allSpecs(root)).filter((f) => !SETUP_SPECS.includes(f));
  const assigned = files.filter((f) => (index === E2E_SHARDS ? FIXTURE_HEAVY[f] === true : FIXTURE_HEAVY[f] !== true));
  if (assigned.length === 0) return files.length === 0 && index === 1 ? [...SETUP_SPECS] : [];
  return [...SETUP_SPECS, ...assigned];
}
