/**
 * `bun run dev:desktop-server` / `bun run dev:desktop-client` — launch a Tauri
 * desktop app in dev mode from the repo root, against a CLI built from the
 * working tree.
 *
 * **Why this is not a two-line proxy to `bun run --cwd <app> dev:app`.**
 * `tauri-build` refuses to build when an `externalBin` path is missing, and
 * `src-tauri/binaries/*` is a gitignored ~110 MB build input. So on a clean
 * checkout a bare `tauri dev` dies inside a build script with
 * `resource path … doesn't exist`, naming a file the reader has never heard of
 * and no way to produce it. Staging it by hand is a four-command dance
 * documented in `apps/server/desktop/AGENTS.md`. This script is that dance.
 *
 * Each app already knows how to build and stage the CLI it wraps — that is its
 * release pipeline's `stageSidecar`, which is what a release uses and what the
 * bundle smoke proves. This imports the SAME function rather than reimplementing
 * it, so a dev sidecar and a released one can never be produced two different
 * ways.
 *
 * **The staged sidecar is not what the app runs, and that is the whole reason
 * the second half of this script exists.** Both apps resolve their CLI through
 * a ladder (`server_bin.rs`, `node_bin.rs`): an env override, a configured
 * path, the service definition, then the MANAGED COPY at `~/.local/bin/…`. The
 * sidecar appears on no rung — it is only a source to install FROM, and the
 * app installs it only when its version is newer. In dev both carry the same
 * version, so a freshly built sidecar is never adopted, and the app keeps
 * running whatever was installed weeks ago.
 *
 * That cost a real afternoon on 2026-09-11: a fix to `service uninstall`
 * landed seven minutes after the installed binary was compiled, the desktop
 * reset kept failing with the exact error the fix removes, and the fix looked
 * wrong. So this script also refreshes the managed copy when its bytes differ
 * from the sidecar it just staged — the app's own `already_installed` check
 * cannot: it compares SIZE and VERSION, and a same-version rebuild matches
 * both.
 *
 * **A stub does not count.** `bun run rust:check` stages a zero-byte file (all
 * `tauri-build` checks is existence, and no Rust test executes the sidecar) and
 * removes only the stubs it created — but a crashed run can leave one behind. A
 * stub satisfies the build and then fails at RUNTIME: the server app runs
 * `<sidecar> version` to decide what it ships, gets nothing, and shows "this
 * build ships no server binary" on the very first-run screen a developer is
 * usually here to look at. So an empty file is treated as absent.
 *
 * **The installed service owns :3080 in normal operation, and that is the one
 * thing this launch cannot coexist with** (operator ruling 2026-09-21). The
 * server app runs the freshly built CLI as its child, and the child binds
 * SERVER_PORT (3080) — which the installed `subshell-server` service already
 * holds. The child cannot bind, the dashboard window keeps talking to the
 * installed build through the SPA dev proxy, and the developer debugs a brand-
 * new client against a server that is weeks old. So before anything is staged
 * the launcher asks who owns the port: the service is offered a stop (the CLI
 * verb, never a kill — the manager would respawn one), a decline or a
 * non-interactive run aborts with the remedies named, and a holder that is NOT
 * the service is never touched.
 *
 * **The CLIENT app has the same shadowing hazard with a different shape, and a
 * softer verdict.** `refreshManagedCopy` swaps `~/.local/bin/subshell` by
 * digest, but a RUNNING node daemon keeps the OLD binary in memory — an atomic
 * rename replaces the file, not the process. So a fresh dev launch of the
 * client still exercises the stale daemon until something restarts it. The
 * preflight asks the node CLI what its manager reports, and offers
 * `subshell service stop` for a running service (again the CLI verb, never a
 * kill — KeepAlive respawns one, and `service stop`'s own pane-safety handling
 * is what protects live panes); a foreground `subshell run` outside the
 * manager is NAMED and never touched. A decline here does NOT abort, unlike
 * the server path: the client launch is not doomed — the app opens and can
 * Stop/Start the node from its own Service screen — so the run warns and
 * continues. A non-interactive run stops the service only with
 * `--stop-existing-service`, and otherwise also warns and continues.
 */
// Everything below the node: imports is reached by RELATIVE path rather than by
// package specifier, because `scripts/` is not a workspace and a bare
// `@internal/subshell-protocol` does not resolve from here. Same convention as
// `scripts/prune-node-artifacts.ts`.

import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ChildProcess } from "bun";
import {
  DEFAULT_DEPS as CLIENT_DEPS,
  stageSidecar as stageClientSidecar,
} from "../apps/client/desktop/src/scripts/release.js";
import {
  DEFAULT_DEPS as SERVER_DEPS,
  stageSidecar as stageServerSidecar,
} from "../apps/server/desktop/src/scripts/release.js";
import {
  DESKTOP_TARGETS,
  type DesktopTarget,
  desktopSidecarFileName,
  NODE_SIDECAR_NAME,
  SERVER_SIDECAR_NAME,
} from "../packages/subshell-protocol/src/paths.js";

const REPO_ROOT = join(import.meta.dir, "..");

/** One desktop app, as this script needs to know it. */
interface DesktopApp {
  /** The `dev:desktop-<id>` suffix, and what the usage line names. */
  id: "server" | "client";
  /** Path under `apps/`, which is not the id: the tree groups by vocabulary. */
  dir: string;
  /** The stem of the staged file — it names the binary the app WRAPS, not the app. */
  sidecar: string;
  /**
   * The Cargo crate name, which is also the dev binary's file name under
   * `src-tauri/target/debug/`. Deliberately NOT derived from {@link dir} or
   * {@link id}: the crate names are `subshell-desktop` and
   * `subshell-desktop-client`, which AGENTS.md keeps deliberately out of step
   * with the product names. Used to find a process still running this app.
   */
  crate: string;
  /**
   * The name the managed copy carries in `~/.local/bin` — `installed_name` in
   * each app's `SidecarSpec`, and the rung of the ladder this script refreshes.
   */
  installed: string;
  /** Workspace package whose sources compile into that binary; the graph is walked from here. */
  cliPackage: string;
  /**
   * Input directories the dependency graph does NOT reach. The server binary
   * embeds the built SPA, and `apps/server/web` is not a dependency of
   * `@internal/server` — the embed reads a path, so nothing in package.json
   * says the two are related.
   */
  extraInputs: readonly string[];
  /**
   * Where this app's CLI installs its per-user service definition, whose
   * ExecStart/ProgramArguments outranks the managed copy on the ladder. Named
   * here rather than derived, because the two CLIs disagree: the server's unit
   * is `subshell-server.service` / `dev.subshell.server.plist`, the agent's is
   * `subshell.service` / `dev.subshell.client.plist` (agent `service.ts`).
   */
  service: { unit: string; plist: string };
  /** Build and stage that binary for one target. Each app's own release pipeline. */
  stage: (target: string) => Promise<boolean>;
  /** What the build is actually doing, for the line printed before it. */
  builds: string;
}

const APPS: readonly DesktopApp[] = [
  {
    id: "server",
    dir: "server/desktop",
    sidecar: SERVER_SIDECAR_NAME,
    crate: "subshell-desktop",
    installed: "subshell-server",
    cliPackage: "@internal/server",
    extraInputs: ["apps/server/web"],
    service: { unit: "subshell-server.service", plist: "dev.subshell.server.plist" },
    stage: (target) => stageServerSidecar(SERVER_DEPS, target),
    builds: "the subshell-server CLI, with the SPA embedded",
  },
  {
    id: "client",
    dir: "client/desktop",
    sidecar: NODE_SIDECAR_NAME,
    crate: "subshell-desktop-client",
    installed: "subshell",
    cliPackage: "@internal/node",
    extraInputs: [],
    service: { unit: "subshell.service", plist: "dev.subshell.client.plist" },
    stage: (target) => stageClientSidecar(CLIENT_DEPS, target),
    builds: "the subshell node agent",
  },
];

/**
 * This machine, as a {@link DesktopTarget}, or `null` where the desktop apps
 * are not built at all.
 *
 * `DESKTOP_TARGETS` is deliberately narrower than the CLI targets — there is no
 * native arm64 Linux runner and Intel Macs are not a target — so an Intel Mac
 * or an arm64 Linux box has no triple here, and `rustTargetTriple` would throw
 * a message about release targets that reads as a bug rather than as "this host
 * is not supported".
 */
function hostTarget(): DesktopTarget | null {
  // Node's own spellings already match this repo's target names on every host
  // that has one (`darwin`/`linux` and `arm64`/`x64`), so this is a lookup
  // rather than a translation. A host outside the table falls out as null.
  const target = `${process.platform}-${process.arch}`;
  return (DESKTOP_TARGETS as readonly string[]).includes(target) ? (target as DesktopTarget) : null;
}

/**
 * Whether a usable sidecar is already staged. A zero-byte file is a leftover
 * stub from `rust:check`, not a binary — see this file's header.
 */
function isStaged(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Every workspace package.json in the repo, indexed by package name. */
function workspaceIndex(): Map<string, string> {
  const index = new Map<string, string>();
  // The three grouping levels the root package.json's workspaces cover. A
  // pattern that missed one would silently shrink the input set below, which
  // is the failure this whole staleness check exists to prevent — so the
  // lookup THROWS on a name it cannot place rather than skipping it.
  for (const pattern of ["apps/*/*/package.json", "packages/*/package.json", "packages/plugins/*/package.json"]) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })) {
      const dir = dirname(rel);
      try {
        const name = (JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")) as { name?: string }).name;
        if (name) index.set(name, dir);
      } catch {
        /* a workspace with an unreadable package.json is not this script's problem */
      }
    }
  }
  return index;
}

/**
 * The workspace directories whose sources decide what the staged binary
 * CONTAINS: the CLI's package plus every workspace it depends on, transitively,
 * plus whatever {@link DesktopApp.extraInputs} names.
 *
 * Walked from package.json rather than listed by hand, because a hand-written
 * list drifts the moment a package gains a dependency — and the way it drifts
 * is "the sidecar silently stopped being rebuilt", which is indistinguishable
 * from the bug at the top of this file.
 */
function inputDirs(app: DesktopApp): string[] {
  const index = workspaceIndex();
  const seen = new Set<string>();
  const dirs: string[] = [];
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const dir = index.get(name);
    if (dir === undefined) return; // an external dependency, not a workspace
    dirs.push(dir);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [dep, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (range.startsWith("workspace:")) walk(dep);
    }
  };
  walk(app.cliPackage);
  for (const extra of app.extraInputs) {
    if (!seen.has(extra)) {
      seen.add(extra);
      dirs.push(extra);
    }
  }
  return dirs;
}

/**
 * Paths that cannot change what the compiled binary contains.
 *
 * Build outputs and caches, the `__tests__/` directories the code-style rule
 * puts every test in (nothing bundles those, and a test-writing session should
 * not pay for a ~100 MB rebuild on every save), and — load-bearing —
 * `src/generated/`.
 *
 * That last one is what makes this check terminate. The server's release
 * pipeline WRITES into its own source tree: `embed-web` and `embed-plugins`
 * overwrite `apps/server/api/src/generated/*.ts` and a `finally` restores the
 * tracked stub with `git checkout`. Both steps stamp a file inside the input
 * set with a time after the binary was written, so counting them as inputs
 * leaves the tree permanently "newer than the binary" and every run rebuilds
 * forever. They are outputs of the build that produced the binary, not inputs
 * to it — measured, two consecutive runs with no edit in between.
 */
const NOT_INPUT = [
  "/node_modules/",
  "/dist/",
  "/.turbo/",
  "/target/",
  "/ios/",
  "/android/",
  "/__tests__/",
  "/src/generated/",
];

/**
 * The newest modification time under `dirs`, in epoch milliseconds.
 *
 * mtimes rather than content hashes: this runs before every dev launch, the
 * answer is almost always "nothing changed", and `git checkout` stamps every
 * file it writes — so a branch switch to OLDER code still reads as newer than
 * the binary, which is the safe direction to be wrong in.
 */
function newestInput(dirs: readonly string[]): number {
  let newest = 0;
  for (const dir of dirs) {
    const root = join(REPO_ROOT, dir);
    if (!existsSync(root)) continue;
    for (const rel of new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })) {
      const path = `/${rel}`;
      if (NOT_INPUT.some((skip) => path.includes(skip))) continue;
      try {
        const t = statSync(join(root, rel)).mtimeMs;
        if (t > newest) newest = t;
      } catch {
        /* vanished mid-scan (a build writing beside us) — not an input we can read */
      }
    }
  }
  return newest;
}

/** SHA-256 of a file, streamed — these are ~100 MB binaries. */
async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Replace the managed copy in `~/.local/bin` with the sidecar just staged, when
 * the two differ.
 *
 * Only when one is ALREADY installed: creating it here would pre-empt the
 * install the app performs on first run, which is a flow a developer running
 * this command is often here to exercise.
 *
 * Size is compared first only as a cheap disqualifier; the case that matters is
 * two same-size, same-version builds whose code differs, so equal sizes go on
 * to a real digest. Same-directory temp file plus `rename` makes the swap
 * atomic, and a copy that is mid-execution keeps its inode.
 */
async function refreshManagedCopy(app: DesktopApp, staged: string): Promise<void> {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: developer escape hatch for this script only
  if (process.env.SUBSHELL_DEV_SKIP_INSTALL === "1") return;
  const dest = join(homedir(), ".local", "bin", app.installed);
  if (!existsSync(dest)) return;

  const sameSize = statSync(dest).size === statSync(staged).size;
  if (sameSize && (await digest(dest)) === (await digest(staged))) return;

  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    copyFileSync(staged, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    console.error(`Could not refresh ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    console.error("The app will run whatever is installed there, which is not what was just built.\n");
    return;
  }
  console.log(`Refreshed ${dest} from the binary just built.`);
  console.log("(The app runs the INSTALLED copy, never the staged sidecar — see scripts/desktop-dev.ts.)");
  warnIfServiceOutranksManaged(app, dest);
  console.log("");
}

/**
 * Say so when a service definition names a DIFFERENT binary, because that rung
 * outranks the managed copy this script just refreshed — so the app would run
 * a file nothing here has touched.
 *
 * Read, never rewritten: the path in a service definition is one the operator
 * or an installer chose, and silently overwriting a binary somewhere else on
 * the disk is not a dev convenience.
 */
/**
 * The first command a service definition runs — the launchd
 * `ProgramArguments` array's first string, or systemd's `ExecStart` — or
 * `null` when neither is present.
 *
 * `platform` is a parameter rather than a `process.platform` read so the
 * parsing is testable on one host for both shapes.
 */
/**
 * The argv that builds ONE desktop app's workspace dists, as
 * {@link buildWorkspaceDists} spawns it — exported for the same reason every
 * parser here is: the decision is testable without running turbo.
 *
 * `--filter=<the app>` is the app's dependency GRAPH, not just the app: the
 * build task's `dependsOn: ["^build"]` makes turbo build every workspace
 * dist the app's page consumes, in order. Wave 1 of the rails redesign is
 * why this step exists at all — the assistant page imports a NEW workspace
 * package, and the dev path is the one thing in the repo that never built
 * workspace packages, so a fresh checkout with a fresh `bun install` still
 * died in the middle of the vite step with a resolver error naming a package
 * it had never heard of (measured 2026-09-22, the operator's `dev:desktop-server`
 * after pulling #132).
 */
export function workspaceBuildArgs(appId: "server" | "client"): string[] {
  // The app's own package name is derived, not stored: `@internal/desktop-server`
  // and `@internal/desktop-client` are the ids' direct image, and a stored
  // copy would be a third place to spell them.
  return ["turbo", "run", "build", `--filter=@internal/desktop-${appId}`];
}

/**
 * What a failed workspace-dists build tells the developer to do, keyed on
 * what its output says.
 *
 * The turbo re-run is the always remedy — the captured output below the
 * failure already says most of it, but a live run shows the whole graph. The
 * `bun install` remedy appears ONLY when the output names a package that
 * could not be found or resolved: that is the other half of the 2026-09-22
 * afternoon (node_modules predating a merge), and it is a DIFFERENT remedy
 * from a broken build.
 */
export function distBuildRemedies(appId: "server" | "client", output: string): string[] {
  const remedies = [
    `Re-run \`bunx ${workspaceBuildArgs(appId).join(" ")}\` from the repo root to see the full error live.`,
  ];
  // Case-insensitive: the resolver spells it "Could not resolve", rolldown
  // "failed to resolve import" — the operator's log had both.
  if (/cannot find package|could not resolve|failed to resolve|err_module_not_found/i.test(output)) {
    remedies.push("A package is missing from node_modules — run `bun install` first.");
  }
  return remedies;
}

/**
 * Build the workspace dists the bundled page's Vite build consumes.
 *
 * ALWAYS, not "when a dist is missing": the sidecar's mtime walk exists
 * because "present but STALE" is the same broken window as "absent" — a dev
 * launch against last week's `@internal/assistant` is exactly the failure
 * this run prevents, and turbo's hash check is the same cost class as that
 * walk (warm, it is under a second). Output is captured rather than
 * inherited so a quiet warm run stays quiet; a failure prints what it
 * captured plus {@link distBuildRemedies}, and the launch never happens —
 * tauri dev starting vite against half-built dists is the error that ate the
 * operator's afternoon.
 */
async function buildWorkspaceDists(app: DesktopApp): Promise<void> {
  const proc = Bun.spawn(["bunx", ...workspaceBuildArgs(app.id)], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    console.error(`\nCould not build the workspace dists the bundled page's Vite build consumes.`);
    const said = `${err}${out}`.trim();
    if (said !== "") console.error(said);
    for (const remedy of distBuildRemedies(app.id, `${err}${out}`)) console.error(`  ${remedy}`);
    process.exit(1);
  }
}

export function definitionFirstCommand(text: string, platform: NodeJS.Platform = process.platform): string | null {
  const first =
    platform === "darwin"
      ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      : /^ExecStart=(\S+)/m.exec(text)?.[1];
  return first ?? null;
}

/** Where one app's service definition lives — launchd's LaunchAgents on macOS, systemd --user elsewhere. */
function serviceDefinitionPath(app: DesktopApp): string {
  const home = homedir();
  return process.platform === "darwin"
    ? join(home, "Library", "LaunchAgents", app.service.plist)
    : join(home, ".config", "systemd", "user", app.service.unit);
}

function warnIfServiceOutranksManaged(app: DesktopApp, dest: string): void {
  const definition = serviceDefinitionPath(app);
  let text: string;
  try {
    text = readFileSync(definition, "utf8");
  } catch {
    return;
  }
  const first = definitionFirstCommand(text);
  if (first === null || first === dest) return;
  console.log(`NOTE: ${definition} runs ${first}, which outranks the copy above — the app will resolve THAT one.`);
}

/** Where `apps/server/web`'s own Vite server listens (its `vite.config.ts`). */
const SPA_DEV_URL = "http://localhost:5174";

/**
 * The parsed SERVER_PORT — the port the dev backend binds, whose compiled
 * default is 3080 (`apps/server/api/src/constants.ts:40`).
 *
 * Read from the environment rather than imported: `constants.ts` loads the
 * server's real config.env into `process.env` as an import side effect, and
 * this launcher must not do that to the `tauri dev` process it is about to
 * spawn. The launcher passes its whole environment down, so a SERVER_PORT in
 * the developer's shell decides the sidecar's port and this probe alike — one
 * value, both places. Drift hazard, named: the SPA dev proxy
 * (`apps/server/web/vite.config.ts`) still targets 3080 literally, so dev with
 * a non-default SERVER_PORT needs that proxy edited by hand until the two read
 * one source.
 *
 * An INVALID value is reported, not fallen back: the server's own
 * `asPortNumber()` THROWS on the same value, so the freshly built child would
 * refuse to boot while the default-YES prompt stopped the operator's real
 * service for nothing. Pure, so it is tested against fixed text.
 */
export function parseDevServerPort(raw: string | undefined): { ok: true; port: number } | { ok: false; value: string } {
  if (raw === undefined || raw === "") return { ok: true, port: 3080 };
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return { ok: true, port: parsed };
  return { ok: false, value: raw };
}

/** The dev port for THIS run, or a refusal naming the bad value. */
export function devServerPort(): number {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a dev-shell override, the same one the server binary reads
  const raw = process.env.SERVER_PORT;
  const parsed = parseDevServerPort(raw);
  if (!parsed.ok) {
    console.error(`SERVER_PORT=${parsed.value} is not a port — the server would refuse to boot on it. Aborting.`);
    process.exit(1);
  }
  return parsed.port;
}

/** One process holding a LISTEN socket, as `lsof -Fpc` reports it. */
export interface PortListener {
  /** The PID. */
  pid: number;
  /** The COMMAND column — a basename, e.g. `subshell-server`; `""` when lsof named none. */
  command: string;
}

/**
 * Parse `lsof -nP -sTCP:LISTEN -iTCP:<port> -Fpc` output.
 *
 * lsof's field output is one `x<value>` line per field; a `p` line begins a
 * process record and the fields after it belong to that record. This build
 * also emits an `f` (file-descriptor) line that was not asked for — unknown
 * fields are ignored rather than assumed, so the parser survives lsof
 * variants. Records are DEDUPED by pid, because lsof emits one record per
 * socket and a listener bound on both stacks renders the same process twice;
 * the output is one entry per PROCESS. Pure, so it is tested against fixed
 * text.
 */
export function parseLsofListeners(output: string): PortListener[] {
  const byPid = new Map<number, PortListener>();
  let current: PortListener | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      current = { pid: Number(line.slice(1)), command: "" };
      const existing = byPid.get(current.pid);
      if (existing === undefined) byPid.set(current.pid, current);
      else current = existing;
    } else if (line.startsWith("c") && current !== null && current.command === "") {
      current.command = line.slice(1);
    }
  }
  return [...byPid.values()].filter((l) => Number.isInteger(l.pid) && l.pid > 0);
}

/** One line naming the holders: `subshell-server (pid 67215)`, comma-joined; `unknown process` when lsof named no command. */
function holderLine(listeners: readonly PortListener[]): string {
  return listeners.map((l) => `${l.command !== "" ? l.command : "unknown process"} (pid ${l.pid})`).join(", ");
}

/** LISTEN-only, by flag (`-sTCP:LISTEN`): a bare port match includes client sockets. */
async function probePortListeners(port: number): Promise<PortListener[] | null> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", "-sTCP:LISTEN", `-iTCP:${port}`, "-Fpc"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return parseLsofListeners(out);
  } catch {
    // lsof missing or unspawnable — the caller warns and continues rather
    // than aborting a launch a machine without lsof can still make.
    return null;
  }
}

/** The slice of `subshell-server service status --json` the preflight reads. */
export interface ServiceStatus {
  /** Whether a unit/plist exists on disk. */
  installed: boolean;
  /** The manager's view of the process — `running` | `stopping` | `stopped` | `not-installed` | `unknown`. */
  state: string;
  /** Main PID when the manager reports one, else `null`. */
  pid: number | null;
}

/** Parse the status JSON, or `null` when it is not the shape this file means. */
export function parseServiceStatus(output: string): ServiceStatus | null {
  try {
    const raw = JSON.parse(output) as Partial<ServiceStatus>;
    if (typeof raw.installed !== "boolean" || typeof raw.state !== "string") return null;
    return { installed: raw.installed, state: raw.state, pid: typeof raw.pid === "number" ? raw.pid : null };
  } catch {
    return null;
  }
}

/** Ask the installed CLI what its manager reports. `binary` is non-null from {@link resolveInstalledCli}. */
async function readServiceStatus(binary: string): Promise<ServiceStatus | null> {
  const proc = Bun.spawn([binary, "service", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseServiceStatus(out);
}

/** The port verdict: free, held by the installed Subshell Server service, or held by something else. */
export type PortVerdict = "free" | "our-service" | "foreign";

/**
 * Who holds the port, from the listener list and the service manager's view.
 *
 * `our-service` requires a POSITIVE match: the service is installed AND
 * running AND its main pid is one of the listeners. A running service whose
 * pid does NOT hold the port is `foreign` — stopping it would not free the
 * port, so offering to stop it would be a remedy for a different problem than
 * the one on screen (the caller still mentions the service in that case).
 * Pure, so it is tested against fixed inputs.
 */
export function classifyPortConflict(listeners: readonly PortListener[], service: ServiceStatus | null): PortVerdict {
  if (listeners.length === 0) return "free";
  const running = service?.installed && service.state === "running" && service.pid !== null;
  if (running && listeners.some((l) => l.pid === service.pid)) return "our-service";
  return "foreign";
}

/**
 * The installed CLI the preflight would ask and stop, or `null` — generic over
 * the app because each one wraps its own binary: `subshell-server` for the
 * server, `subshell` for the client. Both questions below read
 * {@link DesktopApp.installed}, which is the name the managed copy carries, so
 * neither can ask the wrong product about the other's service.
 *
 * The service definition's binary FIRST — the manager runs THAT file, so its
 * `service status` is the honest answer; a PATH binary of a different vintage
 * can misreport the installed service's state and turn `our-service` into a
 * false `foreign`. Then PATH (the operator may keep the CLI somewhere else),
 * then the managed copy the desktop app installs at `~/.local/bin`.
 */
function resolveInstalledCli(app: DesktopApp): string | null {
  try {
    const fromDefinition = definitionFirstCommand(readFileSync(serviceDefinitionPath(app), "utf8"));
    if (fromDefinition !== null) return fromDefinition;
  } catch {
    /* no definition on disk — nothing installed, fall through */
  }
  const which = Bun.spawnSync(["which", app.installed], { stdout: "pipe", stderr: "ignore" });
  if (which.exitCode === 0) {
    const onPath = which.stdout.toString().trim();
    if (onPath !== "") return onPath;
  }
  const managed = join(homedir(), ".local", "bin", app.installed);
  if (existsSync(managed)) return managed;
  return null;
}

/** The prompt's default is YES: empty, `y`, `Y`, `yes` — anything else declines. */
export function isConfirm(answer: string): boolean {
  return /^\s*(y|yes)?\s*$/i.test(answer);
}

/** The slice of a readline interface {@link confirmOn} needs. */
export interface ConfirmReadline {
  question(question: string): Promise<string>;
  once(event: "close", listener: () => void): unknown;
}

/**
 * One `[Y/n]` answer, raced against the stream's close.
 *
 * Under Bun, a question whose input ENDS before an answer never resolves
 * (measured: 120 s, no resolution; Node answers `""`) — so a stray Ctrl-D at
 * the prompt would hang the launcher, and mapping the close to `""` would
 * read it as YES. It reads as DECLINE instead: the prompt's default is for a
 * typed Enter, never for an input that closed, and an accidental EOF must
 * never stop the operator's running service.
 */
export async function confirmOn(rl: ConfirmReadline, question: string): Promise<boolean> {
  const questionPromise = rl.question(question);
  // The close path may abandon this promise and readline rejects a pending
  // question on close — keep the losing branch from surfacing as an unhandled
  // rejection.
  questionPromise.catch(() => {});
  const closed = await Promise.race([
    questionPromise,
    new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
  ]);
  return closed !== null && isConfirm(closed);
}

/** One `[Y/n]` question on the inherited stdin. The launcher is interactive by nature. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return confirmOn(rl, question).finally(() => rl.close());
}

/**
 * Stop the installed service with the CLI VERB, never a kill — launchd/systemd
 * KeepAlive would respawn a killed pid, and the CLI's own pane-safety refusal
 * is the thing that protects live panes on an old definition.
 */
async function stopService(binary: string): Promise<void> {
  const proc = Bun.spawn([binary, "service", "stop"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  await proc.exited;
}

/**
 * The :3080 preflight (operator ruling 2026-09-21): dev always uses the most
 * recently built server, and the freshly built sidecar cannot bind a port the
 * installed service holds — so the service is offered a stop, and a decline or
 * an unattended run without `--stop-existing-service` aborts with the remedies
 * named. A holder that is NOT the service is named and left alone.
 *
 * Abort is `process.exit(1)` rather than a thrown error: the caller is
 * `main()`, and the message on screen is the product. Exported (like the pure
 * seams above) so the verdict can be driven against a real machine without a
 * launch; importing this file runs nothing — the CLI body is `main`-guarded.
 */
export async function preflightDevPort(
  app: DesktopApp,
  opts: { checkOnly: boolean; stopRequested: boolean },
): Promise<void> {
  const port = devServerPort();
  const listeners = await probePortListeners(port);
  if (listeners === null) {
    console.warn(
      `NOTE: could not check whether something already listens on :${port} (lsof unavailable). ` +
        "If the dashboard later shows a server you did not just build, stop the installed service by hand.",
    );
    return;
  }
  if (listeners.length === 0) {
    if (opts.checkOnly) console.log(`Port ${port} is free.`);
    return;
  }

  const binary = resolveInstalledCli(app);
  const service = binary === null ? null : await readServiceStatus(binary);
  const verdict = classifyPortConflict(listeners, service);
  const held = `Port ${port} is held by ${holderLine(listeners)}.`;

  if (verdict === "our-service") {
    // classifyPortConflict answers our-service only for a running, INSTALLED
    // service, which readServiceStatus(binary) produced — binary is non-null
    // here by construction; the ?? is unreachable and never `!`.
    const server = binary ?? "subshell-server";
    if (opts.checkOnly) {
      console.log(
        `${held} The installed subshell-server service (pid ${service?.pid ?? "unknown"}) holds the port dev binds — ` +
          "a real run prompts to stop it (or pass --stop-existing-service). --check never stops anything.",
      );
      return;
    }
    const proceed = opts.stopRequested
      ? true
      : process.stdin.isTTY
        ? await confirm(
            `${held}\nThe freshly built server cannot bind it, so dev would run against the installed build. ` +
              "Stop the service so dev uses the new server? [Y/n] ",
          )
        : false;
    if (!proceed) {
      console.error(held);
      if (!process.stdin.isTTY && !opts.stopRequested) {
        console.error("Non-interactive run: nothing is stopped without consent (--stop-existing-service consents).");
      }
      console.error("Two ways forward:");
      console.error(`  - stop the service and re-run: ${server} service stop (it stays down until \`service start\`)`);
      console.error(`  - update the installed server instead, if :${port} is the port you want served`);
      process.exit(1);
    }
    console.log(`Stopping the installed service (${server} service stop)…`);
    await stopService(server);
    console.log("The service will not come back until `subshell-server service start`.");
    const after = await probePortListeners(port);
    if (after === null || after.length > 0) {
      console.error(
        after === null
          ? `Could not re-check :${port} after \`service stop\` (lsof became unavailable) — ` +
              `confirm with \`${server} service status\` before continuing.`
          : `Port ${port} is STILL held by ${holderLine(after)}, after \`service stop\` — ` +
              `re-check with \`${server} service status\`.`,
      );
      process.exit(1);
    }
    return;
  }

  // Foreign holder, or a service that is running but does NOT hold the port.
  if (binary !== null && service === null) {
    // The holder is being treated as foreign on an UNREADABLE status, not a
    // negative one — say so, rather than "not the installed service" implying
    // the service was asked and said no.
    console.error(`NOTE: \`${binary} service status --json\` did not answer a readable status.`);
  }
  console.error(
    `${held} Not the installed Subshell Server service — the launcher never kills processes it did not start.`,
  );
  console.error("Stop that process by hand, then re-run.");
  if (service?.installed && service.state === "running") {
    console.error(
      "The installed service is also running, but it does not hold this port; stopping it will not free it.",
    );
  }
  process.exit(1);
}

/**
 * PIDs from a `ps -eo pid=,command=` dump whose command is `<binary> run …`.
 *
 * **The supervised daemon IS one of these** — the unit's ExecStart/
 * ProgramArguments is exactly `<self> run` (`execLine` in
 * `apps/node/agent/src/service.ts`) — so this names every live daemon, and the
 * CALLER subtracts the manager-reported pid to find the unsupervised ones.
 * Matching is by token: argv[0]'s basename equals `binaryName` exactly (so
 * `subshell-server run` is not `subshell run`) and the next token is exactly
 * `run` (so `subshell service status` and a `grep 'subshell run'` are not). An
 * argv[0] containing whitespace tokenizes wrong and is MISSED — acceptable
 * because a miss only withholds a note, while acting on a false match never
 * happens: this list names processes and nothing else. Pure, so it is tested
 * against fixed text.
 */
export function parseRunDaemonPids(psOutput: string, binaryName: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const [argv0, next] = match[2].split(/\s+/);
    if (argv0 === undefined || next !== "run") continue;
    const base = argv0.slice(argv0.lastIndexOf("/") + 1);
    if (base === binaryName) pids.push(Number(match[1]));
  }
  return pids;
}

/** Live `subshell run` processes, or `null` when `ps` itself could not run. */
async function probeRunDaemons(binaryName: string): Promise<number[] | null> {
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return parseRunDaemonPids(out, binaryName);
  } catch {
    // Same rule as probePortListeners: a machine this script cannot fully
    // interrogate still launches its app — the caller notes the blind spot.
    return null;
  }
}

/** What the client preflight makes of the manager's answer plus the live daemons. */
export interface ClientDaemonPlan {
  /** The managed node service is installed AND running — it gets the offer. */
  serviceRunning: boolean;
  /** The service's main pid when the manager reports one; excluded below. */
  servicePid: number | null;
  /**
   * Live `<binary> run` processes the manager did NOT report starting —
   * foreground `subshell run` daemons. Named to the operator, never stopped:
   * their terminal owns them, and a stranger pid is not this launch's to kill.
   */
  unsupervisedPids: number[];
}

/**
 * Decide the client preflight from the two facts. Pure, so the decision — not
 * just the parsing — is tested without a live service or daemon.
 *
 * `unsupervisedPids` subtracts the manager's pid whenever it has one, even in a
 * non-running state: a pid the manager named is the manager's process, and
 * wrongly STOPPING is impossible here while wrongly NAMING is harmless — still,
 * call the service's own pid the service's, not a stranger's. A running
 * service whose pid is `null` (a manager that answered state but not pid)
 * leaves every live daemon named alongside the offer, which is the honest
 * reading: nobody can say which of them the manager started.
 */
export function planClientDaemonPreflight(service: ServiceStatus | null, runPids: readonly number[]): ClientDaemonPlan {
  const servicePid = service?.pid ?? null;
  return {
    serviceRunning: service?.installed === true && service.state === "running",
    servicePid,
    unsupervisedPids: runPids.filter((pid) => pid !== servicePid),
  };
}

/**
 * The node-daemon preflight for the CLIENT app, the analog of
 * {@link preflightDevPort} (see this file's header for the hazard): a running
 * daemon keeps its OLD binary in memory no matter what the digest swap just
 * wrote to disk, so dev would exercise THAT. A running managed service is
 * offered the CLI verb `subshell service stop` — never a kill, which KeepAlive
 * would undo, and whose pane-safety handling is what protects live panes. A
 * foreground `subshell run` is named and left alone.
 *
 * **Decline warns and continues — the deliberate difference from the server
 * path.** A held :3080 dooms the server launch; a stale daemon does not doom
 * this one — the app opens and its own Service screen can Stop and Start the
 * node, so aborting here would refuse a session the developer can fix in two
 * clicks. Same consent shape for a non-interactive run:
 * `--stop-existing-service` stops, nothing stops without it, and the launch
 * proceeds with the shadowing stated plainly.
 */
export async function preflightClientDaemon(
  app: DesktopApp,
  opts: { checkOnly: boolean; stopRequested: boolean },
): Promise<void> {
  const binary = resolveInstalledCli(app);
  if (binary === null) {
    if (opts.checkOnly) console.log(`No installed \`${app.installed}\` CLI found — no node service to ask.`);
    return;
  }
  const service = await readServiceStatus(binary);
  const runPids = await probeRunDaemons(app.installed);
  if (runPids === null) {
    console.warn(
      `NOTE: could not check for a foreground \`${app.installed} run\` daemon (ps unavailable); ` +
        "the service manager was still asked.",
    );
  }
  if (service === null) {
    console.warn(`NOTE: \`${binary} service status --json\` did not answer a readable status.`);
  }
  const plan = planClientDaemonPreflight(service, runPids ?? []);

  if (plan.unsupervisedPids.length > 0) {
    console.warn(
      `NOTE: \`${app.installed} run\` daemons are running OUTSIDE the service manager ` +
        `(pid ${plan.unsupervisedPids.join(", ")}). ` +
        "Each holds whatever binary it started with; this launcher never stops processes it did not start. " +
        "End one with Ctrl-C in the terminal running it.",
    );
  }

  if (!plan.serviceRunning) {
    if (opts.checkOnly)
      console.log("The node service is not running; a dev launch starts fresh against the new binary.");
    return;
  }

  const pidNote = plan.servicePid === null ? "" : ` (pid ${plan.servicePid})`;
  const running = `The installed node service${pidNote} is running, and a running daemon keeps its binary in memory.`;
  if (opts.checkOnly) {
    console.log(
      `${running} A real run would offer to stop it so dev exercises the freshly built agent ` +
        "(or pass --stop-existing-service). --check never stops anything.",
    );
    return;
  }
  const proceed = opts.stopRequested
    ? true
    : process.stdin.isTTY
      ? await confirm(
          `${running}\nA dev launch would otherwise exercise THAT daemon's binary, not the one just built. ` +
            "Stop the node service so the app starts the new one? [Y/n] ",
        )
      : false;
  if (!proceed) {
    console.warn(running);
    if (!process.stdin.isTTY && !opts.stopRequested) {
      console.warn("Non-interactive run: nothing is stopped without consent (--stop-existing-service consents).");
    }
    console.warn(
      `Continuing anyway — the app can Stop and Start the node from its own Service screen, ` +
        `or re-run after \`${binary} service stop\`.`,
    );
    return;
  }
  console.log(`Stopping the node service (${binary} service stop)…`);
  await stopService(binary);
  console.log("The service will not come back until `subshell service start`.");
  const after = await readServiceStatus(binary);
  if (after?.installed && after.state === "running") {
    console.warn(
      `The node service STILL reports running after \`service stop\` — re-check with \`${binary} service status\`.`,
    );
  }
}

/** A HEAD against the dev server's root. Vite answers; a free port rejects. */
async function spaListening(): Promise<boolean> {
  try {
    await fetch(SPA_DEV_URL, { method: "HEAD", signal: AbortSignal.timeout(700) });
    return true;
  } catch {
    return false;
  }
}

/** What {@link ensureSpaDevServer} hands back. */
interface SpaDev {
  url: string;
  /** The Vite THIS run started, or null when a developer's own already answered. */
  child: ChildProcess | null;
}

/** How long to wait for a spawned Vite to answer before falling back. */
const SPA_START_BUDGET_MS = 20_000;

/**
 * The SPA dev server to point the dashboard at — reused, or STARTED here.
 *
 * **Reused when one is already listening**, which is the old rule and keeps
 * its reason: `bun run dev` may own the port, and a second Vite fighting it
 * is a confusing failure. **Started when nothing is**, on the operator's
 * ask of 2026-09-25: detect-only meant the dashboard silently showed the
 * installed binary's embedded build, and an edit under `apps/server/web`
 * reached it "not slowly but not at all" — a dev launch that cannot see the
 * working tree is the surprise. What the old rule feared (a window aimed at
 * a dead port) is handled by WAITING: this returns only once the port
 * answers, and a Vite that never comes up is killed and the caller falls
 * back to the old warning. Nothing is ever pointed at a port this function
 * did not see answer.
 */
async function ensureSpaDevServer(): Promise<SpaDev | null> {
  if (await spaListening()) return { url: SPA_DEV_URL, child: null };
  // stderr is kept: a Vite that dies on the way up (a missing dep, a bound
  // port it refused) says why there, and the fallback message quotes it.
  const child = Bun.spawn(["bun", "run", "--cwd", join("apps", "server", "web"), "dev"], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let waited = 0; waited < SPA_START_BUDGET_MS; waited += 300) {
    if (await spaListening()) return { url: SPA_DEV_URL, child };
    if (child.exitCode !== null) break;
    await Bun.sleep(300);
  }
  const why = child.exitCode === null ? "it never answered the port in time" : `it exited (code ${child.exitCode})`;
  try {
    child.kill(15);
  } catch {
    // Already gone — the case we were trying to end anyway.
  }
  const stderr = child.stderr ? await new Response(child.stderr as ReadableStream).text().catch(() => "") : "";
  if (stderr.trim() !== "") console.error(`  vite said: ${stderr.trim().split("\n").slice(-4).join("\n  ")}`);
  console.warn(`  The SPA dev server could not be started (${why}).`);
  return null;
}

/**
 * How this app's dev binary appears in a `ps` line: `target/debug/<crate>`.
 *
 * A SUFFIX rather than an absolute path, because the two ways this process can
 * exist spell it differently and only one of them is absolute. `cargo run`
 * starts it from `src-tauri/`, so `ps` shows the relative
 * `target/debug/subshell-desktop`; a replacement the app spawned for itself
 * shows the full path. Matching the tail catches both. `comm` does not help —
 * measured on macOS 25, it mirrors argv[0] rather than resolving it, so a
 * relatively-launched process reports a relative name there too.
 *
 * Anchored at the END, which is what keeps the two apps apart:
 * `…/subshell-desktop-client` does not end with `…/subshell-desktop`.
 */
function devBinarySuffix(app: DesktopApp): string {
  return join("target", "debug", app.crate);
}

/**
 * The two commands a run of this script owns, as they appear in `ps`.
 *
 * `vite` is the app's OWN UI dev server — `tauri dev` starts it as
 * `beforeDevCommand`, and it is what every bundled window loads from `devUrl`.
 * It is matched by a path under this app's directory, never by the bare word:
 * `apps/server/web` runs a vite of its own that a developer starts
 * deliberately for SPA hot-reload, and killing that one would be this script
 * reaching outside its own session.
 */
function ownedCommands(app: DesktopApp): OwnedCommands {
  return { binary: devBinarySuffix(app), vite: join("apps", app.dir, "node_modules", ".bin", "vite") };
}

/** What {@link parseAppPids} matches on. */
export interface OwnedCommands {
  /** Tail of the app binary's path — `target/debug/<crate>`. */
  binary: string;
  /** Path fragment identifying this app's own UI dev server. */
  vite: string;
}

/**
 * PIDs from a `ps -eo pid=,command=` dump whose command ends with `suffix`,
 * minus everything in `ignore`.
 *
 * `ignore` is the set that was ALREADY running when this script started —
 * another developer's session, or a window someone left open on purpose. This
 * script kills what its own run leaked and nothing else, and a pid it never
 * saw start is not its business.
 *
 * Pure, so the parsing is tested against fixed text rather than against
 * whatever happens to be running on the machine.
 */
export function parseAppPids(psOutput: string, owned: OwnedCommands, ignore: ReadonlySet<number>): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    // The binary is matched at the END (a relative and an absolute spelling
    // share that tail, and `…-client` is not `…-desktop`); vite anywhere,
    // because `node <path>/vite` carries arguments after it.
    if (ignore.has(pid)) continue;
    if (command.endsWith(owned.binary) || command.includes(owned.vite)) pids.push(pid);
  }
  return pids;
}

/** Live PIDs running this app's dev binary. */
async function appPids(app: DesktopApp, ignore: ReadonlySet<number>): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseAppPids(out, ownedCommands(app), ignore);
}

/**
 * Kill any app process this run leaked, once `tauri dev` is gone.
 *
 * **The leak is real and has one cause: the app restarts ITSELF.** A desktop
 * reset ends with `app.restart()`, which spawns a replacement and `exit(0)`s
 * the current process (tauri 2.11.5 `process.rs`; the macOS bundle branch does
 * not apply to a bare `target/debug` binary, so it is a plain `Command::spawn`
 * that inherits our process group). `tauri dev` sees the child it started
 * exit, concludes the app quit, and tears itself down — taking the UI's Vite
 * dev server with it. The replacement outlives all of that, reparented to
 * init, pointed at a `devUrl` that no longer answers.
 *
 * What the developer sees is a WHITE WINDOW and a shell back at its prompt,
 * which is the worst possible pair: Ctrl-C there kills nothing, because the
 * foreground group is empty — the pipeline exited on its own minutes earlier.
 * So this is not only a Ctrl-C fix. Nothing is recoverable about that window
 * either way (its dev server is gone), so closing it and saying why beats
 * leaving it on screen to be discovered.
 */
async function killLeakedApps(app: DesktopApp, ignore: ReadonlySet<number>): Promise<void> {
  let pids = await appPids(app, ignore);
  if (pids.length === 0) return;
  console.log(
    `==> ${app.id} desktop: ${pids.length} process(es) outlived \`tauri dev\` (${pids.join(", ")}) — killing them.\n` +
      "    A desktop reset restarts the app, and the restarted process survives the dev server that renders it,\n" +
      "    so it could only ever show a blank window. Re-run this command to come back up.",
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between the listing and here — the outcome we wanted.
    }
  }
  // SIGTERM is enough for a Tauri app; the deadline is for one that is wedged.
  for (let waited = 0; waited < 3000 && pids.length > 0; waited += 100) {
    await Bun.sleep(100);
    pids = await appPids(app, ignore);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Same.
    }
  }
}

/**
 * `tauri dev` for one app, inheriting stdio so its output and Ctrl-C behave.
 *
 * **The server app's dashboard window is pointed at the SPA dev server**,
 * which is the only way an edit in `apps/server/web` reaches that window at
 * all: it otherwise loads the installed binary's EMBEDDED SPA, built at
 * release time. A running Vite is reused; when none answers, one is started
 * here and waited for ({@link ensureSpaDevServer}) and reaped on the way out
 * — a dev launch that could not see the working tree was the surprise
 * (operator, 2026-09-25). Left to an environment variable a person has to
 * remember it would still be that surprise; the variable still wins when set
 * explicitly, which is what makes a non-default port possible.
 *
 * Not for the client app: its remote window is a control plane that can live
 * anywhere, and the one command it is granted opens a page in the system
 * browser rather than loading one here, so there is nothing to hot-reload.
 */
async function runDev(app: DesktopApp): Promise<number> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  let spaChild: ChildProcess | null = null;
  if (app.id === "server" && env.SUBSHELL_DESKTOP_SPA_URL === undefined) {
    const spa = await ensureSpaDevServer();
    if (spa) {
      spaChild = spa.child;
      env.SUBSHELL_DESKTOP_SPA_URL = spa.url;
      console.log(
        spa.child === null
          ? `==> SPA dev server on ${spa.url} — the dashboard will open THERE, so the SPA hot-reloads.`
          : `==> SPA dev server STARTED here on ${spa.url} — the dashboard will open THERE, so the SPA hot-reloads.`,
      );
    } else {
      console.log(
        `==> no SPA dev server on ${SPA_DEV_URL}: the dashboard will show the installed binary's embedded SPA, ` +
          // `--cwd` BEFORE the script name. The other spelling is what this
          // printed, and it fails with `Script not found "dev"` — the one
          // line a confused developer copy-pastes, in a feature whose whole
          // point is that the absence of hot reload should not be a mystery.
          "which will NOT pick up edits under apps/server/web. Start one with `bun run --cwd apps/server/web dev`.",
      );
    }
  }
  // Snapshotted BEFORE the spawn: whatever is already running belongs to
  // somebody else's session and is never this run's to kill.
  const preexisting = new Set(await appPids(app, new Set()));
  // Ctrl-C reaches the whole foreground group, this script included, and the
  // default disposition would end it here — before the sweep below could run.
  // The handlers make it a no-op for US only: the child is in the same group
  // and gets its own SIGINT, so it still shuts down exactly as it did before,
  // and `proc.exited` is what we go on rather than the signal.
  const stayForCleanup = (): void => {};
  process.on("SIGINT", stayForCleanup);
  process.on("SIGTERM", stayForCleanup);
  const proc = Bun.spawn(["bun", "run", "--cwd", `apps/${app.dir}`, "dev:app"], {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });
  const code = await proc.exited;
  // The Vite this run started belongs to this run. Ctrl-C reaches it through
  // the shared process group anyway; this is the path where `tauri dev` ends
  // on its own and would otherwise leave the dev server holding :5174 with
  // no app pointed at it. A Vite the developer started themselves is never
  // ours to kill — `spaChild` is null in that case by construction.
  if (spaChild) {
    try {
      spaChild.kill(15);
    } catch {
      // Already gone.
    }
  }
  await killLeakedApps(app, preexisting);
  return code;
}

function usage(): never {
  const names = APPS.map((a) => `dev:desktop-${a.id}`).join(" | ");
  console.error(`usage: bun run ${names} [--force] [--check] [--stop-existing-service]`);
  console.error("  --force  rebuild the CLI even when nothing under its workspaces has changed");
  console.error("  --check  build, stage and refresh as usual, then stop instead of launching the app");
  console.error(
    "  --stop-existing-service  stop a running installed service without asking (the server holding the dev" +
      " port; the node daemon shadowing the freshly built binary)",
  );
  process.exit(2);
}

// The CLI body runs only when this file IS the program. A test imports it
// for `parseAppPids`, and without the guard that import parses argv, finds
// no app id and exits through `usage()` — the same convention
// `package-releases.ts` uses for the same reason.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  /** Everything except the launch — what is this about to run, without opening a window. */
  const checkOnly = args.includes("--check");
  /** Consent, for a non-TTY run, to stop the installed service that holds the dev port. */
  const stopExistingService = args.includes("--stop-existing-service");
  const requested = args.find((arg) => !arg.startsWith("--"));
  const app = APPS.find((candidate) => candidate.id === requested);
  if (!app) usage();

  const target = hostTarget();
  if (target === null) {
    console.error(
      `The desktop apps are built for ${DESKTOP_TARGETS.join(" and ")} only, and this is ${process.platform}-${process.arch}.`,
    );
    process.exit(1);
  }

  // `tauri dev` compiles Rust, so it needs a C toolchain that links. On a Mac
  // whose Xcode licence is unaccepted it does not, and cargo reports that as a
  // note buried under an error naming a source file. Refuse here, by name,
  // BEFORE the minutes spent building a sidecar that cannot be linked anyway.
  // The probe is a script rather than a function because `rust:check` needs the
  // identical answer and two spellings of one check is how they come to differ.
  const toolchain = Bun.spawnSync([join(REPO_ROOT, "scripts", "macos-toolchain-preflight.sh")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (toolchain.exitCode !== 0) process.exit(toolchain.exitCode ?? 1);

  // Before anything is staged. The server's launch is DOOMED while the
  // installed service holds the dev port (see this file's header), so that
  // preflight aborts — here, not after a rebuild nobody will use. The client's
  // hazard is a running daemon shadowing the swapped binary in memory, which
  // the app itself can fix, so that preflight offers and continues.
  if (app.id === "server") {
    await preflightDevPort(app, { checkOnly, stopRequested: stopExistingService });
  } else {
    await preflightClientDaemon(app, { checkOnly, stopRequested: stopExistingService });
  }

  const staged = join(REPO_ROOT, "apps", app.dir, "src-tauri", "binaries", desktopSidecarFileName(app.sidecar, target));

  const stagedAt = isStaged(staged) ? statSync(staged).mtimeMs : null;
  const changed = stagedAt !== null && newestInput(inputDirs(app)) > stagedAt;
  const why =
    stagedAt === null
      ? `No sidecar staged for ${target}.`
      : force
        ? `Rebuilding the ${target} sidecar (--force).`
        : changed
          ? `Sources have changed since the ${target} sidecar was built.`
          : null;

  if (why !== null) {
    console.log(`${why} Building ${app.builds} — a few minutes.`);
    console.log("Later runs skip this while nothing under the CLI's workspaces has changed.\n");
    if (!(await app.stage(target))) {
      console.error(`\nCould not stage the sidecar for ${target}. The build output above says why.`);
      process.exit(1);
    }
    console.log(`\nStaged ${desktopSidecarFileName(app.sidecar, target)}.`);
  } else {
    console.log(`Sidecar for ${target} is newer than every source it is built from; not rebuilding.`);
  }
  await refreshManagedCopy(app, staged);

  // The bundled page's vite consumes workspace dists (`@internal/assistant`
  // and friends), and nothing else in the dev path builds them. Always —
  // turbo's hash check is the same cost class as the sidecar walk above, and
  // it buys the same guarantee: what the page builds against is CURRENT.
  console.log("==> Building the workspace dists the bundled page's Vite build consumes (turbo, incremental).");
  await buildWorkspaceDists(app);

  if (checkOnly) process.exit(0);
  process.exit(await runDev(app));
}
