import { builtInIds, getHarness, loginPathEntries, runBounded } from "@internal/pane-runtime";

/** What one install run produced. `ok:false` is a result, not an error: the installer ran and said no. */
export interface AgentInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** stdout then stderr, each capped at OUTPUT_CAP bytes. */
  output: string;
  durationMs: number;
}

/**
 * A refusal BEFORE anything ran: an unknown id, an id with no command for
 * the asked kind, or one already running a command of any kind. Distinct
 * from a failing installer
 * ({@link AgentInstallResult} with `ok:false`), which did run and reported a
 * result — this is a rejected promise so the route can answer with the right
 * status before spawning anything.
 */
export class AgentInstallRefused extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = "AgentInstallRefused";
    this.status = status;
  }
}

/** Which manifest command this run executes: the installer, or the vendor's updater. */
export type AgentInstallKind = "install" | "update";

/**
 * Test seams. Production callers pass nothing and get the real manifest, the
 * real timeout and the real login-shell PATH probe — the fake in tests never
 * touches a compiled-in plugin or spawns a login shell.
 */
export interface AgentInstallDeps {
  /** The command for a BUILT-IN id and kind, or undefined for an id this build does not carry. */
  commandFor: (id: string, kind: AgentInstallKind) => Promise<string | undefined>;
  timeoutMs: number;
  /** Directories to append to PATH: a service-run server carries only its baked PATH. */
  extraPath: () => Promise<string[]>;
}

/**
 * Generous on purpose: a real package-manager install (nvm, cargo, npm -g)
 * can take minutes on a cold cache, and this runs unattended with no
 * feedback loop to extend it interactively.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const defaultDeps: AgentInstallDeps = {
  commandFor: async (id, kind) => {
    if (!(await builtInIds()).includes(id)) return undefined;
    const h = getHarness(id);
    if (!h) return undefined;
    // The fallback IS the update story for most vendors: their install
    // one-liner installs the latest, so a plugin that declares no `update`
    // re-runs what the Install button would.
    return kind === "update" ? (h.updateHint ?? h.installHint.command) : h.installHint.command;
  },
  timeoutMs: DEFAULT_TIMEOUT_MS,
  extraPath: loginPathEntries,
};

/**
 * One command per id at a time, instance-wide. The target is one filesystem
 * (this host), so a second concurrent command of the same id would race the
 * first rather than usefully parallelize with it — and that holds ACROSS the
 * kinds: an update may not run beside an install of the same id. The map
 * remembers WHICH kind is running, because the "already running" sentence
 * names the work under way, not the kind being refused.
 */
const inFlight = new Map<string, AgentInstallKind>();

/** Past-tense verb for the "already running" sentence, per kind. */
const RUNNING_WORD: Record<AgentInstallKind, string> = { install: "installed", update: "updated" };

/**
 * The refusal {@link runBuiltInAgentCommand} would raise for `kind` before
 * running anything, or undefined when it would proceed.
 *
 * Exported for the STREAMING caller. Once a response body opens, the status
 * line is already sent and 200 cannot be taken back — so a refusal has to be
 * decided while a status code is still available, and the checks cannot be
 * left to discover themselves inside the stream.
 *
 * The checks are not duplicated here: `runBuiltInAgentCommand` runs them
 * again on its own, which is what still makes it safe to call directly. This
 * is the same question asked earlier, not a second answer to it — and
 * `inFlight` in particular MUST be re-checked there, since the gap between
 * these two calls is exactly where a second request would slip in.
 */
export async function refuseAgentCommand(
  id: string,
  kind: AgentInstallKind,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallRefused | undefined> {
  const command = await deps.commandFor(id, kind);
  if (command === undefined) return new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") return new AgentInstallRefused(`"${id}" has nothing to ${kind}`, 400);
  const running = inFlight.get(id);
  if (running !== undefined) return new AgentInstallRefused(`"${id}" is already being ${RUNNING_WORD[running]}`, 409);
  return undefined;
}

/** @deprecated spelling kept for the install route and the wizard tests; equals `refuseAgentCommand(id, "install")`. */
export async function refuseInstall(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallRefused | undefined> {
  return refuseAgentCommand(id, "install", deps);
}

/**
 * Runs one kind of a built-in agent CLI's own vendor command on this host —
 * its installer (`"install"`) or its updater (`"update"`, falling back to the
 * installer when the plugin declares no update command) — as this process's
 * OS user (spec 2026-09-11 § 7, extended by spec 2026-09-28). The command
 * comes from the plugin manifest compiled into THIS binary — the id is the
 * only input a caller supplies, so what may run is changed by editing this
 * repo, never by anything a request sends. How it runs — the allowlisted
 * environment, the cap, the deadline — is {@link runInstaller}'s.
 */
export async function runBuiltInAgentCommand(
  id: string,
  kind: AgentInstallKind,
  deps: AgentInstallDeps = defaultDeps,
  onLine?: (line: string) => void,
): Promise<AgentInstallResult> {
  const command = await deps.commandFor(id, kind);
  if (command === undefined) throw new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") throw new AgentInstallRefused(`"${id}" has nothing to ${kind}`, 400);
  const running = inFlight.get(id);
  if (running !== undefined) throw new AgentInstallRefused(`"${id}" is already being ${RUNNING_WORD[running]}`, 409);
  inFlight.set(id, kind);
  try {
    // A plugin's install/update hint is a SHELL LINE (`curl … | bash`, or a
    // plain `claude update`), so it is run through `sh -c`. Callers with a
    // fixed argv — the tmux installer — hand {@link runInstaller} the argv
    // directly and never grow a shell.
    return await runInstaller(["sh", "-c", command], {
      timeoutMs: deps.timeoutMs,
      extraPath: deps.extraPath,
      onLine,
    });
  } finally {
    inFlight.delete(id);
  }
}

/** Equals `runBuiltInAgentCommand(id, "install", …)`; the name the install route and the wizard speak. */
export async function installBuiltInAgent(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
  onLine?: (line: string) => void,
): Promise<AgentInstallResult> {
  return runBuiltInAgentCommand(id, "install", deps, onLine);
}

/** What {@link runInstaller} needs from its caller. */
export interface InstallerRunOptions {
  /** Deadline for the whole run; what was captured up to it is what gets reported. */
  timeoutMs: number;
  /** Directories to append to PATH: a service-run server carries only its baked PATH. */
  extraPath: () => Promise<string[]>;
  /** Called with each line the installer prints, ANSI already stripped. */
  onLine?: (line: string) => void;
}

/**
 * Runs one installer argv to completion, streaming its output a line at a time
 * and reporting it as an {@link AgentInstallResult}.
 *
 * The argv is the CALLER's — this function decides nothing about what runs,
 * only how it is reported. Both callers supply something fixed by this repo
 * rather than by a request: a built-in plugin's compiled-in install hint, or
 * the tmux table in `commands/tmux-install.ts`.
 *
 * The bounds themselves live in `runBounded` (`@internal/pane-runtime`), which
 * network plugins reach through `PluginHost.run`: the environment allowlist —
 * NOT this process's own, which holds `BETTER_AUTH_SECRET` and the database
 * path — the login-shell PATH, the closed stdin that makes a prompting
 * installer hit the deadline rather than wait forever, the 64 KiB cap, and the
 * reader cancellation that makes the deadline hold against a pipeline's
 * orphans. They were this function's, and they were duplicated the moment a
 * second kind of caller needed them; there is one copy now.
 *
 * What stays here is the REPORTING shape the two install routes already
 * stream, which is why this wrapper exists rather than the routes calling
 * `runBounded` directly. Output is captured and capped but never logged: an
 * installer's stdout can legitimately carry a token or a path a user typed
 * into their own shell profile moments earlier.
 */
export async function runInstaller(
  argv: readonly string[],
  { timeoutMs, extraPath, onLine }: InstallerRunOptions,
): Promise<AgentInstallResult> {
  const result = await runBounded(argv, { timeoutMs, extraPath, onLine });
  // Joined, unlike every other caller of the shared core, because this one's
  // `output` is a DISCLOSURE rather than something to parse: it is shown to an
  // admin when an install failed, and an installer that explains itself on
  // stderr while printing progress on stdout is the common case. Splitting it
  // here would make the page choose which half to show.
  const output = [
    result.stdout,
    result.stderr,
    result.timedOut ? `[installer timed out after ${timeoutMs} ms; it may still be running]` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ok: result.code === 0 && !result.timedOut,
    exitCode: result.code,
    output,
    durationMs: result.durationMs,
  };
}
