import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "macos-toolchain-preflight.sh");

/**
 * Run the preflight with a fake `cc` first on PATH.
 *
 * The probe compiles an empty translation unit, so a shim that prints the
 * output we want and exits non-zero reproduces a broken toolchain exactly,
 * without needing a machine that actually has one.
 */
function runWithFakeCc(body: string): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-shim-"));
  try {
    const shim = join(dir, "cc");
    writeFileSync(shim, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(shim, 0o755);
    const res = Bun.spawnSync([SCRIPT], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: res.exitCode ?? -1, err: res.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The preflight every local Rust command runs first.
 *
 * It exists because an unaccepted Xcode licence makes `cc` unable to link, and
 * cargo surfaces that as a `note:` ~100 lines above an error naming a SOURCE
 * FILE — so a machine that cannot link anything reads as one broken doctest in
 * a file somebody just edited. Measured on 2026-09-15.
 *
 * SKIPPED off darwin, and that is not a convenience: the script's first act is
 * to exit 0 on any other platform, so on CI's ubuntu runners every assertion
 * below would either pass vacuously or fail for the wrong reason. `test:scripts`
 * runs there (test.yml), so an unguarded suite here is a red build that says
 * nothing about the behaviour it names.
 */
describe.skipIf(process.platform !== "darwin")("macos-toolchain-preflight", () => {
  test("says nothing and exits 0 when cc can link", () => {
    const { code, err } = runWithFakeCc("exit 0");
    expect(code).toBe(0);
    expect(err).toBe("");
  });

  test("names `sudo xcodebuild -license` when the failure is the licence", () => {
    const { code, err } = runWithFakeCc(
      "echo \"note: You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'\" >&2; exit 69",
    );
    expect(code).toBe(1);
    expect(err).toContain("sudo xcodebuild -license");
    // The other way out is real and cheaper: the Command Line Tools toolchain
    // is not behind the licence gate, and it is what unblocked this machine.
    expect(err).toContain("DEVELOPER_DIR=/Library/Developer/CommandLineTools");
  });

  test("does NOT blame the licence for an unrelated link failure", () => {
    const { code, err } = runWithFakeCc("echo \"ld: library 'System' not found\" >&2; exit 1");
    expect(code).toBe(1);
    // Advice for the wrong problem is worse than none: the real error has to
    // survive, and the licence remedy must not be offered for it.
    expect(err).toContain("ld: library 'System' not found");
    expect(err).not.toContain("sudo xcodebuild -license");
  });
});
