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

/**
 * The write guard alone was not enough: `uninstallService` runs `systemctl
 * --user disable --now` — and on darwin `launchctl bootout` — BEFORE removing
 * the definition, so a test on the real deps would stop this machine's own
 * agent, and every pane it supervises, before ever meeting the write guard.
 * Found in review, 2026-09-15.
 */
describe("DEFAULT_DEPS manager-command guard under NODE_ENV=test", () => {
  const deps = () => DEFAULT_DEPS(async () => true);

  test("refuses the exact command uninstall runs before it reaches the write guard", async () => {
    await expect(deps().runCmd(["systemctl", "--user", "disable", "--now", "subshell.service"])).rejects.toThrow(
      /refusing to run/,
    );
  });

  test("refuses launchctl bootout, which stops a running agent on darwin", async () => {
    await expect(deps().runCmd(["launchctl", "bootout", "gui/501/dev.subshell.client"])).rejects.toThrow(
      /refusing to run/,
    );
  });

  test("refuses enable --now, which install runs", async () => {
    await expect(deps().runCmd(["systemctl", "--user", "enable", "--now", "subshell.service"])).rejects.toThrow(
      /refusing to run/,
    );
  });

  test("ALLOWS read-only probes and non-manager commands", async () => {
    // A guard that blocked these would break queryService and the spawn-guard
    // suite. They may FAIL (no systemctl here) but must not be refused.
    await expect(deps().runCmd(["launchctl", "print", "gui/501/dev.subshell.client"])).resolves.toBeDefined();
    await expect(deps().runCmd(["/bin/sh", "-c", "exit 0"])).resolves.toEqual({ code: 0, out: "", err: "" });
  });
});
