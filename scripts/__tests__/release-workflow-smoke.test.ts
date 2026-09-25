import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The release.yml binary-smoke block is shell that runs on the release
 * runners, and until a cut happens NOTHING else exercises it. Both bugs this
 * file pins were real in the darwin-x64 wave: an ELF-spelled arch hint that
 * would have failed every Intel CLI shard at the magic check, and a
 * backgrounded wrapper that made `kill $pid` miss the booted server. They are
 * extracted from the YAML itself, so the test checks the exact text CI runs,
 * not a copy.
 */
const WORKFLOW = readFileSync(join(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");

/** Canonical `file(1)` output per triple, measured, not imagined:
 *  - the two Mach-O lines: /usr/bin/file on Darwin 25 (the macos runner's
 *    binary family), the x86_64 one run against a real cross-built sidecar
 *    (target/x86_64-apple-darwin/release/subshell-server-bundled);
 *  - the two ELF lines: the GNU file(1) spellings the linux shards' current
 *    hints pass against in CI. */
const FILE_OUTPUT: Record<string, string> = {
  "linux-x64":
    "ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, not stripped",
  "linux-arm64":
    "ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, for GNU/Linux 3.7.0, not stripped",
  "darwin-arm64": "Mach-O 64-bit executable arm64",
  "darwin-x64": "Mach-O 64-bit executable x86_64",
};

function hintTable(): Map<string, string> {
  // release.yml carries three `case "$TRIPLE"` blocks; the HINT table is the
  // one whose body assigns HINT.
  const bodies = [...WORKFLOW.matchAll(/case "\$TRIPLE" in\n([\s\S]*?)\n\s*esac/g)].map((m) => m[1]);
  const block = bodies.find((body) => body.includes("HINT="));
  if (block === undefined) throw new Error("release.yml: the HINT case block was not found (renamed?)");
  const hints = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(\S+)\)\s+HINT='([^']+)'/gm)) {
    hints.set(m[1], m[2]);
  }
  return hints;
}

describe("release.yml file(1) arch hints", () => {
  test("every triple has a hint", () => {
    const hints = hintTable();
    expect([...hints.keys()].sort()).toEqual(Object.keys(FILE_OUTPUT).sort());
  });

  test("each hint matches its own triple's file(1) line", () => {
    for (const [triple, hint] of hintTable()) {
      expect(new RegExp(hint).test(FILE_OUTPUT[triple])).toBe(true);
    }
  });

  test("no hint matches another triple's line (the hint proves the arch)", () => {
    for (const [hintTriple, hint] of hintTable()) {
      for (const [lineTriple, line] of Object.entries(FILE_OUTPUT)) {
        if (lineTriple === hintTriple) continue;
        expect({ hintTriple, lineTriple, match: new RegExp(hint).test(line) }).toEqual({
          hintTriple,
          lineTriple,
          match: false,
        });
      }
    }
  });
});

/** The run_target function, verbatim from the YAML block scalar. */
function runTargetFunction(): string {
  const m = /^ {10}run_target\(\) \{([\s\S]*?)\n {10}\}/m.exec(WORKFLOW);
  if (m === null) throw new Error("release.yml: the run_target function was not found (renamed?)");
  return `run_target() {${m[1]}\n}`;
}

describe("release.yml run_target", () => {
  // The boot smoke backgrounds this function and later `kill`s "$!". A
  // backgrounded shell function forks a wrapper subshell that bash does NOT
  // exec-replace through its function frame, so unless run_target itself
  // execs, $! is the wrapper: the kill and the EXIT trap fire at a /bin/bash
  // pid while the release binary keeps running (measured on /bin/bash 3.2,
  // the macOS runners' shell). This spawns the REAL extracted text under
  // /bin/bash and asks what $! actually became.
  test("backgrounded, $! is the target command itself (kill reaches the binary)", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-target-"));
    try {
      const script = join(dir, "probe.sh");
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          'EXEC_PREFIX=""',
          runTargetFunction(),
          // stdout/stderr detached so an UNREACHABLE pid (the pre-fix shape:
          // kill hits the wrapper, the real sleep survives) cannot hold the
          // captured pipe open and stall this probe rather than fail it.
          "run_target sleep 2 >/dev/null 2>&1 &",
          "pid=$!",
          'comm=$(ps -p "$pid" -o comm= 2>/dev/null || echo GONE)',
          'kill "$pid" 2>/dev/null || true',
          'wait "$pid" 2>/dev/null || true',
          'echo "BG=$comm"',
          // The synchronous capture path (out=$(run_target ... version)) must
          // keep working whatever the background fix looks like.
          "out=$(run_target echo probe-ok 2>&1) || out=FAILED",
          'echo "CS=$out"',
          "",
        ].join("\n"),
      );
      const proc = Bun.spawnSync({ cmd: ["/bin/bash", script] });
      const stdout = new TextDecoder().decode(proc.stdout);
      expect(stdout).toContain("BG=sleep");
      expect(stdout).toContain("CS=probe-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
