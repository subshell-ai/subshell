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
 * or path a user typed into their own shell profile moments earlier.
 */
export async function installBuiltInAgent(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
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
      env: { ...process.env, PATH: [...new Set(path)].join(":") },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, deps.timeoutMs);
    const [stdout, stderr] = await Promise.all([cap(proc.stdout), cap(proc.stderr)]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const output = [stdout, stderr, timedOut ? `[installer timed out after ${deps.timeoutMs} ms]` : ""]
      .filter(Boolean)
      .join("\n");
    return { ok: exitCode === 0 && !timedOut, exitCode, output, durationMs: Date.now() - started };
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Reads a stream to a string, stopping at {@link OUTPUT_CAP}. Keeps draining
 * past the cap rather than breaking out of the loop: a child process blocked
 * writing to a full, unread pipe never exits, which would turn a capacity
 * limit into a hang.
 */
async function cap(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= OUTPUT_CAP) continue;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, OUTPUT_CAP);
  return size > OUTPUT_CAP ? `${text}\n[truncated]` : text;
}
