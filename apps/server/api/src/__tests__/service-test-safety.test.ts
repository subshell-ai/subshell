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

/**
 * The write guard alone was not enough, which is the whole reason this second
 * one exists: `uninstallService` runs `systemctl --user disable --now` — and on
 * darwin `launchctl bootout` — BEFORE it removes the definition. On the real
 * deps a test would therefore stop and disable the operator's own live server
 * and only then be refused at the write. Found in review, 2026-09-15.
 */
describe("DEFAULT_DEPS manager-command guard under NODE_ENV=test", () => {
  const deps = () =>
    DEFAULT_DEPS({
      platform: process.platform,
      home: "/Users/somebody",
      uid: 501,
      servicePath: "/usr/local/bin/subshell-server",
      argv1: "/repo/src/index.ts",
      configDir: "/Users/somebody/.config/subshell-server",
    } as Parameters<typeof DEFAULT_DEPS>[0]);

  test("refuses the exact command uninstall runs before it reaches the write guard", () => {
    expect(() => deps().runCmd(["systemctl", "--user", "disable", "--now", "subshell-server.service"])).toThrow(
      /refusing to run/,
    );
  });

  test("refuses launchctl bootout, which stops a running server on darwin", () => {
    expect(() => deps().runCmd(["launchctl", "bootout", "gui/501/dev.subshell.server"])).toThrow(/refusing to run/);
  });

  test.each([
    ["systemctl", ["systemctl", "--user", "enable", "--now", "subshell-server.service"]],
    ["daemon-reload", ["systemctl", "--user", "daemon-reload"]],
    ["start", ["systemctl", "--user", "start", "subshell-server.service"]],
    ["kickstart", ["launchctl", "kickstart", "-k", "gui/501/dev.subshell.server"]],
    ["bootstrap", ["launchctl", "bootstrap", "gui/501", "/tmp/x.plist"]],
  ])("refuses %s", (_label, cmd) => {
    expect(() => deps().runCmd(cmd as string[])).toThrow(/refusing to run/);
  });

  test("ALLOWS read-only probes — the allowlist must not break queryService", () => {
    // These actually spawn. They may fail (no systemctl on macOS) but must not
    // be REFUSED — a guard that blocked them would break every status path.
    for (const cmd of [
      ["systemctl", "--user", "is-system-running"],
      ["systemctl", "--user", "show", "subshell-server.service", "-p", "KillMode"],
      ["launchctl", "print", "gui/501/dev.subshell.server"],
    ]) {
      expect(() => deps().runCmd(cmd)).not.toThrow();
    }
  });

  test("ignores commands that are not the service manager", () => {
    // `plutil`, the loginctl linger probe and the spawn-guard suite's own
    // arbitrary commands must pass through untouched.
    expect(() => deps().runCmd(["/bin/sh", "-c", "exit 0"])).not.toThrow();
    expect(() =>
      deps().runCmd(["plutil", "-extract", "AbandonProcessGroup", "raw", "-o", "-", "/tmp/x.plist"]),
    ).not.toThrow();
  });
});
