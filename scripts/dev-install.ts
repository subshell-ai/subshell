/**
 * `bun run dev:install server|node|all` — compile a workspace's single-file
 * CLI and put it where the real one lives (`~/.local/bin`), so a branch
 * under test answers the ordinary command.
 *
 * **Why a script.** Trying a CLI change means running the COMPILED artifact
 * from a normal shell, and doing it by hand is three steps with two traps:
 * forgetting `compile` tests the tsc output, not the bundle, and a plain
 * `cp` onto the live path dies with "text file busy" whenever the thing it
 * names is RUNNING. This script compiles, then swaps the way the product's
 * own update does: write next to the target, then ONE rename. A running
 * process keeps its old inode (which is why the line at the end says to
 * restart); a crash between the two leaves a stray `.dev-tmp`, never a
 * half-written binary on the live path.
 *
 * A developer tool, not a product surface: it names no consent and refuses
 * nothing beyond the usage. The verbs stay symmetric with the desktop dev
 * scripts (`dev:desktop-server`, `dev:desktop-client`).
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Target {
  /** The package whose `compile` script builds the binary. */
  pkg: string;
  /** The compiled single file, relative to the repo root. */
  dist: string;
  /** The live-name it installs as under `~/.local/bin`. */
  name: string;
}

const TARGETS: Record<string, Target> = {
  server: { pkg: "apps/server/api", dist: "apps/server/api/dist/subshell-server", name: "subshell-server" },
  node: { pkg: "apps/node/agent", dist: "apps/node/agent/dist/subshell", name: "subshell" },
};

const root = process.cwd();
const arg = process.argv[2];
if (!arg || !(arg in TARGETS || arg === "all")) {
  console.error(`usage: bun run dev:install ${Object.keys(TARGETS).join("|")}|all`);
  process.exit(1);
}

const binDir = join(homedir(), ".local", "bin");
mkdirSync(binDir, { recursive: true });

for (const key of arg === "all" ? Object.keys(TARGETS) : [arg]) {
  const target = TARGETS[key];
  const compile = Bun.spawnSync({ cmd: ["bun", "run", "compile"], cwd: join(root, target.pkg), stdout: "inherit", stderr: "inherit" });
  if (compile.exitCode !== 0) {
    console.error(`dev-install: ${target.pkg} compile failed (exit ${compile.exitCode}); nothing was copied`);
    process.exit(1);
  }
  const built = join(root, target.dist);
  if (!existsSync(built)) {
    console.error(`dev-install: compile reported success but ${target.dist} is not there; refusing to copy`);
    process.exit(1);
  }
  const live = join(binDir, target.name);
  const staged = `${live}.dev-tmp`;
  rmSync(staged, { force: true });
  copyFileSync(built, staged);
  // One rename, like the product's own swapper: cp onto a RUNNING binary is
  // ETXTBSY; rename replaces the directory entry and the live process keeps
  // the inode it opened.
  renameSync(staged, live);
  const probe = Bun.spawnSync({ cmd: [live, "version"], stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    console.error(`dev-install: ${live} does not answer \`version\`; the swap happened anyway, do not trust it`);
    process.exit(1);
  }
  console.log(`installed ${probe.stdout.toString().trim() || live} -> ${live} (from ${target.dist})`);
  console.log(`  a running copy keeps its old binary until you restart it`);
}
