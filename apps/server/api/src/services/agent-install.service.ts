import { builtInIds, getHarness, loginPathEntries } from "@internal/pane-runtime";

/** What one install run produced. `ok:false` is a result, not an error: the installer ran and said no. */
export interface AgentInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** stdout then stderr, each capped at OUTPUT_CAP bytes. */
  output: string;
  durationMs: number;
}

/**
 * A refusal BEFORE anything ran: an unknown id, an id with no install
 * command, or one already installing. Distinct from a failing installer
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

/**
 * Test seams. Production callers pass nothing and get the real manifest, the
 * real timeout and the real login-shell PATH probe — the fake in tests never
 * touches a compiled-in plugin or spawns a login shell.
 */
export interface AgentInstallDeps {
  /** The install command for a BUILT-IN id, or undefined for an id this build does not carry. */
  commandFor: (id: string) => Promise<string | undefined>;
  timeoutMs: number;
  /** Directories to append to PATH: a service-run server carries only its baked PATH. */
  extraPath: () => Promise<string[]>;
}

/**
 * Caps captured stdout/stderr so a chatty or runaway installer cannot grow
 * the response (or this process's memory) without bound.
 */
const OUTPUT_CAP = 64 * 1024;

/**
 * Generous on purpose: a real package-manager install (nvm, cargo, npm -g)
 * can take minutes on a cold cache, and this runs unattended with no
 * feedback loop to extend it interactively.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What an installer gets. An allowlist, not `process.env`: the control-plane
 * process holds `BETTER_AUTH_SECRET` and the database path, and a vendor's
 * install script has no business reading either. These are the variables a
 * `curl | sh` installer legitimately needs - where to put things, how to reach
 * the network, and what locale to speak.
 */
const INSTALLER_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * Builds the child env for an installer run: the allowlisted keys above (only
 * those actually set), any `LC_*` locale override, plus the computed PATH.
 * Deliberately not `process.env` - see {@link INSTALLER_ENV_KEYS}.
 */
function installerEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INSTALLER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  env.PATH = path;
  return env;
}

const defaultDeps: AgentInstallDeps = {
  commandFor: async (id) => ((await builtInIds()).includes(id) ? getHarness(id)?.installHint.command : undefined),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  extraPath: loginPathEntries,
};

/**
 * One install per id at a time, instance-wide. The target is one filesystem
 * (this host), so a second concurrent install of the same id would race the
 * first rather than usefully parallelize with it.
 */
const inFlight = new Set<string>();

/**
 * Runs a built-in agent CLI's own installer on this host, as this process's
 * OS user (spec 2026-09-11 § 7). The command comes from the plugin manifest
 * compiled into THIS binary — the id is the only input a caller supplies, so
 * what may run is changed by editing this repo, never by anything a request
 * sends. `stdin: "ignore"` because there is no TTY behind this call: an
 * installer that prompts must hang to the timeout rather than block forever
 * waiting on input nobody will give it. Output is captured and capped but
 * never logged, since an installer's stdout can legitimately carry a token
 * or path a user typed into their own shell profile moments earlier. The
 * child's environment is an allowlist ({@link installerEnv}), not this
 * process's own — the control plane holds `BETTER_AUTH_SECRET` and the
 * database path, which a vendor's install script has no business reading.
 */
/**
 * The refusal {@link installBuiltInAgent} would raise before running anything,
 * or undefined when it would proceed.
 *
 * Exported for the STREAMING caller. Once a response body opens, the status
 * line is already sent and 200 cannot be taken back — so a refusal has to be
 * decided while a status code is still available, and the checks cannot be
 * left to discover themselves inside the stream.
 *
 * The checks are not duplicated here: `installBuiltInAgent` runs them again
 * on its own, which is what still makes it safe to call directly. This is the
 * same question asked earlier, not a second answer to it — and `inFlight` in
 * particular MUST be re-checked there, since the gap between these two calls
 * is exactly where a second request would slip in.
 */
export async function refuseInstall(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallRefused | undefined> {
  const command = await deps.commandFor(id);
  if (command === undefined) return new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") return new AgentInstallRefused(`"${id}" has nothing to install`, 400);
  if (inFlight.has(id)) return new AgentInstallRefused(`"${id}" is already being installed`, 409);
  return undefined;
}

export async function installBuiltInAgent(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
  onLine?: (line: string) => void,
): Promise<AgentInstallResult> {
  const command = await deps.commandFor(id);
  if (command === undefined) throw new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") throw new AgentInstallRefused(`"${id}" has nothing to install`, 400);
  if (inFlight.has(id)) throw new AgentInstallRefused(`"${id}" is already being installed`, 409);
  inFlight.add(id);
  const started = Date.now();
  try {
    const path = [...(process.env.PATH ?? "").split(":"), ...(await deps.extraPath())].filter(Boolean);
    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: installerEnv([...new Set(path)].join(":")),
    });
    // Readers are acquired up front (rather than inside `cap`) so the timeout
    // callback can cancel THEM. A stream already locked by `cap`'s own read
    // loop refuses `stream.cancel()` outright (`TypeError: Cannot cancel a
    // locked ReadableStream`, measured) - the reader that holds the lock is
    // the only thing that can cancel it from here.
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      // Killing `sh` is not enough for a pipeline: `curl … | bash` gives `sh` two
      // children that hold their own copies of fd 1 and fd 2, so the pipe never
      // reaches EOF and the reads below would wait for an orphan rather than for
      // the deadline. Cancel the reads instead; what was captured up to here is
      // what we report. The orphaned component can still outlive us - the cost of
      // not putting the child in its own process group - but the CALL returns, so
      // `inFlight` clears and this id is installable again.
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
    }, deps.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([cap(stdoutReader, onLine), cap(stderrReader, onLine)]);
      const exitCode = await proc.exited;
      const output = [
        stdout,
        stderr,
        timedOut ? `[installer timed out after ${deps.timeoutMs} ms; it may still be running]` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { ok: exitCode === 0 && !timedOut, exitCode, output, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Reads a stream (via its already-acquired reader) to a string, stopping at
 * {@link OUTPUT_CAP}. Keeps draining past the cap rather than breaking out of
 * the loop: a child process blocked writing to a full, unread pipe never
 * exits, which would turn a capacity limit into a hang.
 *
 * On the timeout path the caller cancels this same reader out from under the
 * loop (see {@link installBuiltInAgent}) because a pipeline's orphaned
 * children can hold the pipe open past the deadline. A cancelled read rejects
 * rather than reporting `done`, so the loop is wrapped: on that rejection we
 * return whatever was captured before the cancellation instead of throwing,
 * which is what lets the call return AT the deadline rather than when the
 * orphan exits.
 */
async function cap(
  reader: { read(): Promise<{ done?: boolean; value?: Uint8Array }> },
  onLine?: (line: string) => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Only assembled when someone is listening: the accumulate-and-return
  // contract above is unchanged for every caller that passes no sink.
  const decoder = onLine ? new TextDecoder() : null;
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && size < OUTPUT_CAP) {
        chunks.push(value);
        size += value.byteLength;
      }
      if (decoder && onLine && value !== undefined) {
        // Chunks are not lines: a read can split one mid-word or carry
        // several. `stream: true` keeps a multi-byte character whole across
        // the boundary, and the tail is held until its newline arrives.
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
    }
  } catch {
    // Cancelled by the timeout - return what we have.
  }
  // A final line with no trailing newline is still a line — an installer that
  // dies mid-sentence has usually said the most useful thing it will say.
  if (onLine && pending.trim() !== "") onLine(pending);
  const text = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, OUTPUT_CAP);
  return size > OUTPUT_CAP ? `${text}\n[truncated]` : text;
}
