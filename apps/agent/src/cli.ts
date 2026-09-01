import { NODE_PROTOCOL_VERSION } from "@internal/session-protocol";
import { loadConfig } from "./config.js";
import { runEnroll } from "./enroll.js";
import { AGENT_VERSION } from "./version.js";

/** Collected output + exit code instead of direct stdio writes, so tests assert both. */
export interface CliResult {
  /** Process exit code (0 ok, 1 runtime failure, 2 usage, 3 not-implemented stub). */
  code: number;
  /** Text for stdout. */
  out: string;
  /** Text for stderr. */
  err: string;
}

const USAGE = `mote-agent — mote node daemon

usage:
  mote-agent enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
  mote-agent run
  mote-agent status [--json]
  mote-agent version
`;

/** Malformed invocation → usage text, exit 2. */
class UsageError extends Error {}

const COMMANDS = new Set(["enroll", "run", "status", "version"]);
/** Known flag → does it take a value? */
const FLAGS: Record<string, boolean> = {
  "--server": true,
  "--key": true,
  "--name": true,
  "--data-dir": true,
  "--json": false,
};
const COMMAND_FLAGS: Record<string, string[]> = {
  enroll: ["--server", "--key", "--name", "--data-dir"],
  run: [],
  status: ["--json"],
  version: [],
};

const flagKey = (flag: string): string => flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Hand-rolled flag map (precedent: backend mcp entry) — no dependency needed for 5 flags. */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("no command given");
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command '${command}'`);
  const flags: Record<string, string> = {};
  const allowed = new Set(COMMAND_FLAGS[command]);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!(tok in FLAGS)) throw new UsageError(`unknown flag '${tok}'`);
    if (!allowed.has(tok)) throw new UsageError(`flag '${tok}' is not valid for '${command}'`);
    if (!FLAGS[tok]) {
      flags[flagKey(tok)] = "1";
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`flag '${tok}' requires a value`);
    flags[flagKey(tok)] = value;
  }
  return { command, flags };
}

/**
 * Runs one CLI invocation and returns what to print + the exit code.
 * Never throws for expected failures; the messages are operator-actionable.
 */
export async function run(argv: string[]): Promise<CliResult> {
  let parsed: { command: string; flags: Record<string, string> };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return fail(2, err);
  }
  try {
    switch (parsed.command) {
      case "version":
        return { code: 0, out: `mote-agent ${AGENT_VERSION} (node protocol v${NODE_PROTOCOL_VERSION})\n`, err: "" };
      case "run":
        // Placeholder until the daemon lands; exit 3 distinguishes "not built" from "broken".
        return { code: 3, out: "", err: "mote-agent run: the daemon is not implemented yet (phase 1 task 13)\n" };
      case "enroll": {
        const server = parsed.flags.server;
        const key = parsed.flags.key;
        if (!server || !key) throw new UsageError("enroll requires --server <url> and --key <nsk_…>");
        const { nodeId } = await runEnroll({
          server,
          setupKey: key,
          name: parsed.flags.name,
          dataDir: parsed.flags.dataDir,
        });
        return { code: 0, out: `Enrolled as ${nodeId} — next: mote-agent run\n`, err: "" };
      }
      case "status": {
        const cfg = await loadConfig();
        // The nodeKey is NEVER echoed — not even via --json; the 0600 config file is its only home.
        const { nodeKey: _redacted, ...safe } = cfg;
        if (parsed.flags.json) return { code: 0, out: `${JSON.stringify(safe, null, 2)}\n`, err: "" };
        const out =
          `node ${cfg.nodeId} "${cfg.name}"\n` +
          `  server:   ${cfg.serverUrl}\n` +
          `  data dir: ${cfg.dataDir}\n` +
          "  control key: pinned\n";
        return { code: 0, out, err: "" };
      }
    }
  } catch (err) {
    return err instanceof UsageError ? fail(2, err) : fail(1, err);
  }
  return fail(2, new UsageError(`unknown command '${parsed.command}'`));
}

function fail(code: number, err: unknown): CliResult {
  const message = err instanceof Error ? err.message : String(err);
  return { code, out: "", err: `mote-agent: ${message}\n${code === 2 ? `\n${USAGE}` : ""}` };
}
