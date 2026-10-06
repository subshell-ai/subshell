import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, NodeCommandBody } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";

/**
 * The two SSH read arms that outlived the destination product (design
 * 2026-10-05 §7), driven through `dispatchCommand` exactly as the daemon
 * drives them (posture copied from commands-archive-create.test.ts: real temp
 * dirs, every answer run through the PROTOCOL validator, refusals asserted by
 * `ok:false` + exact message). The ssh binary is the same recording shim the
 * runtime suite uses — the arms are thin, so these tests pin the THIN things:
 * the names-only discovery answer, the `ssh -G` resolve outcome shape, and
 * the binary-missing failure class the review flow keys on. The run/terminal/
 * test arms retired with the product; their `type` strings no longer parse on
 * the wire, so a test naming one could not even be constructed.
 */

let base: string;
let savedSshPath: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-ssh-")));
  savedSshPath = process.env.SUBSHELL_SSH_PATH;
});

afterAll(() => {
  if (savedSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
  else process.env.SUBSHELL_SSH_PATH = savedSshPath;
  rmSync(base, { recursive: true, force: true });
});

/** Recording shim (mirrors the runtime test helper's shape, baked constants). */
function writeShim(dir: string, opts: { dashG?: string } = {}): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "shim.log");
  const lines = ["#!/bin/sh", `LOG='${log}'`, `printf 'ARGS:%s\\n' "$*" >> "$LOG"`];
  if (opts.dashG !== undefined) {
    lines.push(`for a in "$@"; do if [ "$a" = "-G" ]; then cat <<'GEOF'`);
    lines.push(opts.dashG);
    lines.push("GEOF\nexit 0\nfi; done");
  }
  lines.push("exit 0");
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${lines.join("\n")}\n`, { mode: 0o755 });
  return { bin, log };
}

/** Points the operator override at `sshBin` and seeds a data dir for the arm. */
function setup(tag: string, sshBin: string): { dataDir: string } {
  const dataDir = join(base, tag, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.SUBSHELL_SSH_PATH = sshBin; // the operator override the arm's ladder honors
  return { dataDir };
}

describe("ssh_discover_aliases / ssh_resolve_config arms", () => {
  it("discovery answers through the validator with NAMES only from the account config", async () => {
    const shim = writeShim(join(base, "shim-disc"));
    setup("disc", shim.bin);
    const home = join(base, "disc-home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host alpha\n  HostName a.example\nHost beta\n  User x\n");
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.LOGNAME;
    process.env.HOME = home;
    try {
      const res = await dispatchCommand(
        { config: { dataDir: join(base, "disc", "data") } } as unknown as CommandContext,
        { type: "ssh_discover_aliases" } as NodeCommandBody,
      );
      expect(res.ok).toBe(true);
      const data = (res as { data?: JsonValue }).data as {
        aliases: string[];
        includeCycle: boolean;
        truncated: boolean;
      };
      expect(data.aliases).toEqual(["alpha", "beta"]);
    } finally {
      process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.LOGNAME = savedUserProfile;
    }
  });

  it("resolve runs ssh -G and returns the accepted outcome shape", async () => {
    const gOut = [
      "host resolved.example",
      "hostname resolved.example",
      "user deploy",
      "port 22",
      "userknownhostsfile /home/deploy/.ssh/known_hosts",
    ].join("\n");
    const shim = writeShim(join(base, "shim-res"), { dashG: gOut });
    setup("res", shim.bin);
    const home = join(base, "res-home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host app02\n  HostName resolved.example\n");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = await dispatchCommand(
        { config: { dataDir: join(base, "res", "data") } } as unknown as CommandContext,
        { type: "ssh_resolve_config", alias: "app02" } as NodeCommandBody,
      );
      expect(res.ok).toBe(true);
      const data = (res as { data?: { accepted: boolean; snapshot?: { host?: string } } }).data;
      expect(data?.accepted).toBe(true);
      expect(data?.snapshot?.host).toBe("resolved.example");
    } finally {
      process.env.HOME = savedHome;
    }
  });

  // Rides `ssh_resolve_config` now that the destination product's
  // `ssh_test_connection` arm is retired: resolution is the surviving arm
  // that refuses this way, and the plane's review flow still keys on the
  // binary-missing class.
  it("a missing ssh binary is a command failure with the binary-missing class", async () => {
    const { dataDir } = setup("no-ssh", "/nonexistent/ssh-binary");
    const res = await dispatchCommand(
      { config: { dataDir } } as unknown as CommandContext,
      { type: "ssh_resolve_config", alias: "app02" } as NodeCommandBody,
    );
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("binary missing");
  });
});
