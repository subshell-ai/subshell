import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEPS } from "@/service.js";

/**
 * The production filesystem seam refuses to write a service definition into a
 * real home while a test runner is active.
 *
 * This exists because stubbing the seam in each harness only ever fixes that
 * harness. On 2026-09-15 a CLI suite ran with real deps and wrote a launchd
 * agent into the operator's own `~/Library/LaunchAgents`, which launchd then
 * respawned ten times against the operator's real database. The guard turns the
 * next such mistake into a failed test instead of a running service.
 */
describe("DEFAULT_DEPS write guard under NODE_ENV=test", () => {
  const seed = () => ({
    platform: process.platform,
    home: "/Users/somebody",
    uid: 501,
    servicePath: "/usr/local/bin/subshell-server",
    argv1: "/repo/src/index.ts",
    configDir: "/Users/somebody/.config/subshell-server",
  });

  test("refuses a write outside the OS temp dir, and names the path", () => {
    const deps = DEFAULT_DEPS(seed() as Parameters<typeof DEFAULT_DEPS>[0]);
    const target = "/Users/somebody/Library/LaunchAgents/dev.subshell.server.plist";
    expect(() => deps.writeFile(target, "<plist/>")).toThrow(/refusing to touch the service definition/);
    expect(() => deps.writeFile(target, "<plist/>")).toThrow(/dev\.subshell\.server\.plist/);
  });

  test("refuses a REMOVE outside the temp dir too — an unlink is as destructive as a write", () => {
    const deps = DEFAULT_DEPS(seed() as Parameters<typeof DEFAULT_DEPS>[0]);
    expect(() => deps.removeFile("/Users/somebody/Library/LaunchAgents/dev.subshell.server.plist")).toThrow(
      /refusing to touch the service definition/,
    );
  });

  test("allows a write under the temp dir, which is where a careful test points home", () => {
    const home = mkdtempSync(join(tmpdir(), "subshell-guard-"));
    const deps = DEFAULT_DEPS(seed() as Parameters<typeof DEFAULT_DEPS>[0]);
    const target = join(home, "Library", "LaunchAgents", "dev.subshell.server.plist");
    expect(() => deps.writeFile(target, "<plist/>")).not.toThrow();
    expect(deps.fileExists(target)).toBe(true);
  });
});
