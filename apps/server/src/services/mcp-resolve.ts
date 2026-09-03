import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpLaunchSpec } from "@internal/harnesses";

/**
 * Pure resolution of HOW `subshell mcp` gets spawned in this deployment —
 * extracted from `mcp-launch.ts` so the CLI (`status`) can import it without
 * dragging `@/constants.js` (dotenvx runs at ITS import time) into the
 * side-effect-free CLI graph. Registration/env helpers live there; this module
 * answers one question: which command + argv launches the MCP server here.
 *
 * What the compiled MCP binary is called (`bun run compile` emits it beside
 * the backend) — the sibling lookup and the display fallback below share it.
 */
export const MCP_BINARY = "subshell-mcp";

/**
 * The server executable's name — the gate on the compiled-sibling rung. The
 * pre-rename spelling (`backend`) died with the apps/backend → apps/server
 * rename and matching it here was silently dead; the `startsWith` also admits
 * the triple-suffixed release artifacts (`subshell-server-darwin-arm64`).
 */
const SERVER_BINARY = "subshell-server";

/**
 * The node agent's binary name. Releases ship a `subshell-mcp-<triple>`
 * companion for the sibling rung, but installs predating that (and partial
 * installs) have no sibling; on a host that also runs a node the agent
 * carries the very same `subshell mcp` (shared `@internal/mcp-core`), so the
 * PATH lookup of it is the safe last autodetect rung — a plain-dist deploy
 * never reaches it (the dist rung wins first).
 */
const CLIENT_BINARY = "subshell";

/**
 * Fallback launch spec used only for DISPLAY when the real one cannot be
 * resolved — named after the compile artifact (apps/server/package.json
 * `compile` --outfile); keep the two spellings in sync.
 */
export const MCP_LAUNCH_PLACEHOLDER: McpLaunchSpec = { command: MCP_BINARY, args: [] };

/** Which rung answered — surfaced by `status` so an operator sees WHY it resolves. */
export type McpLaunchSource = "env" | "compiled-sibling" | "dist-entry" | "client-on-path";

/** Result of {@link probeMcpLaunch}: either a resolved spec + its rung, or the failure text. */
export type McpProbeOutcome =
  | { spec: McpLaunchSpec; source: McpLaunchSource; error?: undefined }
  | { spec: null; error: string };

/** Injectable fs/PATH/executable seams so tests can pin every rung (defaults: real Bun). */
export interface McpResolveIo {
  /** File existence for the sibling + dist-entry rungs (default: `existsSync`). */
  exists?: (path: string) => boolean;
  /** PATH lookup for the client-on-PATH rung (default: `Bun.which`). */
  which?: (name: string) => string | null;
  /** This process's executable (default: `process.execPath`). */
  execPath?: string;
}

/**
 * Non-throwing probe of the launch ladder, in priority order:
 * 1. `SUBSHELL_MCP_COMMAND` (+ optional JSON-array `SUBSHELL_MCP_ARGS`) — explicit override.
 * 2. Compiled build: a `subshell-mcp` sibling of the `subshell-server` executable
 *    (the `bun run compile` layout, and any release install that places them together).
 * 3. Bun-interpreted: the sibling mcp entry (`dist/mcp/main.js` in prod,
 *    `src/mcp/main.ts` in dev) run with the same interpreter.
 * 4. The `subshell` node agent on PATH — its `mcp` subcommand is the same server.
 * @param env - environment source (default: `process.env`)
 * @param io - fs/PATH/executable seams (default: the real ones)
 */
export function probeMcpLaunch(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpProbeOutcome {
  const exists = io.exists ?? existsSync;
  const which = io.which ?? ((name: string) => Bun.which(name) ?? null);
  const execPath = io.execPath ?? process.execPath;

  if (env.SUBSHELL_MCP_COMMAND) {
    return {
      spec: {
        command: env.SUBSHELL_MCP_COMMAND,
        args: env.SUBSHELL_MCP_ARGS ? (JSON.parse(env.SUBSHELL_MCP_ARGS) as string[]) : [],
      },
      source: "env",
    };
  }
  if (basename(execPath).startsWith(SERVER_BINARY)) {
    const sibling = join(dirname(execPath), MCP_BINARY);
    if (exists(sibling)) return { spec: { command: sibling, args: [] }, source: "compiled-sibling" };
  }
  for (const rel of ["../mcp/main.js", "../mcp/main.ts"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (exists(p)) return { spec: { command: execPath, args: [p] }, source: "dist-entry" };
    } catch {
      // a non-file import.meta.url (compiled binary: /$bunfs/…) → try the next candidate
    }
  }
  const client = which(CLIENT_BINARY);
  if (client) return { spec: { command: client, args: ["mcp"] }, source: "client-on-path" };

  return { spec: null, error: `cannot locate the ${MCP_BINARY} entrypoint; set SUBSHELL_MCP_COMMAND` };
}

/**
 * Resolve the MCP launch for the CURRENT deployment, throwing when no rung
 * answered — the error message is where the SUBSHELL_MCP_COMMAND hint
 * surfaces to the failed-create path.
 * @param env - environment source (default: `process.env`)
 * @param io - fs/PATH/executable seams (default: the real ones)
 */
export function resolveMcpLaunch(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpLaunchSpec {
  const probe = probeMcpLaunch(env, io);
  if (probe.spec) return probe.spec;
  throw new Error(probe.error);
}

/**
 * Display-only variant for editor surfaces: never throws. If the launch can't
 * be resolved (exotic deployment), the compiled artifact's bare name is shown
 * instead — subshell launch keeps using the throwing resolver.
 * @param env - environment source (default: `process.env`)
 * @param io - fs/PATH/executable seams (default: the real ones)
 */
export function resolveMcpLaunchForDisplay(env: NodeJS.ProcessEnv = process.env, io: McpResolveIo = {}): McpLaunchSpec {
  try {
    return resolveMcpLaunch(env, io);
  } catch {
    return MCP_LAUNCH_PLACEHOLDER;
  }
}
