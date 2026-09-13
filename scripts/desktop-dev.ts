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
 * a ladder (`server_bin.rs`, `agent_bin.rs`): an env override, a configured
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
 */
// Everything below the node: imports is reached by RELATIVE path rather than by
// package specifier, because `scripts/` is not a workspace and a bare
// `@internal/subshell-protocol` does not resolve from here. Same convention as
// `scripts/prune-node-artifacts.ts`.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_DEPS as CLIENT_DEPS,
  stageSidecar as stageClientSidecar,
} from "../apps/client/desktop/src/scripts/release.js";
import {
  DEFAULT_DEPS as SERVER_DEPS,
  stageSidecar as stageServerSidecar,
} from "../apps/server/desktop/src/scripts/release.js";
import {
  AGENT_SIDECAR_NAME,
  DESKTOP_TARGETS,
  type DesktopTarget,
  desktopSidecarFileName,
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
    sidecar: AGENT_SIDECAR_NAME,
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
function warnIfServiceOutranksManaged(app: DesktopApp, dest: string): void {
  const home = homedir();
  const definition =
    process.platform === "darwin"
      ? join(home, "Library", "LaunchAgents", app.service.plist)
      : join(home, ".config", "systemd", "user", app.service.unit);
  let text: string;
  try {
    text = readFileSync(definition, "utf8");
  } catch {
    return;
  }
  const first =
    process.platform === "darwin"
      ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      : /^ExecStart=(\S+)/m.exec(text)?.[1];
  if (first === undefined || first === dest) return;
  console.log(`NOTE: ${definition} runs ${first}, which outranks the copy above — the app will resolve THAT one.`);
}

/** Where `apps/server/web`'s own Vite server listens (its `vite.config.ts`). */
const SPA_DEV_URL = "http://localhost:5174";

/**
 * The SPA dev server's address when one is actually listening, else null.
 *
 * **Detected rather than assumed, and never started.** Pointing the dashboard
 * window at a port with nothing behind it is worse than the default — a
 * window of failed requests instead of a working app — so this only reports
 * what is there. Starting one here was the alternative and is worse in a
 * different way: `bun run dev` may already own that port, and a second Vite
 * fighting it is a confusing failure to hand someone who just wanted the app.
 */
async function spaDevServer(): Promise<string | null> {
  try {
    // A HEAD against the dev server's root. Vite answers; nothing listening
    // rejects immediately, which is the case this is distinguishing.
    await fetch(SPA_DEV_URL, { method: "HEAD", signal: AbortSignal.timeout(700) });
    return SPA_DEV_URL;
  } catch {
    return null;
  }
}

/**
 * `tauri dev` for one app, inheriting stdio so its output and Ctrl-C behave.
 *
 * **The server app's dashboard window is pointed at the SPA dev server when
 * one is running**, which is the only way an edit in `apps/server/web` reaches
 * that window at all: it otherwise loads the installed binary's EMBEDDED SPA,
 * built at release time. Detected here rather than left to an environment
 * variable a person has to remember — the variable still wins when set
 * explicitly, which is what makes a non-default port possible.
 *
 * Not for the client app: its remote window is a control plane that can live
 * anywhere, is granted no commands, and ships without the desktop marker, so
 * there is nothing here to hot-reload.
 */
async function runDev(app: DesktopApp): Promise<number> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (app.id === "server" && env.SUBSHELL_DESKTOP_SPA_URL === undefined) {
    const found = await spaDevServer();
    if (found) {
      env.SUBSHELL_DESKTOP_SPA_URL = found;
      console.log(`==> SPA dev server on ${found} — the dashboard will open THERE, so the SPA hot-reloads.`);
    } else {
      console.log(
        `==> no SPA dev server on ${SPA_DEV_URL}: the dashboard will show the installed binary's embedded SPA, ` +
          "which will NOT pick up edits under apps/server/web. Run `bun run dev --cwd apps/server/web` first for that.",
      );
    }
  }
  const proc = Bun.spawn(["bun", "run", "--cwd", `apps/${app.dir}`, "dev:app"], {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });
  return await proc.exited;
}

function usage(): never {
  const names = APPS.map((a) => `dev:desktop-${a.id}`).join(" | ");
  console.error(`usage: bun run ${names} [--force] [--check]`);
  console.error("  --force  rebuild the CLI even when nothing under its workspaces has changed");
  console.error("  --check  build, stage and refresh as usual, then stop instead of launching the app");
  process.exit(2);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
/** Everything except the launch — what is this about to run, without opening a window. */
const checkOnly = args.includes("--check");
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

if (checkOnly) process.exit(0);
process.exit(await runDev(app));
