import { NODE_PROTOCOL_VERSION } from "@internal/session-protocol";
import { type AgentConfig, loadConfig } from "./config.js";
import { probeOnline, runDaemon } from "./daemon.js";
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
    // `--flag=value` is accepted alongside `--flag value` (split on the FIRST
    // "=", so a value may itself contain "="); usage text keeps showing the
    // space form.
    const eq = rest[i].startsWith("--") ? rest[i].indexOf("=") : -1;
    const tok = eq === -1 ? rest[i] : rest[i].slice(0, eq);
    const inlineValue = eq === -1 ? undefined : rest[i].slice(eq + 1);
    if (!(tok in FLAGS)) throw new UsageError(`unknown flag '${tok}'`);
    if (!allowed.has(tok)) throw new UsageError(`flag '${tok}' is not valid for '${command}'`);
    if (!FLAGS[tok]) {
      if (inlineValue !== undefined) throw new UsageError(`flag '${tok}' takes no value`);
      flags[flagKey(tok)] = "1";
      continue;
    }
    if (inlineValue !== undefined) {
      if (inlineValue === "") throw new UsageError(`flag '${tok}' requires a value`);
      flags[flagKey(tok)] = inlineValue;
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
      case "run": {
        // The daemon is a foreground process that owns its own lifetime: it
        // logs its one-line entries (plain console, not CliResult) and exits
        // only through runDaemon's injected exit hook. loadConfig() still
        // throws the enroll-pointing message through this path.
        const cfg = await loadConfig();
        await runDaemon(cfg);
        return { code: 0, out: "", err: "" }; // unreachable: runDaemon never resolves (test seam only)
      }
      case "enroll": {
        const server = parsed.flags.server;
        const key = parsed.flags.key;
        const missing: string[] = [];
        if (!server) missing.push("--server <url>");
        if (!key) missing.push("--key <nsk_…>");
        if (missing.length > 0) throw new UsageError(`enroll requires ${missing.join(" and ")}`);
        const { nodeId } = await runEnroll({
          server,
          setupKey: key,
          name: parsed.flags.name,
          dataDir: parsed.flags.dataDir,
        });
        return { code: 0, out: `Enrolled as ${nodeId} — next: mote-agent run\n`, err: "" };
      }
      case "status": {
        // Config read → one short-lived connect (5 s cap, sends nothing). Exit 0
        // iff online; --json always prints (even config-missing, with a reason).
        // The nodeKey is NEVER echoed — not even via --json; the 0600 config file is its only home.
        let cfg: AgentConfig;
        try {
          cfg = await loadConfig();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!parsed.flags.json) return fail(1, err);
          const missing = { nodeId: null, serverUrl: null, online: false, agentVersion: AGENT_VERSION, reason };
          return { code: 1, out: `${JSON.stringify(missing, null, 2)}\n`, err: "" };
        }
        const online = await probeOnline(cfg);
        if (parsed.flags.json) {
          const body = { nodeId: cfg.nodeId, serverUrl: cfg.serverUrl, online, agentVersion: AGENT_VERSION };
          return { code: online ? 0 : 1, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
        }
        if (online) return { code: 0, out: `node ${cfg.nodeId} "${cfg.name}" — ONLINE (${cfg.serverUrl})\n`, err: "" };
        return {
          code: 1,
          out: `node ${cfg.nodeId} "${cfg.name}" — OFFLINE (no socket to ${cfg.serverUrl} within 5 s)\n`,
          err: "",
        };
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
