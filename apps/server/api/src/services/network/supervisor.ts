import { basename, isAbsolute } from "node:path";
import { stripAnsi } from "@internal/backend-errors";
import { childEnv, loginPathEntries, type SupervisedProcessSpec, secretPath } from "@internal/pane-runtime";
import { IS_TEST, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The host's supervisor for the long-running children network plugins
 * describe but never spawn.
 *
 * Three properties fall out of the host owning the handle rather than the
 * plugin, and each is why this module exists instead of a plugin calling
 * `Bun.spawn` itself:
 *
 * - **Disabling a plugin is a real stop.** The process is ours, so it dies
 *   when we say so, including at shutdown — a plugin holding its own child
 *   could only be asked.
 * - **A credential reaches a child without ever being an argv element.** The
 *   plugin NAMES a secret; this module substitutes the 0600 file's path into
 *   the argv, or its value into the child's environment. `ps` output on this
 *   host shows a path, never a token — which is the one exposure the pane
 *   argv already has and that this deliberately does not repeat.
 * - **A crash loop is bounded and visible.** Backoff, a park after a loop that
 *   will not settle, and the last lines the child printed, all reported to the
 *   page rather than buried in a journal.
 *
 * It supervises AT MOST ONE child per plugin id. Two would be two tunnels
 * competing for the same publish.
 */

/** Restart delay for the first failure; doubles per consecutive failure. */
const BASE_BACKOFF_MS = 1_000;

/** Ceiling on the backoff. A machine whose network is down is checked once a minute, not faster. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Uptime that counts as "this one worked": the backoff and the crash-loop
 * window are both reset after it.
 *
 * Without the reset, a process restarted once a day would reach the minute
 * ceiling and the park threshold over a long-lived instance, which would
 * describe a healthy machine as a crash loop.
 */
const UPTIME_RESET_MS = 5 * 60 * 1000;

/** Window the restart count is measured over. */
const LOOP_WINDOW_MS = 10 * 60 * 1000;

/** Restarts inside {@link LOOP_WINDOW_MS} that are still tolerated; the next one parks. */
const MAX_RESTARTS_IN_WINDOW = 10;

/** How long a child gets to exit on SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5_000;

/** Lines kept from a child's output. Enough to carry a vendor CLI's reason; short enough to render. */
const MAX_LINES = 20;

/** Commands that would ask for a password this process has no terminal to answer. */
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas", "pkexec"]);

/**
 * What a child a plugin asked for is doing, as the page renders it.
 *
 * **`running` means READY, not alive**, and the pair with `pid` is how the two
 * are told apart: `pid` set with `running: false` is a process that has
 * started and not yet matched its `readyPattern`. Modelled that way rather
 * than with a third word because the question every caller asks is "is the
 * publish holding", and a tunnel that has not announced itself is not holding
 * — reporting it as running would make the page lie during the exact seconds
 * an operator is watching it. A spec with no `readyPattern` is ready when it
 * is alive, since nothing else could ever say so.
 */
export interface SupervisorState {
  /** True once the child is up AND (if it declared a `readyPattern`) has matched it. */
  running: boolean;
  /** The live child's pid. Present whenever a process exists, ready or not. */
  pid?: number;
  /** ISO 8601 stamp of the current child's spawn. */
  since?: string;
  /** How many times this entry has been respawned since it was armed. */
  restarts: number;
  /** How the previous child ended, or why one was never started. `code: null` = signalled or never spawned. */
  lastExit?: { code: number | null; at: string };
  /** Up to {@link MAX_LINES} lines the child printed, ANSI stripped, oldest first. */
  lastLines: string[];
}

/** One spawned child, as this module drives it. */
export interface SupervisedChild {
  /** OS pid, or undefined when the runtime could not report one. */
  pid: number | undefined;
  /** Resolves with the exit code when the child is REAPED; null when it was signalled. */
  exited: Promise<number | null>;
  /** Signals the child. Never throws — a child that has already gone is the outcome the caller wanted. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

/** What {@link SupervisorDeps.spawn} is asked for. */
export interface SpawnInput {
  /** Fully resolved argv, secret file paths already substituted. */
  argv: string[];
  /** Fully resolved environment, secret values already hydrated. */
  env: Record<string, string>;
  /** Called per output line, ANSI stripped, stdout and stderr interleaved. */
  onLine: (line: string) => void;
}

/**
 * The seams a test replaces, so a suite drives the whole state machine without
 * spawning anything, waiting a real second, or writing a real credential.
 */
export interface SupervisorDeps {
  /** Starts one child. Production: `Bun.spawn` with piped output. */
  spawn(input: SpawnInput): SupervisedChild;
  /** Absolute path of a stored secret, or null when it is not set. */
  secretFile(pluginId: string, name: string): Promise<string | null>;
  /** Value of a stored secret, for `secretEnv`, or null when it is not set. */
  secretValue(pluginId: string, name: string): Promise<string | null>;
  /** Directories appended to PATH. Production: the login-shell probe. */
  extraPath(): Promise<string[]>;
  /** Wall clock, for uptime and the crash-loop window. */
  now(): number;
  /** Delay, for the backoff and the SIGTERM grace. */
  delay(ms: number): Promise<void>;
}

/** Production spawn: a piped child whose lines are pumped to the sink as they arrive. */
function spawnChild(input: SpawnInput): SupervisedChild {
  const proc = Bun.spawn(input.argv, {
    // No stdin: there is no terminal behind this, so a child that prompts must
    // find EOF rather than wait forever holding the publish open.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: input.env,
  });
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) input.onLine(line);
      }
    } catch {
      /* the child went away mid-read; its exit is reported by `exited` */
    }
    if (pending.trim() !== "") input.onLine(pending);
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  return {
    pid: proc.pid,
    // A signalled child reports a signal rather than a code, and reporting
    // that code would say "it failed with 143" about a stop we asked for.
    exited: proc.exited.then((code) => (proc.signalCode ? null : code)),
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
}

const defaultDeps: SupervisorDeps = {
  spawn: spawnChild,
  secretFile: async (pluginId, name) => {
    try {
      const path = secretPath(SUBSHELL_SERVER_DATA_DIR, pluginId, name);
      return (await Bun.file(path).exists()) ? path : null;
    } catch {
      // Not a usable secret name. Indistinguishable from unset for every
      // caller here, and the refusal that follows names the secret.
      return null;
    }
  },
  secretValue: async (pluginId, name) => {
    try {
      const file = Bun.file(secretPath(SUBSHELL_SERVER_DATA_DIR, pluginId, name));
      return (await file.exists()) ? await file.text() : null;
    } catch {
      return null;
    }
  },
  extraPath: loginPathEntries,
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let depsOverride: SupervisorDeps | undefined;

/**
 * Test seam: swap spawning, the secret store, PATH and the clock. Refuses
 * outside the suite, like every other seam here — a mis-wired production
 * import must not be able to redirect what this host runs.
 * @internal
 */
export function setSupervisorDepsForTests(deps: SupervisorDeps | null): void {
  if (!IS_TEST) throw new Error("setSupervisorDepsForTests is a test-only seam");
  // Every live run loop is invalidated BEFORE the map is dropped. Clearing
  // alone would leave loops holding their own entry objects, still matching
  // their generation, and the next respawn would reach the swapped deps — in
  // the teardown case, the real `Bun.spawn`.
  for (const entry of entries.values()) entry.generation++;
  entries.clear();
  depsOverride = deps ?? undefined;
}

function deps(): SupervisorDeps {
  return depsOverride ?? defaultDeps;
}

/** One plugin's supervised child, and everything the loop driving it needs. */
interface Entry {
  spec: SupervisedProcessSpec;
  state: SupervisorState;
  child: SupervisedChild | null;
  /**
   * Bumped by every arm and disarm.
   *
   * The run loop captures it and exits the moment it no longer matches, which
   * is what makes a disarm during a backoff sleep (or a re-arm with a changed
   * spec) take effect rather than being overwritten by the loop it replaced.
   */
  generation: number;
  /** Consecutive failed starts, for the backoff exponent. */
  attempt: number;
  /** Restart stamps inside {@link LOOP_WINDOW_MS}. */
  recent: number[];
  /** True once the crash-loop threshold parked it: no more respawns, the row stays. */
  parked: boolean;
  /** Serializes arm/disarm for this plugin, so two calls cannot interleave their spawns. */
  queue: Promise<unknown>;
  /** Compiled `readyPattern`, or null when the spec declared none (or an invalid one). */
  readyRe: RegExp | null;
  /** `now()` at the current child's spawn, for the uptime reset. */
  startedAt: number;
}

/** Every plugin this process is supervising, armed or parked. */
const entries = new Map<string, Entry>();

/** Appends a line to the ring, oldest first, capped. */
function pushLine(state: SupervisorState, line: string): void {
  state.lastLines.push(stripAnsi(line));
  if (state.lastLines.length > MAX_LINES) state.lastLines.splice(0, state.lastLines.length - MAX_LINES);
}

/**
 * Whether two specs describe the same child.
 *
 * Structural, over every field that reaches the spawn — including
 * `readyPattern`, which decides when the host calls the publish up and is
 * therefore behaviour rather than presentation. Compared as JSON because these
 * are plain data by contract; a plugin that put a function in one has already
 * failed the load.
 */
function sameSpec(a: SupervisedProcessSpec, b: SupervisedProcessSpec): boolean {
  const key = (s: SupervisedProcessSpec): string =>
    JSON.stringify([
      s.command,
      s.args,
      sortedEntries(s.env),
      sortedEntries(s.secretFileArgs),
      sortedEntries(s.secretEnv),
      s.readyPattern ?? null,
    ]);
  return key(a) === key(b);
}

/** Key order in a record is not meaningful; sorting keeps it from looking like a change. */
function sortedEntries(record: Record<string, string> | undefined): [string, string][] {
  return Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Why this spec will not be run, or null when it may be.
 *
 * Both refusals are about what the host is willing to become. An absolute path
 * is required because a bare name would be resolved against a PATH this module
 * builds — so a plugin could name `tailscaled` and get whichever one a
 * prepended directory offered; `PluginHost.findBinary` is where a plugin turns
 * a name into a path, under the host's own lookup rules. A privilege wrapper is
 * refused because this process has no terminal to answer a password prompt, so
 * the honest outcomes are "hangs until killed" and "silently does nothing" —
 * a plugin needing root describes it as a privileged step for a human to copy.
 */
function refusal(spec: SupervisedProcessSpec): string | null {
  if (!isAbsolute(spec.command)) {
    return `refusing to supervise "${spec.command}": the command must be an absolute path`;
  }
  if (PRIVILEGE_WRAPPERS.has(basename(spec.command))) {
    return `refusing to supervise "${spec.command}": the server cannot answer a password prompt, so a privileged step is printed for an operator to run`;
  }
  return null;
}

/**
 * Arms a plugin's supervised child, or re-arms it when the spec changed.
 *
 * Synchronous and returning nothing, because every caller is boot or a route
 * that has already decided: the spawn itself, the secret lookups and the PATH
 * probe are asynchronous and run behind this call. What the caller can rely on
 * is that {@link processState} answers for this id from the moment it returns.
 *
 * Idempotent on an unchanged spec — boot and a re-publish arm the same
 * description, and restarting a working tunnel because someone reloaded a page
 * is an outage nobody asked for. A CHANGED spec is a stop and a start, in that
 * order, because the two children would otherwise compete for one publish.
 * @param pluginId - whose child this is; one per plugin
 * @param spec - what the plugin asked the host to run
 */
export function armProcess(pluginId: string, spec: SupervisedProcessSpec): void {
  const existing = entries.get(pluginId);
  // A parked entry re-arms on ANY call, changed spec or not: parking is the
  // host giving up, and an operator asking again is what clears it.
  if (existing && !existing.parked && sameSpec(existing.spec, spec)) return;

  const entry: Entry = existing ?? {
    spec,
    state: { running: false, restarts: 0, lastLines: [] },
    child: null,
    generation: 0,
    attempt: 0,
    recent: [],
    parked: false,
    queue: Promise.resolve(),
    readyRe: null,
    startedAt: 0,
  };
  entry.spec = spec;
  entry.parked = false;
  entry.attempt = 0;
  entry.recent = [];
  entry.readyRe = compileReady(spec.readyPattern, entry.state);
  entries.set(pluginId, entry);

  const generation = ++entry.generation;
  const start = async (): Promise<void> => {
    // A previous child belongs to a previous generation and must be reaped
    // before this one starts, or two daemons hold the same publish.
    if (existing) await stopChild(entry);
    // Deliberately NOT awaited into the queue: the loop below runs for the
    // life of the arm, and a queue that held it would make every later arm or
    // disarm wait for a process that is supposed to keep running.
    void run(pluginId, entry, generation);
  };
  entry.queue = entry.queue.then(start, start);
}

/** Compiles a ready pattern, reporting a bad one instead of throwing into a boot. */
function compileReady(pattern: string | undefined, state: SupervisorState): RegExp | null {
  if (pattern === undefined) return null;
  try {
    return new RegExp(pattern);
  } catch (err) {
    // The publish is not worth refusing over this: the honest fallback is
    // "ready when alive", said out loud on the row that renders it.
    pushLine(state, `ignoring readyPattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Runs one plugin's child until it is disarmed, parked, or refused.
 *
 * The loop is the state machine: start, wait, account for the exit, back off,
 * start again. Every await re-checks the generation, because a disarm can land
 * during any of them and a loop that outlived its arming would respawn a child
 * the caller believes is gone.
 */
async function run(pluginId: string, entry: Entry, generation: number): Promise<void> {
  for (;;) {
    if (entry.generation !== generation) return;

    const started = await startOnce(pluginId, entry, generation);
    if (!started) return;
    const child = entry.child;
    if (!child) return;

    const code = await child.exited;
    if (entry.generation !== generation) return;

    const now = deps().now();
    const uptime = now - entry.startedAt;
    entry.child = null;
    entry.state.running = false;
    entry.state.pid = undefined;
    entry.state.since = undefined;
    entry.state.lastExit = { code, at: new Date(now).toISOString() };

    // A child that stayed up long enough was not a crash loop, whatever came
    // before it: both the backoff exponent and the window reset together.
    if (uptime >= UPTIME_RESET_MS) {
      entry.attempt = 0;
      entry.recent = [];
    }

    entry.recent = entry.recent.filter((t) => now - t < LOOP_WINDOW_MS);
    entry.recent.push(now);
    if (entry.recent.length > MAX_RESTARTS_IN_WINDOW) {
      entry.parked = true;
      pushLine(
        entry.state,
        `parked after ${entry.recent.length} restarts in ${LOOP_WINDOW_MS / 60_000} minutes; not restarting again until this plugin is re-published`,
      );
      getLogger().warn(`network plugin "${pluginId}": supervised process parked after repeated failures`);
      // Parked, NOT disarmed: the row stays so an operator can see the reason
      // and the last lines. Disarming would delete the evidence.
      return;
    }

    const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** entry.attempt);
    entry.attempt++;
    entry.state.restarts++;
    await deps().delay(wait);
  }
}

/**
 * Resolves and spawns one child.
 * @returns false when the run was refused, in which case the reason is on the state
 */
async function startOnce(pluginId: string, entry: Entry, generation: number): Promise<boolean> {
  const spec = entry.spec;
  const refuse = (reason: string): false => {
    entry.state.running = false;
    entry.state.pid = undefined;
    entry.state.since = undefined;
    entry.state.lastExit = { code: null, at: new Date(deps().now()).toISOString() };
    pushLine(entry.state, reason);
    getLogger().warn(`network plugin "${pluginId}": ${reason}`);
    return false;
  };

  const problem = refusal(spec);
  if (problem) return refuse(problem);

  const argv = [spec.command, ...spec.args];
  for (const [flag, name] of sortedEntries(spec.secretFileArgs)) {
    const path = await deps().secretFile(pluginId, name);
    // Refused rather than run without it: a daemon started without its
    // credential fails in the vendor's own words minutes later, and the
    // operator is left reading them instead of "this secret is not set".
    if (path === null) return refuse(`cannot start: the secret "${name}" is not set`);
    argv.push(flag, path);
  }

  const extra: Record<string, string> = { ...(spec.env ?? {}) };
  for (const [key, name] of sortedEntries(spec.secretEnv)) {
    const value = await deps().secretValue(pluginId, name);
    if (value === null) return refuse(`cannot start: the secret "${name}" is not set`);
    extra[key] = value;
  }

  const path = [...(process.env.PATH ?? "").split(":"), ...(await deps().extraPath())].filter(Boolean);
  if (entry.generation !== generation) return false;

  let child: SupervisedChild;
  try {
    child = deps().spawn({
      argv,
      env: childEnv([...new Set(path)].join(":"), extra),
      onLine: (line) => {
        pushLine(entry.state, line);
        // Only ever flips ON. A daemon that prints its ready line once and
        // then logs traffic has not become un-ready.
        if (!entry.state.running && entry.readyRe?.test(line)) entry.state.running = true;
      },
    });
  } catch (err) {
    return refuse(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (entry.generation !== generation) {
    // Disarmed between the PATH probe and the spawn. Nothing holds this child
    // — reaping it here is the only place it can be reaped.
    child.kill("SIGTERM");
    return false;
  }
  entry.child = child;
  entry.startedAt = deps().now();
  entry.state.pid = child.pid;
  entry.state.since = new Date(entry.startedAt).toISOString();
  // No ready pattern means nothing else could ever say it is up.
  entry.state.running = entry.readyRe === null;
  return true;
}

/** SIGTERM, then SIGKILL after the grace, resolving only once the child is reaped. */
async function stopChild(entry: Entry): Promise<void> {
  const child = entry.child;
  entry.child = null;
  entry.state.running = false;
  entry.state.pid = undefined;
  entry.state.since = undefined;
  if (!child) return;
  child.kill("SIGTERM");
  let reaped = false;
  const exited = child.exited.then((code) => {
    reaped = true;
    return code;
  });
  await Promise.race([exited, deps().delay(TERM_GRACE_MS)]);
  if (!reaped) child.kill("SIGKILL");
  // Awaited unconditionally: "stopped" has to mean reaped, or a re-arm
  // spawns its replacement while the old one still holds the publish.
  await exited;
}

/**
 * Stops a plugin's child and forgets it.
 *
 * Resolves only when the process is REAPED, which is what lets `unpublish`
 * order its steps: nothing downstream may assume a stopped tunnel until this
 * returns. A plugin that was never armed resolves immediately.
 */
export async function disarmProcess(pluginId: string): Promise<void> {
  const entry = entries.get(pluginId);
  if (!entry) return;
  // Invalidate first: the run loop may be mid-backoff, and it must not spawn
  // a replacement between the kill below and the delete.
  entry.generation++;
  const done = entry.queue.then(
    () => stopChild(entry),
    () => stopChild(entry),
  );
  entry.queue = done.catch(() => {});
  await done;
  entries.delete(pluginId);
}

/**
 * What one plugin's child is doing, or null when nothing is armed for it.
 *
 * A COPY, because this is rendered into a response while the loop above keeps
 * mutating the original — a caller that serialized the live object could
 * observe a pid from one child beside a `since` from the next.
 */
export function processState(pluginId: string): SupervisorState | null {
  const entry = entries.get(pluginId);
  if (!entry) return null;
  return { ...entry.state, lastLines: [...entry.state.lastLines] };
}

/**
 * Stops every supervised child.
 *
 * Shutdown and restart both go through here BEFORE the process exits: these
 * children are ours and nothing else reaps them, so an exit that skipped this
 * would leave a tunnel pointing at a port about to stop answering — which is
 * worse than no tunnel, because it stays resolvable.
 */
export async function stopAllProcesses(): Promise<void> {
  await Promise.all([...entries.keys()].map((id) => disarmProcess(id)));
}
