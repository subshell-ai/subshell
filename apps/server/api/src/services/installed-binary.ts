/**
 * Which file on this host IS the installed `subshell-server` (spec 2026-09-15
 * §4.2).
 *
 * Nothing in TypeScript knew this before: only the desktop app's Rust read a
 * service definition (`apps/server/desktop/src-tauri/src/server_bin.rs`), and
 * that is exactly the knowledge an `update` needs — because the one thing an
 * update must never do is write a path the service does not run. Writing
 * `~/.local/bin/subshell-server` by convention would be a file nobody executes
 * and an update that reports success and changes nothing; the desktop app
 * learned that once already (`Probe::decide` compares against the MANAGED copy
 * only).
 *
 * So the two readers in `server_bin.rs` are PORTED here rather than
 * reimplemented — the systemd `ExecStart=` unquoting, and the launchd
 * `ProgramArguments` read through `plutil` with the XML regex only as the
 * no-plutil fallback. The trap that code names is carried across too: a
 * dev-form install records TWO tokens (`[interpreter, script]`), and a reader
 * that keeps only the first would hand the updater a copy of `bun`.
 *
 * Everything here is SYNCHRONOUS, because `status` (`commands/status.ts`) is
 * one of its two callers and the CLI's sync-exit convention forbids a
 * suspension there.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { serviceArtifactPath } from "@/service.js";
import { appSupervised } from "@/services/server-deployment.js";

/** Where an installed binary came from, and what can be done about it. */
export type InstalledBinary =
  /** One executable file. The only shape `update` can replace. */
  | { kind: "compiled"; path: string; source: InstalledBinarySource }
  /** An interpreter plus a script — a checkout. `update` refuses and says to use git. */
  | { kind: "source"; argv: string[]; source: InstalledBinarySource; reason: string }
  /** Nothing here names a binary. `update` refuses with this reason. */
  | { kind: "unknown"; reason: string };

/** Which rung answered. Reported so a person can tell "the unit says so" from "this is me". */
export type InstalledBinarySource = "service definition" | "app supervisor" | "this process";

/** Injectable seams, so the rungs are testable without a real unit, plist or process identity. */
export interface InstalledBinaryDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** The server config home — on darwin a `--no-autostart` plist lives THERE, not in LaunchAgents. */
  configDir: string;
  /** This process's executable (default: `process.execPath`). */
  execPath?: string;
  /** Environment, for the app-supervisor claim (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** This process's parent pid, which the claim is checked against (default: `process.ppid`). */
  ppid?: number;
  /** Read a file's text, or null (default: `readFileSync`). */
  readFile?: (path: string) => string | null;
  /** Whether a path exists (default: `existsSync`). */
  fileExists?: (path: string) => boolean;
  /** Run a command synchronously — only `plutil` (default: `Bun.spawnSync`). */
  runCmd?: (cmd: string[]) => { code: number; out: string; err: string };
}

const defaultRead = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultRun = (cmd: string[]): { code: number; out: string; err: string } => {
  try {
    const res = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe", timeout: 5000, env: process.env });
    return { code: res.exitCode ?? 1, out: res.stdout.toString(), err: res.stderr.toString() };
  } catch {
    return { code: 1, out: "", err: "could not run the command" };
  }
};

/**
 * Unpick one systemd `ExecStart=` value into argv.
 *
 * systemd word-splits the line ITSELF (it is not run through a shell), and
 * `service.ts`'s `systemdQuote` double-quotes any token containing whitespace,
 * `"` or `\`. This is that function's inverse, ported verbatim from
 * `parse_systemd_exec` in `server_bin.rs` — the two must agree, because a
 * macOS "Application Support" home or a spaced config dir is the case that
 * produces a quoted token at all.
 */
export function parseSystemdExec(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let escaped = false;
  let started = false;
  for (const ch of line) {
    if (escaped) {
      cur += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (/\s/.test(ch) && !inQuotes) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * The argv the installed service definition names, or null when there is none.
 *
 * systemd: the LAST `ExecStart=` line, which is systemd's own last-wins rule.
 * launchd: `ProgramArguments`, read through `plutil` because the plist may
 * legally be binary1 — a text predicate answers confidently and wrongly there.
 * The XML regex survives only as the no-plutil fallback, which is the same
 * arrangement `service.ts`'s `abandonProcessGroup` uses.
 */
export function serviceExecArgv(deps: InstalledBinaryDeps): string[] | null {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exists = deps.fileExists ?? ((p: string) => existsSync(p));
  const read = deps.readFile ?? defaultRead;
  const path = serviceArtifactPath(platform, home, deps.configDir, exists);
  if (path === null || !exists(path)) return null;

  if (platform === "linux") {
    const text = read(path);
    if (text === null) return null;
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("ExecStart="));
    const last = lines.at(-1);
    if (last === undefined) return null;
    const argv = parseSystemdExec(last.slice("ExecStart=".length));
    return argv.length > 0 ? argv : null;
  }

  if (platform !== "darwin") return null;
  const run = deps.runCmd ?? defaultRun;
  const res = run(["/usr/bin/plutil", "-extract", "ProgramArguments", "json", "-o", "-", path]);
  if (res.code === 0) {
    try {
      const parsed: unknown = JSON.parse(res.out.trim());
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string") && parsed.length > 0) {
        return parsed as string[];
      }
    } catch {
      // Fall through to the text reader below.
    }
  }
  // No plutil (the fallback `service.ts` also keeps), or output we could not
  // parse. An XML plist is what this repo writes, so the regex covers the
  // ordinary case; a binary plist with no plutil simply has no answer.
  const text = read(path);
  if (text === null) return null;
  const block = text.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (block === null) return null;
  const argv = [...(block[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
  return argv.length > 0 ? argv : null;
}

/** True when `path` is inside bun's compiled-binary virtual filesystem. */
const inBunfs = (path: string): boolean => path.startsWith("/$bunfs/") || path.includes("/$bunfs/");

/**
 * Where the installed `subshell-server` is, by the ladder in spec §4.2.
 *
 * The order is not a preference, it is a series of decreasing certainties:
 *
 * 1. **The service definition**, when one is installed. That file NAMES the
 *    binary the manager will execute, so it is the only rung that answers the
 *    question `update` is actually asking.
 * 2. **App-supervised** (`SUBSHELL_SUPERVISOR*` verified against this
 *    process's real parent): Subshell Server launched this very file from its
 *    own ladder, so `process.execPath` is what a restart would run again.
 * 3. **This process**, when it is an installed-looking compiled binary — a
 *    hand-run `~/.local/bin/subshell-server`, which is a real deployment.
 * 4. Otherwise `unknown`, with the reason.
 *
 * `bun src/index.ts` from a checkout hits neither 3 (the execPath is `bun`)
 * nor 2, so it lands on `unknown` — which is right: there is nothing here an
 * update could replace.
 */
export function resolveInstalledBinary(deps: InstalledBinaryDeps): InstalledBinary {
  const argv = serviceExecArgv(deps);
  if (argv !== null) {
    // TWO tokens is the dev-form install `execLine()` writes: an interpreter
    // plus a resolved script path. Replacing the first would overwrite `bun`.
    if (argv.length > 1) {
      return {
        kind: "source",
        argv,
        source: "service definition",
        reason: "this server runs from a checkout; update it with git",
      };
    }
    return { kind: "compiled", path: argv[0] as string, source: "service definition" };
  }

  const execPath = deps.execPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const ppid = deps.ppid ?? process.ppid;
  if (appSupervised(env, ppid)) {
    return { kind: "compiled", path: execPath, source: "app supervisor" };
  }

  if (basename(execPath).startsWith("subshell-server") && !inBunfs(execPath)) {
    return { kind: "compiled", path: execPath, source: "this process" };
  }

  return {
    kind: "unknown",
    reason: "no service definition names a binary and this process is not an installed one",
  };
}

/**
 * Whether an `update` could actually replace this binary, and why not.
 *
 * The swap is `rename(binary → binary.previous)` then
 * `rename(temp → binary)`, so what has to be writable is the DIRECTORY, not
 * the file — a 0555 binary in a writable directory is replaceable, and a 0755
 * binary in `/usr/bin` is not. Both renames are in one directory so the swap
 * stays atomic and never crosses a filesystem.
 */
export function binaryIsReplaceable(path: string): { ok: true } | { ok: false; reason: string } {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, reason: `${path} is not there` };
  }
  if (!st.isFile()) return { ok: false, reason: `${path} is not a regular file` };
  const dir = dirname(path);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return { ok: false, reason: `${dir} is not writable by this user` };
  }
  return { ok: true };
}
