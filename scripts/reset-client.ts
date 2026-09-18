/**
 * `bun run reset:client` — put this machine back to one that has never run
 * Subshell Client or been enrolled as a node, so the client app's first-run
 * assistant can be exercised from the top.
 *
 * The developer mirror of `reset:desktop`, and deliberately the same shape:
 * stop the supervision FIRST, then delete. **This is not the app's own reset**
 * (`node_reset`, spec §5.4). That one is a product feature: it asks for the
 * hostname as consent, spares the installed agent binary, and refuses when the
 * agent cannot report its paths. This is a developer tool and goes further —
 * it removes `~/.local/bin/subshell` too, so the assistant's INSTALL-AGENT step
 * runs rather than being skipped.
 *
 * Paths come from `subshell status --json` when the agent binary is there to
 * ask — including when it reports OFFLINE (status exits non-zero yet still
 * names its config, lock, data dir and binary), which is the ordinary state of
 * a dev machine between runs. The platform defaults stand in when it is not;
 * every node-agent path lives under `~/.config/subshell`, so that tree goes
 * wholesale regardless of what the CLI can answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** The node agent's whole home: config.json, daemon.lock, data/, logs/. */
const CLIENT_HOME = join(homedir(), ".config", "subshell");
/** The managed agent copy the client app installs and every ladder rung ends at. */
const INSTALLED_BINARY = join(homedir(), ".local", "bin", "subshell");

/**
 * The client desktop app's settings home — NOT the agent's (`~/.config/subshell`),
 * deliberately. The `subshell-desktop-client` dir is the app's own; the agent
 * keeps its state one word shorter (AGENTS.md: two programs' state in one
 * directory is the collision the `subshell-desktop-` prefix exists to avoid).
 */
function appSettingsDir(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "dev.subshell.client")
    : join(homedir(), ".config", "subshell-desktop-client");
}

/** The agent's per-user service definition, wherever this platform keeps it. */
function serviceDefinition(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "LaunchAgents", "dev.subshell.client.plist")
    : join(homedir(), ".config", "systemd", "user", "subshell.service");
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
 * Ask the installed agent what it owns, tolerating a non-zero exit.
 *
 * `subshell status --json` exits 1 when the daemon is OFFLINE yet still prints
 * the paths object — and OFFLINE is the normal state of a dev machine with an
 * enrolled-but-unrun node, exactly the case this most needs to answer. So a
 * thrown non-zero exit is read from `error.stdout`, not discarded; only a
 * missing binary or unparseable output yields null.
 */
function statusJson(): { paths?: Record<string, unknown> } | null {
  let out: string | null;
  try {
    out = execFileSync(INSTALLED_BINARY, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    out = typeof stdout === "string" ? stdout : null;
  }
  if (out === null) return null;
  try {
    return JSON.parse(out) as { paths?: Record<string, unknown> };
  } catch {
    return null;
  }
}

/** One string path from the `paths` block, or null (absent, empty, or a null binary). */
function pathOf(paths: Record<string, unknown> | undefined, key: string): string | null {
  const value = paths?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Stop the agent and the app before their files go.
 *
 * Order is load-bearing, exactly as in `reset-desktop.ts`: a launchd agent or
 * systemd unit still loaded when its home is gone respawns the daemon against a
 * missing config, and the machine comes back neither reset nor working. The
 * foreground agent (`subshell run`) is killed too, else it rewrites the lock
 * between the deletion and the next launch.
 *
 * The dev binary is matched as `…/target/debug/subshell-desktop-client`,
 * anchored at the END so it can never match the SERVER app's
 * `…/subshell-desktop` (a running server dev session is not this script's to
 * kill).
 */
function stopEverything(): void {
  quiet(["pkill", "-f", "desktop-dev.ts client"]);
  quiet(["pkill", "-f", join("target", "debug", "subshell-desktop-client")]);
  quiet(["pkill", "-f", "subshell run"]);
  if (platform() === "darwin") {
    quiet(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/dev.subshell.client`]);
  } else {
    quiet(["systemctl", "--user", "disable", "--now", "subshell.service"]);
  }
}

/**
 * Every path this reset removes, deduped.
 *
 * The defaults go unconditionally — `CLIENT_HOME` nukes config, lock, the
 * default `data/` dir and the agent log in one shot, which is what a machine
 * with no agent installed to ask still needs. The `status --json` paths are
 * added on top so a data dir or binary that lives OUTSIDE the defaults (a
 * `--data-dir` at enroll, an update that installed elsewhere) is named by the
 * agent rather than left behind — a "reset" machine still onboarded is the
 * half-state this script exists to prevent.
 */
function targets(): string[] {
  const paths = statusJson()?.paths;
  const set = new Set<string>([CLIENT_HOME, INSTALLED_BINARY, appSettingsDir(), serviceDefinition()]);
  for (const key of ["configFile", "lockFile", "dataDir", "binary"]) {
    const p = pathOf(paths, key);
    if (p) set.add(p);
  }
  return [...set];
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
  // app: tmux is a system package a machine may want for its own reasons, and
  // the agent runs its panes under it. Uninstalling does not kill tmux servers
  // already running, so panes from before this survive, unattachable until it
  // is back. Same flag, same behavior as `reset:desktop --tmux`.
  const removed = quiet(["brew", "uninstall", "tmux"]) !== null;
  console.log(removed ? "removed  tmux (brew)" : "absent   tmux (brew had none)");
}

console.log(
  `\nThis machine now looks like one that has never run Subshell Client.` +
    `\nStart the app to re-enroll it: bun run dev:desktop-client` +
    (withTmux ? "" : `\nPass --tmux to remove tmux as well, which the agent runs panes under.`),
);
