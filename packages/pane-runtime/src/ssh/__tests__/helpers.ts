import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";

/**
 * SSH test fixtures. NOTHING here may touch a developer's `~/.ssh` or the
 * live instance (SSH-SUPPORT.md §6): every config the tests read is a file
 * under a fresh temp dir, every "ssh" the tests run is a shell script this
 * file bakes with absolute paths (the runtime's child env is an allowlist, so
 * a knob delivered by env would be a knob the PRODUCTION child could never
 * see — baked constants are the honest test seam), and the isolated-sshd
 * suite owns its temp HOME end to end.
 */

/** Fresh temp root (realpath'd: macOS `/var` symlink noise breaks prefix asserts). */
export function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** A grammatically valid approved snapshot; override any field. */
export function makeSnapshot(overrides: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "deploy-app02",
    host: "app-02.example.com",
    user: "deploy",
    port: 22,
    identityFiles: [],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: ["/home/deploy/.ssh/known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
    ...overrides,
  };
}

/** A sha256-looking request digest. */
export function makeDigest(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
}

/** Valid plane-shaped run id (hex + hyphen, ≤ 64). */
export function makeRunId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Read every `ARGS:` line a recording shim appended, in order (one joined argv string per spawn). */
export function shimArgs(logPath: string): string[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("ARGS:"))
      .map((l) => l.slice("ARGS:".length));
  } catch {
    return [];
  }
}

/** All recorded lines from a shim log. */
export function shimLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Write the recording ssh shim into `dir/ssh`. Knobs are BAKED CONSTANTS:
 *
 * - `opts.dashG`: when set, an invocation with `-G` anywhere cats this text
 *   and exits 0 (the resolution evaluator's canned answer).
 * - `opts.stdout` / `opts.stdoutFile` / `opts.stderr` / `opts.stderrFile`:
 *   bytes to emit (inline or from a file this function seeds).
 * - `opts.sleep`: seconds to `exec sleep` after emitting (the long-running
 *   run the cancel/deadline paths stop).
 * - `opts.exitCode`: the exit status.
 *
 * The script appends `ARGS:<argv joined>` plus `ENV:` probe lines naming the
 * auth-agent, askpass, DISPLAY, TERM, and the full key list of its
 * environment, and `CFG:<contents of the -F file>` when an `-F` is present.
 * The `-G` branch runs BEFORE the ARGS recording only for -G invocations so
 * resolution tests can assert on the emitted config; every other invocation
 * records first.
 */
export function writeSshShim(
  dir: string,
  opts: {
    dashG?: string;
    stdout?: string;
    stdoutFile?: string;
    stderr?: string;
    stderrFile?: string;
    sleep?: number;
    exitCode?: number;
  } = {},
): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "shim.log");
  const parts: string[] = ["#!/bin/sh"];
  parts.push(`LOG='${log}'`);
  if (opts.stdoutFile) parts.push(`OUTF='${opts.stdoutFile}'`);
  if (opts.stderrFile) parts.push(`ERRF='${opts.stderrFile}'`);
  parts.push(`printf 'ARGS:%s\\n' "$*" >> "$LOG"`);
  parts.push(
    `printf 'ENV:auth=%s ask=%s disp=%s term=%s\\n' "\${SSH_AUTH_SOCK-}" "\${SSH_ASKPASS-}" "\${DISPLAY-}" "\${TERM-}" >> "$LOG"`,
  );
  parts.push(`printf 'ENVKEYS:%s\\n' "$(env | cut -d= -f1 | sort | tr '\\n' ' ')" >> "$LOG"`);
  parts.push(
    `prev=""; for a in "$@"; do if [ "$prev" = "-F" ]; then printf 'CFG:<<\\n'; cat "$a"; printf '>>\\n' >> "$LOG"; fi; prev="$a"; done >> "$LOG" 2>/dev/null`,
  );
  if (opts.dashG !== undefined) {
    parts.push(`for a in "$@"; do if [ "$a" = "-G" ]; then printf 'GARGS:%s\\n' "$*" >> "$LOG"; cat <<'GEOF'`);
    parts.push(opts.dashG);
    parts.push("GEOF\nexit 0\nfi; done");
  }
  if (opts.stdout !== undefined) parts.push(`printf '%s' ${shellSingleQuote(opts.stdout)}`);
  if (opts.stdoutFile) parts.push(`[ -n "\${OUTF-}" ] && cat "$OUTF"`);
  if (opts.stderr !== undefined) parts.push(`printf '%s' ${shellSingleQuote(opts.stderr)} 1>&2`);
  if (opts.stderrFile) parts.push(`[ -n "\${ERRF-}" ] && cat "$ERRF" 1>&2`);
  if (opts.sleep !== undefined) parts.push(`exec sleep ${opts.sleep}`);
  parts.push(`exit ${opts.exitCode ?? 0}`);
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${parts.join("\n")}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log };
}

function shellSingleQuote(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

/** `~`-less POSIX single-quote for fixture config text (paths here are literals). */
export { shellSingleQuote as sq };
