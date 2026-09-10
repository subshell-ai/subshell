import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASE_URL, FAKE_REGISTRY_URL, PORTS } from "./ports";

const ROOT = path.join(import.meta.dirname, "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const STUB_PI = path.join(ROOT, "e2e", "stub", "pi");
const FAKE_REGISTRY = path.join(ROOT, "e2e", "fake-registry.ts");

interface Stack {
  dir: string;
  /** Scratch `TMUX_TMPDIR` — separate from `dir`, see {@link shortTmuxBase}. */
  tmuxBase: string;
  child?: ReturnType<typeof spawn>;
  /** The fake plugin-registry bun child (fake-registry.ts); see {@link startStack}. */
  fake?: ReturnType<typeof spawn>;
}

/**
 * A unix domain socket path cannot exceed the kernel's `sun_path` field —
 * 104 bytes on macOS, 108 on Linux — and tmux expands `-L <name>` to
 * `$TMUX_TMPDIR/tmux-<uid>/<name>`, so the base directory has to leave room
 * for roughly 31 more characters.
 *
 * `os.tmpdir()` cannot: on macOS it is a per-user `/var/folders/...` path that
 * the kernel resolves with a `/private` prefix, and
 * `/private/var/folders/18/<44 chars>/T/subshell-e2e-XXXXXX/tmux/tmux-501/subshell-<12 hex>`
 * measures 112 bytes. Every subshell create then failed with tmux's
 * "File name too long", surfaced to the browser as a bare `API 500` — six
 * specs, all of which looked like terminal regressions and were not.
 *
 * So the tmux base gets its own short root while the DB, data dir and logs
 * stay in the regular scratch dir where their length does not matter.
 */
export function shortTmuxBase(): string {
  const base = mkdtempSync(path.join("/tmp", "ss-e2e-"));
  return path.join(base, "t");
}

declare global {
  var e2eStack: Stack | undefined;
}

/** Polls the unauthenticated setup-status endpoint until it answers. */
async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/setup/status`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`[e2e] backend did not become ready at ${BASE_URL} within ${timeoutMs}ms`);
}

/**
 * Polls the fake registry's packument until it answers, so spec 14 never
 * races `bun pm pack`. If the child died (a bad fixture, port 3198 already
 * held by a leaked run), the poll says what to look at rather than timing out
 * silently.
 */
async function waitForFakeRegistry(fake: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fake.exitCode !== null || fake.signalCode !== null) {
      throw new Error(
        `[e2e] fake registry exited (${fake.exitCode ?? fake.signalCode}) — run \`bun e2e/fake-registry.ts\` to see why`,
      );
    }
    try {
      const res = await fetch(`${FAKE_REGISTRY_URL}/e2e-demo`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`[e2e] fake registry did not become ready at ${FAKE_REGISTRY_URL} within ${timeoutMs}ms`);
}

/**
 * Boots the real backend against scratch state: temp file DB, temp subshell
 * data dir, and the `pi` stub as the only harness binary. `detached` puts it in its
 * own process group so teardown can kill the whole tree (bun forks; killing
 * only the parent leaves the server holding the port).
 */
export async function startStack(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-"));
  chmodSync(STUB_PI, 0o755);
  // tmux only honours TMUX_TMPDIR when the directory already exists (it does
  // not mkdir the base itself on this build), so create it before the backend
  // could ever spawn a server.
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });

  // The fake plugin registry first (fake-registry.ts): it packs the fixture
  // synchronously before listening, so by the time the backend is up and any
  // spec installs, the bytes are already served. A plain (non-detached)
  // child — it holds nothing but a port, and teardown kills it by pid.
  const fake = spawn("bun", [FAKE_REGISTRY, String(PORTS.fakeRegistry)], {
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
  });

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env: {
      ...process.env,
      // IS_TEST keys off NODE_ENV/SUBSHELL_TEST_MODE and would force the shared
      // in-memory DB; the stack must run like production instead. Pin both
      // explicitly — `...process.env` above could otherwise carry an ambient
      // SUBSHELL_TEST_MODE=true from the developer's shell and silently drop the
      // suite from its file DB to in-memory (which is also pristine, so no
      // spec would notice).
      NODE_ENV: "development",
      SUBSHELL_TEST_MODE: "false",
      // The scratch dir contains no config.env — so the backend can't pick up
      // a developer's real one. Since 2026-09-07 the boot path APPLIES that
      // layer (constants.ts, before dotenvx), and SETDEFAULT semantics only
      // protect keys this block sets explicitly; anything else a developer's
      // ~/.config/subshell-server/config.env happens to carry
      // (SUBSHELL_EMERGENCY_PASSWORD, TRUSTED_ORIGINS, …) would leak in.
      SUBSHELL_SERVER_CONFIG_DIR: dir,
      SERVER_PORT: String(PORTS.backend),
      HOST: "127.0.0.1",
      DATABASE_PATH: path.join(dir, "subshell.db"),
      SUBSHELL_SERVER_DATA_DIR: path.join(dir, "data"),
      APP_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
      // Detection re-probes per request, so the stub appears as installed.
      PI_PATH: STUB_PI,
      // Plugin installs on `local` fetch from the fake registry (fake-registry.ts,
      // spawned below) — never the public one. A registry-absent run would
      // otherwise fall through to the https://registry.npmjs.org default and put
      // the suite on the open network.
      SUBSHELL_PLUGIN_REGISTRY_URL: FAKE_REGISTRY_URL,
      // `tmux -L <name>` resolves its socket path to $TMUX_TMPDIR/tmux-<uid>/
      // <name>, so pointing TMUX_TMPDIR at the scratch dir makes EVERY tmux
      // server this run spawns (specs 05/06 start real subshells) addressable
      // inside it — stopStack kills them by socket instead of leaking
      // daemonised servers forever: the tmux server detaches away from the
      // backend's process group, so the group SIGTERM below never reaches it.
      // The backend's own tmux calls inherit this env (tmux-runner passes no
      // explicit env to spawnSync), so no backend change is needed.
      TMUX_TMPDIR: tmuxBase,
    },
  });
  child.unref();

  globalThis.e2eStack = { dir, tmuxBase, child, fake };
  await Promise.all([waitForReady(), waitForFakeRegistry(fake)]);

  // Warm the per-request harness detection: on a host where the real
  // claude/opencode/hermes CLIs exist, their first `--version` probe can
  // take seconds (cold Node startup), and the wizard spec's default
  // timeouts would race it. Result unused — this just pays the cold cost
  // at boot instead of mid-test.
  try {
    await fetch(`${BASE_URL}/api/setup/harnesses`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    // Best-effort warm-up; the specs themselves will surface a real failure.
  }
}

/** readdirSync that yields [] instead of throwing on a missing/odd entry. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Kills every tmux server whose socket lives under the run's scratch TMUX
 * dir (`<tmuxBase>/tmux-<uid>/<socket>`, see startStack). `kill-server`
 * tears down the daemon plus its pane processes (stub-`pi` loops) and its
 * `pipe-pane` log shims. Sockets belonging to already-dead servers just make
 * tmux exit non-zero, which is ignored per-socket.
 */
function killScratchTmuxServers(base: string): void {
  for (const uidDir of readdirSafe(base)) {
    for (const socket of readdirSafe(path.join(base, uidDir))) {
      try {
        spawnSync("tmux", ["-S", path.join(base, uidDir, socket), "kill-server"]);
      } catch {
        // Best-effort: an unkillable socket must not abort teardown.
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until NO process is left in group `pgid` (signal-0 probe), or capMs
 * elapses. Deliberately NOT `child.once("exit")`: the child is unref'd and
 * has no stdio pipes, so under Playwright's globalTeardown the 'exit' event
 * can sit undelivered while the event loop drains — the process then exits
 * (code 0!) mid-teardown, skipping everything after the await. An awaited
 * sleep keeps a ref'd handle pending and guarantees the wait completes.
 */
async function waitForGroupExit(pgid: number, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0); // throws ESRCH once the group is empty
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

export async function stopStack(): Promise<void> {
  const stack = globalThis.e2eStack;
  if (stack) {
    // The fake registry is a direct child with one process and no children of
    // its own (`bun pm pack` finished before it started listening), so a
    // plain kill by pid retires the port — the next run's Bun.serve would
    // fail on a leaked listener, which is the loud version of this bug.
    try {
      stack.fake?.kill();
    } catch {
      // Already dead.
    }

    // Tmux servers FIRST: they escaped the backend's process group when they
    // daemonised, so the group SIGTERM below cannot reach them and they must
    // die while their sockets are still enumerable under the scratch dir.
    killScratchTmuxServers(stack.tmuxBase);

    const child = stack.child;
    if (child?.pid) {
      const pgid = child.pid; // detached → the child IS the process-group leader
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // Already dead.
      }
      // Wait for the group to actually exit before wiping the scratch dir
      // (a SIGTERM'd bun mid-shutdown could still hold DB/log files open);
      // escalate to SIGKILL if it stalls.
      if (!(await waitForGroupExit(pgid, 5_000))) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already dead.
        }
        await waitForGroupExit(pgid, 2_000);
      }
    }
    rmSync(stack.dir, { recursive: true, force: true });
    // The tmux base has its own short root (see shortTmuxBase), so it is
    // not swept by the line above; remove that root, not just the leaf.
    rmSync(path.dirname(stack.tmuxBase), { recursive: true, force: true });
  }
  globalThis.e2eStack = undefined;
}
