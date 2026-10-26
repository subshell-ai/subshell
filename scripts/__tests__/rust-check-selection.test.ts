import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(fail = false) {
  const root = mkdtempSync(join(tmpdir(), "subshell-rust-plan-"));
  roots.push(root);
  for (const dir of [
    "scripts",
    "bin",
    "native/display-helper",
    "crates/desktop-core",
    "apps/server/desktop/src-tauri",
    "apps/client/desktop/src-tauri",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL("../rust-check.sh", import.meta.url), join(root, "scripts/rust-check.sh"));
  const executable = (path: string, body: string) => {
    writeFileSync(join(root, path), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, path), 0o755);
  };
  executable("scripts/macos-toolchain-preflight.sh", "exit 0");
  executable("native/display-helper/test.sh", "exit 0");
  executable("bin/rustc", "echo test-host");
  executable("bin/cargo", `printf '%s %s\\n' "$PWD" "$*" >> "$CHECK_LOG"\n${fail ? "exit 9" : "exit 0"}`);
  const log = join(root, "calls");
  return {
    root,
    run: (...args: string[]) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        CHECK_LOG: log,
      };
      delete env.SHELLOPTS;
      delete env.BASHOPTS;
      const result = Bun.spawnSync(["bash", join(root, "scripts/rust-check.sh"), ...args], { env });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      return { result, calls };
    },
  };
}

test("one app runs only its own checks and removes its temporary sidecar", () => {
  const fx = fixture();
  const { result, calls } = fx.run("apps/client/desktop/src-tauri");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(calls.trim().split("\n")).toHaveLength(3);
  expect(calls).toContain("apps/client/desktop/src-tauri fmt --check");
  expect(calls).not.toContain("crates/desktop-core");
  expect(calls).not.toContain("apps/server/desktop");
  expect(existsSync(join(fx.root, "apps/client/desktop/src-tauri/binaries/subshell-node-bundled-test-host"))).toBe(
    false,
  );
});

test("an unfiltered run covers all crates and leaves existing sidecars intact", () => {
  const fx = fixture();
  const dir = join(fx.root, "apps/client/desktop/src-tauri/binaries");
  mkdirSync(dir);
  const sidecar = join(dir, "subshell-node-bundled-test-host");
  writeFileSync(sidecar, "real binary");
  const { result, calls } = fx.run();
  expect(result.exitCode).toBe(0);
  expect(calls.trim().split("\n")).toHaveLength(9);
  expect(readFileSync(sidecar, "utf8")).toBe("real binary");
});

test("failures stop verification, clean stubs, and unknown crates are refused", () => {
  const fx = fixture(true);
  expect(fx.run("apps/server/desktop/src-tauri").result.exitCode).toBe(9);
  expect(existsSync(join(fx.root, "apps/server/desktop/src-tauri/binaries/subshell-server-bundled-test-host"))).toBe(
    false,
  );
  expect(fx.run("misspelled-crate").result.exitCode).toBe(1);
});
