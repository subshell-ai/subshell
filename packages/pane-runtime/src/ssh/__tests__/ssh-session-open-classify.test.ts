import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_RUNTIME_SERVE_IN_USE_EXIT, type SshSessionTargetWire } from "@internal/subshell-protocol";
import type { SshSessionHooks } from "../ssh-session-open.js";
import { getSshSessionSupervisor, resetSshSessionSupervisorsForTests } from "../ssh-session-supervisor.js";

/**
 * The pre-hello death classification (review m2), with a fake ssh (the
 * recording shim pattern this dir's helpers established): the open reads the
 * child's exit POSTURE when the hello never arrived, and the posture must map
 * to the remedy the human can act on.
 *
 * - **A door bind refused exits {@link SSH_RUNTIME_SERVE_IN_USE_EXIT}**: the
 *   destination already carries a live session, and the serve now says so with
 *   its own exit code instead of dying as a generic throw. Before the fix it
 *   landed in the default arm and read "the binary is missing" on a machine
 *   whose binary is running the first session RIGHT NOW.
 * - **The frozen arms stay frozen**: 127 (login-shell PATH drift past the
 *   probe) and the default arm stay `runtime_missing`; 255/null stays the
 *   transport verdict. The new branch is inserted, not substituted.
 */

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * A fake ssh whose serve invocation prints NOTHING on stdout and exits with
 * `serveExit` (the pre-hello death the classifier reads). The probe still
 * succeeds: the child only dies after it exists.
 */
function writeFakeSsh(dir: string, serveExit: number): string {
  const script = [
    "#!/bin/sh",
    `case "$*" in`,
    `  *"command -v"*) printf '/usr/bin/subshell\\n'; exit 0 ;;`,
    `esac`,
    `case "$*" in`,
    `  *"runtime-serve"*) exit ${serveExit} ;;`,
    `esac`,
    `exit 1`,
  ].join("\n");
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${script}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

const target: SshSessionTargetWire = { alias: "cls", host: "127.0.0.1", port: 22, user: null, identityFile: null };

const hooks: SshSessionHooks = { emitBytes: async () => {}, emitDiag: () => {}, onLost: () => {} };

async function refused(serveExit: number): Promise<string> {
  const root = tempRoot(`cls-${serveExit}-`);
  const sup = getSshSessionSupervisor({
    dataDir: join(root, "nodedata"),
    homeDir: join(root, "home"),
    sshBin: writeFakeSsh(root, serveExit),
    nowMs: Date.now,
  });
  const out = await sup.open({ ref: crypto.randomUUID(), target, runtimeCommand: "subshell" }, hooks);
  if (out.kind !== "refused") throw new Error(`expected a refusal, got ${out.kind}`);
  return out.code;
}

afterAll(() => {
  resetSshSessionSupervisorsForTests();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("pre-hello death classification", () => {
  test("the serve's own bind-refusal exit names session_in_use, never runtime_missing (m2)", async () => {
    const code = await refused(SSH_RUNTIME_SERVE_IN_USE_EXIT);
    expect(code).toBe("session_in_use"); // the remedy is the OTHER session
    expect(code).not.toBe("runtime_missing"); // the binary demonstrably exists
  });

  test("the frozen arms stay: 127 and the default read runtime_missing, 255 reads the transport", async () => {
    expect(await refused(127)).toBe("runtime_missing"); // PATH drift past the probe, honest either way
    expect(await refused(1)).toBe("runtime_missing"); // the generic-throw default arm, unchanged
    expect(await refused(255)).toBe("connection_failed"); // ssh's own failure, unclassified
  });
});
