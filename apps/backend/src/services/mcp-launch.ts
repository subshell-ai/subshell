import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPlugin, McpLaunchSpec, McpRegistration } from "@internal/harnesses";
import { APP_BASE_URL, SESSION_DATA_DIR } from "@/constants.js";
import type { NodeAgentFacts } from "@/services/nodes/node-registry.js";

/**
 * Everything per-session `mote mcp` needs: how to spawn it in this deployment,
 * what env the child reads, where its config lives, and how it gets registered
 * with a harness.
 *
 * The MCP server runs as a child of the HARNESS (the harness spawns it per
 * its MCP config), so it inherits the session env — the MOTE_API_KEY baked
 * into the pane IS the child's credential. Nothing secret is written to disk
 * here: the config file names only the command to run.
 */

/**
 * What the compiled MCP binary is called (`bun run compile` emits it beside
 * the backend). Used as the display fallback when resolution fails — it names
 * a real artifact of this repo, unlike an invented command.
 */
export const MCP_LAUNCH_PLACEHOLDER: McpLaunchSpec = { command: "mote-mcp", args: [] };

/**
 * Display-only variant for editor surfaces: never throws. If the launch can't
 * be resolved (exotic deployment), the compiled artifact's bare name is shown
 * instead — session launch keeps using the throwing resolver, whose error
 * message is where the MOTE_MCP_COMMAND hint surfaces.
 */
export function resolveMcpLaunchForDisplay(env: NodeJS.ProcessEnv = process.env): McpLaunchSpec {
  try {
    return resolveMcpLaunch(env);
  } catch {
    return MCP_LAUNCH_PLACEHOLDER;
  }
}

/**
 * Resolve the launch for the CURRENT deployment, in priority order:
 * 1. `MOTE_MCP_COMMAND` (+ optional JSON-array `MOTE_MCP_ARGS`) — explicit override.
 * 2. Compiled single-binary: a `mote-mcp` sibling of the executable.
 * 3. Bun-interpreted: the sibling mcp entry (`dist/mcp/main.js` in prod,
 *    `src/mcp/main.ts` in dev) run with the same interpreter.
 */
export function resolveMcpLaunch(env: NodeJS.ProcessEnv = process.env): McpLaunchSpec {
  if (env.MOTE_MCP_COMMAND) {
    return {
      command: env.MOTE_MCP_COMMAND,
      args: env.MOTE_MCP_ARGS ? (JSON.parse(env.MOTE_MCP_ARGS) as string[]) : [],
    };
  }
  const sibling = join(dirname(process.execPath), "mote-mcp");
  if (basename(process.execPath) === "backend" && existsSync(sibling)) {
    return { command: sibling, args: [] };
  }
  for (const rel of ["../mcp/main.js", "../mcp/main.ts"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(p)) return { command: process.execPath, args: [p] };
    } catch {
      // a non-file import.meta.url (exotic bundler) → try the next candidate
    }
  }
  throw new Error("cannot locate the mote-mcp entrypoint; set MOTE_MCP_COMMAND");
}

/**
 * The MOTE_* env the `mote mcp` child reads (contract: `src/mcp/env.ts`).
 * Single producer so the create path and the auto-restart path can never
 * drift apart on the variables the child depends on.
 */
export function sessionMcpEnv(apiKey: string, sessionId: string, sessionName: string): Record<string, string> {
  return {
    MOTE_API_KEY: apiKey,
    MOTE_BASE_URL: APP_BASE_URL,
    MOTE_SESSION_ID: sessionId,
    MOTE_SESSION_NAME: sessionName,
    MOTE_DATA_DIR: SESSION_DATA_DIR,
  };
}

/**
 * Registers `mote mcp` for one session launch, in the HARNESS'S OWN dialect:
 * the plugin renders the config file content (plus any argv/env that activates
 * it), and this writes the file. Returns the registration for the caller to
 * bake into the pane — or undefined for harnesses with no per-session format
 * (hermes, pi), which the UI explains via their one-time mcpSetup steps.
 * Content holds no secrets, but the file stays 0600 — least exposure is free.
 */
export function registerSessionMcp(
  harness: HarnessPlugin,
  sessionId: string,
  launch: McpLaunchSpec = resolveMcpLaunch(),
): McpRegistration | undefined {
  const file = sessionMcpConfigPath(sessionId);
  const reg = harness.mcpRegistration?.(launch, file);
  if (!reg) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, reg.fileContent, { mode: 0o600 });
  return reg;
}

/** Where a session's MCP config lives (also the write target — one definition). */
export function sessionMcpConfigPath(sessionId: string): string {
  return join(SESSION_DATA_DIR, "mcp", `${sessionId}.json`);
}

/**
 * The PURE (no-disk-write) mirror of {@link registerSessionMcp} for AGENT
 * nodes (spec §6.4): computes the same harness dialect but against the
 * node's own filesystem — `mote-agent mcp` as the spawn command (its
 * `executablePath` from the `ready` facts, the bare name as fallback) and
 * `<dataDir>/mcp/<sessionId>.json` as the target path. Nothing is written
 * locally: `RemoteLauncher.launch` ships `reg.fileContent` inline with the
 * launch command (`RemoteLauncher.writeArtifact` covers other artifact
 * flows). The capability gate and the debug-log note live in the
 * session manager, not here — this function answers "what would the
 * registration be", for any node facts handed to it.
 * @param harness - The resolved plugin (its `mcpRegistration` dialect)
 * @param sessionId - The session the config is generated for
 * @param facts - The node's live `ready` facts (dataDir + executablePath)
 * @returns the registration plus the node-side path, or undefined for
 *          harnesses with no per-session format (hermes, pi)
 */
export function planRemoteSessionMcp(
  harness: HarnessPlugin,
  sessionId: string,
  facts: Pick<NodeAgentFacts, "dataDir" | "executablePath">,
): { reg: McpRegistration; configPath: string } | undefined {
  const launch: McpLaunchSpec = { command: facts.executablePath ?? "mote-agent", args: ["mcp"] };
  const configPath = `${facts.dataDir}/mcp/${sessionId}.json`;
  const reg = harness.mcpRegistration?.(launch, configPath);
  if (!reg) return undefined;
  return { reg, configPath };
}
