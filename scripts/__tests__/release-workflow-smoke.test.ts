import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The release.yml binary-smoke block is shell that runs on the release
 * runners, and until a cut happens NOTHING else exercises it. Both bugs this
 * file pins were real in the darwin-x64 wave: an ELF-spelled arch hint that
 * would have failed every Intel CLI shard at the file(1) gate (which every
 * smoke mode passes through, exec included), and a backgrounded wrapper that
 * made `kill $pid` miss the booted server. They are
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

/** The plan job's smoke-mode table, verbatim from the YAML block scalar.
 * Matched by CONTENT (like hintTable's HINT= trick): release.yml carries
 * another `case "$triple"` block for the runner mapping, and a bare
 * first-match regex finds THAT one, silently testing the wrong table. */
function smokeTable(): string {
  const bodies = [...WORKFLOW.matchAll(/case "\$triple" in\n([\s\S]*?)\n\s*esac/g)].map((m) => m[1]);
  const table = bodies.find((b) => b.includes('smoke="'));
  if (table === undefined) throw new Error("release.yml: the smoke-mode case block was not found (renamed?)");
  return table;
}

/** The plan job's runner table (the other `case "$triple"` block). */
function runnerTable(): string {
  const bodies = [...WORKFLOW.matchAll(/case "\$triple" in\n([\s\S]*?)\n\s*esac/g)].map((m) => m[1]);
  const table = bodies.find((b) => b.includes('runner="'));
  if (table === undefined) throw new Error("release.yml: the runner case block was not found (renamed?)");
  return table;
}

describe("release.yml darwin-x64 venue (settled by run 36196527394 + the hosted-runner docs)", () => {
  test("the Intel shards build and exec-smoke on Intel hardware, not translated", () => {
    // The Apple Silicon runner's Rosetta tops out at SSE4.2 while bun's
    // x86_64 build needs AVX2 (its own crash banner proved both halves).
    // GitHub's hosted fleet has Intel macOS labels again (macos-15-intel);
    // on that host every darwin-x64 smoke claim is native, so exec mode is
    // honest again rather than a guaranteed SIGILL.
    expect(runnerTable()).toMatch(/darwin-x64\)\s*runner="\$MAC_INTEL"/);
    expect(WORKFLOW).toMatch(/MAC_INTEL='"macos-15-intel"'/);
    expect(smokeTable()).toMatch(/darwin-x64/);
    expect(smokeTable()).toMatch(/darwin-x64[^)]*\)\s*smoke="exec"/);
    expect(smokeTable()).not.toContain('smoke="rosetta"');
    expect(smokeTable()).toContain('linux-arm64) smoke="magic"');
  });

  test("the Smoke step carries no exec-prefix machinery of any kind", () => {
    const body = smokeStepBody();
    for (const dead of ["EXEC_PREFIX", "run_target", "install-rosetta", "arch -x86_64", "rosetta"]) {
      expect({ dead, present: body.includes(dead) }).toEqual({ dead, present: false });
    }
  });

  test("a failed version exec still surfaces its output (the never-silent rule stands)", () => {
    const body = smokeStepBody();
    const line = body.split("\n").find((l) => l.includes('out=$("$BIN" version 2>&1)'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/\|\|\s*\{\s*echo/);
    expect(line).toContain("$out");
  });

  test("boot smoke backgrounds the binary directly, so $! is the process kill aims at", () => {
    // The shape `VAR=val cmd ... >log 2>&1 &` is a simple command: bash
    // execs it IN the forked child, so $! is the command itself. A helper
    // function wrapper once broke exactly that (a backgrounded FUNCTION
    // keeps its wrapper); the direct shape is what boot_smoke must keep,
    // and the mechanism is verified behaviorally under /bin/bash here.
    const body = smokeStepBody();
    // Line-start match: the launch line must BE the direct background, not a
    // wrapper call that happens to contain the path.
    expect(body).toMatch(/\n\s*"\$PWD\/\$BIN" >server-boot\.log 2>&1 &/);
    const dir = mkdtempSync(join(tmpdir(), "boot-bg-"));
    try {
      const script = join(dir, "probe.sh");
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "FOO=1 /bin/sleep 2 >/dev/null 2>&1 &",
          "pid=$!",
          'comm=$(ps -p "$pid" -o comm= 2>/dev/null || echo GONE)',
          'kill "$pid" 2>/dev/null || true',
          'wait "$pid" 2>/dev/null || true',
          'echo "BG=$comm"',
          "",
        ].join("\n"),
      );
      const proc = Bun.spawnSync({ cmd: ["/bin/bash", script] });
      const stdout = new TextDecoder().decode(proc.stdout);
      // comm is the command (or its path), never a bash wrapper.
      expect(stdout).toMatch(/BG=.*sleep/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the cargo cache cannot hand one Mac arch the other's host-tooling tree", () => {
    // The key already carried runner.os, but runner.os is "macOS" on BOTH
    // hosted labels. With --target, cargo keeps host-arch build scripts and
    // proc-macro dylibs in the unqualified target/release/, so a key shared
    // across architectures lets an Intel shard restore an arm64 host's tree
    // and die executing binaries it cannot run. runner.arch (ARM64 vs
    // X86_64) is what splits it; both key and restore-keys must carry it,
    // or a prefix restore re-crosses the line the full key just drew.
    expect(WORKFLOW).toMatch(
      /key: \$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-cargo-release-v2-\$\{\{ matrix\.app \}\}-/,
    );
    expect(WORKFLOW).toMatch(/restore-keys: \$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-cargo-release-v2-/);
  });

  test("the desktop bundle smoke execs its sidecar: same-arch hardware makes it native", () => {
    // With the x64 bundle built and smoked on Intel hardware, the run check
    // is unconditional again (an arm64 sidecar never lands on an Intel
    // runner, and vice versa: each triple has exactly one runner and its
    // runner IS its arch).
    const desktop = readFileSync(join(import.meta.dir, "../../scripts/smoke-desktop-bundle.sh"), "utf8");
    expect(desktop).toMatch(/^check_sidecar_runs "\$APP_BUNDLE/m);
  });
});

/** The Smoke step's script body, from the env line that hands it the smoke
 * mode to the magic-mode echo that closes it. Both anchors are unique. */
function smokeStepBody(): string {
  const start = WORKFLOW.indexOf("SMOKE: ${{ matrix.smoke }}");
  const end = WORKFLOW.indexOf("no exec smoke (digest sidecar");
  if (start < 0 || end < 0) throw new Error("release.yml: the Smoke step body was not found (reworded?)");
  return WORKFLOW.slice(start, end);
}
