import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEPS } from "../service.js";

/**
 * The production filesystem seam refuses to write a service definition into a
 * real home while a test runner is active.
 *
 * The server half of this CLI met the failure first: on 2026-09-15 a suite ran
 * with real deps and wrote a launchd agent into the operator's own
 * `~/Library/LaunchAgents`, which launchd respawned ten times against a real
 * database. The agent has the same shape and the same exposure, so it carries
 * the guard before it earns its own incident.
 */
describe("DEFAULT_DEPS write guard under NODE_ENV=test", () => {
  const deps = () => DEFAULT_DEPS(async () => true);

  test("refuses a write outside the OS temp dir, naming the path", async () => {
    const target = "/Users/somebody/Library/LaunchAgents/dev.subshell.client.plist";
    await expect(deps().writeFile(target, "<plist/>")).rejects.toThrow(/refusing to touch the service definition/);
  });

  test("refuses a REMOVE outside the temp dir — an unlink is as destructive as a write", async () => {
    await expect(deps().removeFile("/Users/somebody/.config/systemd/user/subshell.service")).rejects.toThrow(
      /refusing to touch the service definition/,
    );
  });

  test("allows a write under the temp dir, where a careful test points home", async () => {
    const home = mkdtempSync(join(tmpdir(), "subshell-node-guard-"));
    const target = join(home, ".config", "systemd", "user", "subshell.service");
    await deps().writeFile(target, "[Unit]\n");
    expect(await deps().fileExists(target)).toBe(true);
  });
});
