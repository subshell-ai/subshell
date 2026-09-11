/**
 * `bun run dev:desktop-server` / `bun run dev:desktop-client` — launch a Tauri
 * desktop app in dev mode from the repo root, staging its sidecar first if the
 * host does not have one yet.
 *
 * **Why this is not a two-line proxy to `bun run --cwd <app> dev:app`.**
 * `tauri-build` refuses to build when an `externalBin` path is missing, and
 * `src-tauri/binaries/*` is a gitignored ~110 MB build input. So on a clean
 * checkout a bare `tauri dev` dies inside a build script with
 * `resource path … doesn't exist`, naming a file the reader has never heard of
 * and no way to produce it. Staging it by hand is a four-command dance
 * documented in `apps/server/desktop/AGENTS.md`. This script is that dance,
 * run only when it is needed.
 *
 * Each app already knows how to build and stage the CLI it wraps — that is its
 * release pipeline's `stageSidecar`, which is what a release uses and what the
 * bundle smoke proves. This imports the SAME function rather than reimplementing
 * it, so a dev sidecar and a released one can never be produced two different
 * ways.
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
import { statSync } from "node:fs";
import { join } from "node:path";
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
  /** Build and stage that binary for one target. Each app's own release pipeline. */
  stage: (target: string) => Promise<boolean>;
  /** What the first-run build is actually doing, for the line printed before it. */
  builds: string;
}

const APPS: readonly DesktopApp[] = [
  {
    id: "server",
    dir: "server/desktop",
    sidecar: SERVER_SIDECAR_NAME,
    stage: (target) => stageServerSidecar(SERVER_DEPS, target),
    builds: "the subshell-server CLI, with the SPA embedded",
  },
  {
    id: "client",
    dir: "client/desktop",
    sidecar: AGENT_SIDECAR_NAME,
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

/** `tauri dev` for one app, inheriting stdio so its output and Ctrl-C behave. */
async function runDev(app: DesktopApp): Promise<number> {
  const proc = Bun.spawn(["bun", "run", "--cwd", `apps/${app.dir}`, "dev:app"], {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

function usage(): never {
  const names = APPS.map((a) => `dev:desktop-${a.id}`).join(" | ");
  console.error(`usage: bun run ${names}`);
  process.exit(2);
}

const requested = process.argv[2];
const app = APPS.find((a) => a.id === requested);
if (!app) usage();

const target = hostTarget();
if (target === null) {
  console.error(
    `The desktop apps are built for ${DESKTOP_TARGETS.join(" and ")} only, and this is ${process.platform}-${process.arch}.`,
  );
  process.exit(1);
}

const staged = join(REPO_ROOT, "apps", app.dir, "src-tauri", "binaries", desktopSidecarFileName(app.sidecar, target));

if (!isStaged(staged)) {
  console.log(`No sidecar staged for ${target}. This first builds ${app.builds}, which takes a few minutes.`);
  console.log("It is cached afterwards, so later runs of this command start straight away.\n");
  if (!(await app.stage(target))) {
    console.error(`\nCould not stage the sidecar for ${target}. The build output above says why.`);
    process.exit(1);
  }
  console.log(`\nStaged ${desktopSidecarFileName(app.sidecar, target)}.\n`);
}

process.exit(await runDev(app));
