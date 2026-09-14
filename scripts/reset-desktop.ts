/**
 * `bun run reset:desktop` — put this machine back to a machine that has never
 * run Subshell Server, so the first-run assistant can be exercised from the
 * top.
 *
 * **Why a script and not a paragraph in AGENTS.md.** Testing the FTE means
 * doing this repeatedly, and doing it by hand means remembering five paths
 * across two platforms plus a service that has to be unloaded BEFORE its
 * files go — miss that and launchd respawns a server against a data
 * directory that is no longer there. It was got wrong by hand during the
 * 2026-09-14 FTE work, which is why it is a command now.
 *
 * **This is not the app's own reset** (`desktop_reset`, spec § 7.1). That one
 * is a product feature: it asks for the hostname as consent, refuses when the
 * server cannot report its paths, and deliberately spares the installed
 * binary. This is a developer tool and goes further — the binary too, so the
 * assistant's INSTALL step runs rather than being skipped.
 *
 * Paths come from `status --json` when a server binary is there to ask, and
 * from the platform defaults when it is not — which is the ordinary case on
 * the second run of this script.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Where the server CLI keeps its data, per `apps/server/api/src/config-env.ts`. */
const DEFAULT_DATA_DIR = join(homedir(), ".config", "subshell-server");
/** The managed copy the desktop app installs and every ladder rung ends at. */
const INSTALLED_BINARY = join(homedir(), ".local", "bin", "subshell-server");

/**
 * The desktop app's settings home — NOT the CLI's, deliberately (AGENTS.md:
 * two different programs' state in one directory is the collision the
 * `subshell-desktop-` prefix exists to avoid).
 */
function appSettingsDir(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "dev.subshell.server")
    : join(homedir(), ".config", "subshell-desktop-server");
}

/** Quietly run a command; a failure is never fatal here. */
function quiet(argv: string[]): string | null {
  try {
    return execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * The data directory this machine actually uses.
 *
 * Asked of the server rather than assumed, because `SUBSHELL_SERVER_DATA_DIR`
 * and a hand-written config.env can both move it, and deleting the default
 * while the real one survives would leave a "reset" machine that is still
 * onboarded — the confusing half-state this script exists to prevent.
 */
function dataDir(): string {
  if (!existsSync(INSTALLED_BINARY)) return DEFAULT_DATA_DIR;
  const out = quiet([INSTALLED_BINARY, "status", "--json"]);
  if (out === null) return DEFAULT_DATA_DIR;
  try {
    const parsed = JSON.parse(out) as { paths?: { dataDir?: unknown } };
    const found = parsed.paths?.dataDir;
    return typeof found === "string" && found.length > 0 ? found : DEFAULT_DATA_DIR;
  } catch {
    return DEFAULT_DATA_DIR;
  }
}

/**
 * Stop the service FIRST, and the app with it.
 *
 * Order is load-bearing: a launchd agent still loaded when its data directory
 * goes will respawn the server against a database that no longer exists, and
 * the machine comes back neither reset nor working (measured — the server log
 * filled with `SQLITE_IOERR_VNODE` for exactly this reason).
 */
function stopEverything(): void {
  quiet(["pkill", "-f", "desktop-dev.ts server"]);
  quiet(["pkill", "-f", "target/debug/subshell-desktop"]);
  if (platform() === "darwin") {
    quiet(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/dev.subshell.server`]);
  } else {
    quiet(["systemctl", "--user", "disable", "--now", "subshell-server.service"]);
  }
}

/** Every path this reset removes, in the order it removes them. */
function targets(): string[] {
  const paths = [dataDir(), INSTALLED_BINARY, appSettingsDir()];
  paths.push(
    platform() === "darwin"
      ? join(homedir(), "Library", "LaunchAgents", "dev.subshell.server.plist")
      : join(homedir(), ".config", "systemd", "user", "subshell-server.service"),
  );
  return paths;
}

const withTmux = process.argv.includes("--tmux");

stopEverything();
for (const path of targets()) {
  const existed = existsSync(path);
  rmSync(path, { recursive: true, force: true });
  console.log(`${existed ? "removed" : "absent "}  ${path}`);
}

if (withTmux) {
  // Behind a flag because it is the one thing here that reaches OUTSIDE this
  // app: tmux is a system package a machine may want for its own reasons.
  // Uninstalling does not kill tmux servers already running — a removed
  // binary does not touch a live process — so panes from before this survive,
  // unattachable until it is back.
  const removed = quiet(["brew", "uninstall", "tmux"]) !== null;
  console.log(removed ? "removed  tmux (brew)" : "absent   tmux (brew had none)");
}

console.log(
  `\nThis machine now looks like one that has never run Subshell Server.${
    withTmux ? "" : "\nPass --tmux to remove tmux as well, so the assistant's install step runs."
  }\nStart the assistant with: bun run dev:desktop-server`,
);
