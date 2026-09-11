import { basename, resolve } from "node:path";
import type { McpLaunchSpec } from "@internal/pane-runtime";

/**
 * Pure resolution of HOW this binary gets re-entered in this deployment —
 * extracted from `mcp-launch.ts` so the CLI (`status`) can import it without
 * dragging `@/constants.js` (dotenvx runs at ITS import time) into the
 * side-effect-free CLI graph. Registration/env helpers live there; this module
 * answers which command + argv reaches a subcommand here.
 *
 * The ladder is env override → SELF → agent-on-PATH (spec 2026-09-03, single
 * binary): the server process IS the MCP server, so there is no companion file
 * to hunt for and this module touches no fs at all.
 *
 * Two subcommands ride it. `subshell mcp` is the pane's MCP server
 * ({@link probeMcpLaunch}, override included); `subshell report` is what a
 * harness HOOK runs ({@link probeReporterLaunch}, autodetect only). They share
 * {@link probeSelfInvoke} because the host question — compiled binary, or
 * `bun` running my entry script? — has one answer per machine.
 */

/**
 * The server executable's product name — the gate on the SELF rung's compiled
 * shape. The `startsWith` also admits the published release artifacts
 * (`subshell-server-cli-darwin-arm64` — a `cli` marker and a triple that an
 * install drops).
 */
const SERVER_PRODUCT = "subshell-server";

/**
 * The node agent's binary name. Its `mcp` subcommand is the same shared
 * `@internal/mcp-core` server, so the PATH lookup of it is the safe last
 * autodetect rung — it covers installs whose server predates the self rung.
 */
const AGENT_BINARY = "subshell";

/**
 * Fallback launch spec used only for DISPLAY when the real one cannot be
 * resolved — it names the command every current deployment self-resolves to
 * (`subshell-server mcp`), so an editor surface never shows an operator a
 * command that cannot actually run on an up-to-date host.
 */
export const MCP_LAUNCH_PLACEHOLDER: McpLaunchSpec = { command: SERVER_PRODUCT, args: ["mcp"] };

/** Which rung answered — surfaced by `status` so an operator sees WHY it resolves. */
export type McpLaunchSource = "env" | "self" | "agent-on-path";

/** Result of {@link probeMcpLaunch}: either a resolved spec + its rung, or the failure text. */
export type McpProbeOutcome =
  | { spec: McpLaunchSpec; source: McpLaunchSource; error?: undefined }
  | { spec: null; error: string };

/** Injectable PATH/executable seams so tests can pin every rung (defaults: real Bun). */
export interface McpResolveIo {
  /** PATH lookup for the agent-on-PATH rung (default: `Bun.which`). */
  which?: (name: string) => string | null;
  /** This process's executable (default: `process.execPath`). */
  execPath?: string;
  /** This process's script path / first argument (default: `process.argv[1]`). */
  argv1?: string;
}

/**
 * Non-throwing probe of the launch ladder, in priority order:
 * 1. `SUBSHELL_MCP_COMMAND` (+ optional JSON-array `SUBSHELL_MCP_ARGS`) — explicit override.
 * 2. SELF: this process IS the MCP server — `subshell-server mcp` when the
 *    executable carries the product name, or `<bun> <abs entry> mcp` when
 *    bun-interpreted with a usable argv[1].
 * 3. The `subshell` node agent on PATH — its `mcp` subcommand is the same server.
 * @param env - environment source (default: `process.env`)
 * @param io - PATH/executable seams (default: the real ones)
 */
export function probeMcpLaunch(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpProbeOutcome {
  if (env.SUBSHELL_MCP_COMMAND) {
    let args: string[] = [];
    if (env.SUBSHELL_MCP_ARGS) {
      try {
        const parsed: unknown = JSON.parse(env.SUBSHELL_MCP_ARGS);
        if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string")) throw new Error("not a string array");
        args = parsed as string[];
      } catch {
        // The probe NEVER throws — `status` runs it on the sync CLI path,
        // where a throw would abort the prelude before `status` can REPORT
        // the failure (boot itself is held off by `isCliEngaged()`, set
        // synchronously before dispatch — not by anything at this call
        // site). A malformed override is a resolution failure.
        return { spec: null, error: `SUBSHELL_MCP_ARGS is not a JSON string array (got "${env.SUBSHELL_MCP_ARGS}")` };
      }
    }
    return { spec: { command: env.SUBSHELL_MCP_COMMAND, args }, source: "env" };
  }
  return probeSelfInvoke("mcp", io);
}

/**
 * The autodetect half of the ladder, for ANY subcommand: rungs 2 and 3 of
 * {@link probeMcpLaunch}, which differ between `mcp` and `report` only in the
 * word appended. Shared rather than duplicated because the awkward question
 * they answer — am I a compiled binary, or is `bun` running my entry script? —
 * has exactly one right answer per host, and two copies of it would drift.
 *
 * 1. SELF: this process IS the binary (`subshell-server <sub>`, spec
 *    2026-09-03) — possible because the entry graph is IO-free at import.
 *    Compiled builds self-reference by execPath; bun-interpreted ones (dev
 *    `bun src/index.ts`, dist `bun dist/index.js`) need the entry script too,
 *    ABSOLUTE: pane configs and hooks spawn in the subshell's cwd, where a
 *    relative argv[1] would not exist.
 * 2. The `subshell` node agent on PATH — it carries the same shared
 *    implementations of both subcommands.
 *
 * @param subcommand - the verb to append (`"mcp"`, `"report"`)
 * @param io - PATH/executable seams (default: the real ones)
 */
function probeSelfInvoke(subcommand: string, io: McpResolveIo = {}): McpProbeOutcome {
  const which = io.which ?? ((name: string) => Bun.which(name) ?? null);
  const execPath = io.execPath ?? process.execPath;
  const argv1 = io.argv1 ?? process.argv[1] ?? "";

  if (basename(execPath).startsWith(SERVER_PRODUCT)) {
    return { spec: { command: execPath, args: [subcommand] }, source: "self" };
  }
  // The argv1 rung exists for `bun <entry>.ts|js` shapes ONLY. A COMPILED
  // binary carries a virtual `/$bunfs/root/...` argv[1] (and any non-entry
  // launcher — a wrapper script — carries whatever argv[1] it likes): baking
  // one of those yields an unspawnable/foreign command that still reports
  // `(via self)`, so a renamed artifact must fall THROUGH to the PATH rung
  // instead. Hence the entry-shape gate: an actual JS/TS file extension
  // (js|mjs|cjs|ts|mts|cts) and not the bunfs virtual path — the regex cannot
  // match an empty argv1, so one test is the whole gate.
  const looksLikeEntry = !argv1.startsWith("/$bunfs/") && /\.(?:[mc]?[jt])s$/.test(argv1);
  if (looksLikeEntry) {
    return { spec: { command: execPath, args: [resolve(argv1), subcommand] }, source: "self" };
  }
  const agent = which(AGENT_BINARY);
  if (agent) return { spec: { command: agent, args: [subcommand] }, source: "agent-on-path" };
  return { spec: null, error: `cannot locate the subshell ${subcommand} entrypoint; set SUBSHELL_MCP_COMMAND` };
}

/**
 * How a harness hook re-enters this binary on the pane's machine:
 * `<self> report …`, to which the plugin appends its verb words.
 *
 * It shares the autodetect rungs with {@link probeMcpLaunch} — same binary,
 * same host question — and deliberately NOT the `SUBSHELL_MCP_COMMAND` rung:
 * that variable names an MCP *server*, which an operator may well point at a
 * wrapper script that has no `report` verb. Honouring it here would turn a
 * working MCP override into broken hooks in every pane.
 *
 * Unresolved is a real outcome, not an error to throw: the launch path omits
 * the hooks rather than baking a command the pane cannot run — which is the
 * regression this whole path exists to fix.
 * @param io - PATH/executable seams (default: the real ones)
 */
export function probeReporterLaunch(io: McpResolveIo = {}): McpProbeOutcome {
  return probeSelfInvoke("report", io);
}

/**
 * Resolve the MCP launch for the CURRENT deployment, throwing when no rung
 * answered — the error message is where the SUBSHELL_MCP_COMMAND hint
 * surfaces to the failed-create path.
 * @param env - environment source (default: `process.env`)
 * @param io - PATH/executable seams (default: the real ones)
 */
export function resolveMcpLaunch(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpLaunchSpec {
  const probe = probeMcpLaunch(env, io);
  if (probe.spec) return probe.spec;
  throw new Error(probe.error);
}

/**
 * Display-only variant for editor surfaces: never throws. If the launch can't
 * be resolved (exotic deployment), the self command is shown instead —
 * subshell launch keeps using the throwing resolver.
 * @param env - environment source (default: `process.env`)
 * @param io - PATH/executable seams (default: the real ones)
 */
export function resolveMcpLaunchForDisplay(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpLaunchSpec {
  try {
    return resolveMcpLaunch(env, io);
  } catch {
    return MCP_LAUNCH_PLACEHOLDER;
  }
}
