import { basename, resolve } from "node:path";
import type { McpLaunchSpec } from "@internal/harnesses";

/**
 * Pure resolution of HOW `subshell mcp` gets spawned in this deployment —
 * extracted from `mcp-launch.ts` so the CLI (`status`) can import it without
 * dragging `@/constants.js` (dotenvx runs at ITS import time) into the
 * side-effect-free CLI graph. Registration/env helpers live there; this module
 * answers one question: which command + argv launches the MCP server here.
 *
 * The ladder is env override → SELF → client-on-PATH (spec 2026-09-03, single
 * binary): the server process IS the MCP server, so there is no companion file
 * to hunt for and this module touches no fs at all.
 */

/**
 * The server executable's product name — the gate on the SELF rung's compiled
 * shape. The `startsWith` also admits the triple-suffixed release artifacts
 * (`subshell-server-darwin-arm64`).
 */
const SERVER_PRODUCT = "subshell-server";

/**
 * The node agent's binary name. Its `mcp` subcommand is the same shared
 * `@internal/mcp-core` server, so the PATH lookup of it is the safe last
 * autodetect rung — it covers installs whose server predates the self rung.
 */
const CLIENT_BINARY = "subshell";

/**
 * Fallback launch spec used only for DISPLAY when the real one cannot be
 * resolved — it names the command every current deployment self-resolves to
 * (`subshell-server mcp`), so an editor surface never shows an operator a
 * command that cannot actually run on an up-to-date host.
 */
export const MCP_LAUNCH_PLACEHOLDER: McpLaunchSpec = { command: SERVER_PRODUCT, args: ["mcp"] };

/** Which rung answered — surfaced by `status` so an operator sees WHY it resolves. */
export type McpLaunchSource = "env" | "self" | "client-on-path";

/** Result of {@link probeMcpLaunch}: either a resolved spec + its rung, or the failure text. */
export type McpProbeOutcome =
  | { spec: McpLaunchSpec; source: McpLaunchSource; error?: undefined }
  | { spec: null; error: string };

/** Injectable PATH/executable seams so tests can pin every rung (defaults: real Bun). */
export interface McpResolveIo {
  /** PATH lookup for the client-on-PATH rung (default: `Bun.which`). */
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
  const which = io.which ?? ((name: string) => Bun.which(name) ?? null);
  const execPath = io.execPath ?? process.execPath;
  const argv1 = io.argv1 ?? process.argv[1] ?? "";

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
  // 2. SELF: the server binary IS the MCP server (`subshell-server mcp`,
  //    spec 2026-09-03) — possible because the entry graph is IO-free at
  //    import. Compiled builds self-reference by execPath; bun-interpreted
  //    ones (dev `bun src/index.ts`, dist `bun dist/index.js`) need the
  //    entry script too, ABSOLUTE: pane configs spawn in the subshell's cwd,
  //    where a relative argv[1] would not exist.
  if (basename(execPath).startsWith(SERVER_PRODUCT)) {
    return { spec: { command: execPath, args: ["mcp"] }, source: "self" };
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
    return { spec: { command: execPath, args: [resolve(argv1), "mcp"] }, source: "self" };
  }
  // 3. LAST RUNG: the `subshell` node agent carries the same mcp-core server.
  //    Covers hosts whose server predates the self rung.
  const client = which(CLIENT_BINARY);
  if (client) return { spec: { command: client, args: ["mcp"] }, source: "client-on-path" };
  return { spec: null, error: "cannot locate the subshell mcp entrypoint; set SUBSHELL_MCP_COMMAND" };
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
