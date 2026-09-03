import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPlugin, McpLaunchSpec, McpRegistration } from "@internal/harnesses";
import { APP_BASE_URL, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import type { NodeAgentFacts } from "@/services/nodes/node-registry.js";

/**
 * Everything per-subshell `subshell mcp` needs: how to spawn it in this deployment,
 * what env the child reads, where its config lives, and how it gets registered
 * with a harness.
 *
 * The MCP server runs as a child of the HARNESS (the harness spawns it per
 * its MCP config), so it inherits the subshell env — the SUBSHELL_API_KEY baked
 * into the pane IS the child's credential. Nothing secret is written to disk
 * here: the config file names only the command to run.
 */

/**
 * What the compiled MCP binary is called (`bun run compile` emits it beside
 * the backend) — the sibling lookup and the display fallback below share it.
 */
export const MCP_BINARY = "subshell-mcp";

/**
 * Fallback launch spec used only for DISPLAY when the real one cannot be
 * resolved — named after the compile artifact (apps/server/package.json
 * `compile` --outfile); keep the two spellings in sync.
 */
export const MCP_LAUNCH_PLACEHOLDER: McpLaunchSpec = { command: MCP_BINARY, args: [] };

/**
 * Display-only variant for editor surfaces: never throws. If the launch can't
 * be resolved (exotic deployment), the compiled artifact's bare name is shown
 * instead — subshell launch keeps using the throwing resolver, whose error
 * message is where the SUBSHELL_MCP_COMMAND hint surfaces.
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
 * 1. `SUBSHELL_MCP_COMMAND` (+ optional JSON-array `SUBSHELL_MCP_ARGS`) — explicit override.
 * 2. Compiled single-binary: a `subshell-mcp` sibling of the executable.
 * 3. Bun-interpreted: the sibling mcp entry (`dist/mcp/main.js` in prod,
 *    `src/mcp/main.ts` in dev) run with the same interpreter.
 */
export function resolveMcpLaunch(env: NodeJS.ProcessEnv = process.env): McpLaunchSpec {
  if (env.SUBSHELL_MCP_COMMAND) {
    return {
      command: env.SUBSHELL_MCP_COMMAND,
      args: env.SUBSHELL_MCP_ARGS ? (JSON.parse(env.SUBSHELL_MCP_ARGS) as string[]) : [],
    };
  }
  const sibling = join(dirname(process.execPath), MCP_BINARY);
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
  throw new Error(`cannot locate the ${MCP_BINARY} entrypoint; set SUBSHELL_MCP_COMMAND`);
}

/**
 * The SUBSHELL_* env the `subshell mcp` child reads (contract: `env.ts` in
 * `@internal/mcp-core`).
 * Single producer so the create path and the auto-restart path can never
 * drift apart on the variables the child depends on.
 */
export function subshellMcpEnv(apiKey: string, subshellId: string, subshellName: string): Record<string, string> {
  return {
    SUBSHELL_API_KEY: apiKey,
    SUBSHELL_BASE_URL: APP_BASE_URL,
    SUBSHELL_ID: subshellId,
    SUBSHELL_NAME: subshellName,
    SUBSHELL_DATA_DIR: SUBSHELL_SERVER_DATA_DIR,
  };
}

/**
 * Registers `subshell mcp` for one subshell launch, in the HARNESS'S OWN dialect:
 * the plugin renders the config file content (plus any argv/env that activates
 * it), and this writes the file. Returns the registration for the caller to
 * bake into the pane — or undefined for harnesses with no per-subshell format
 * (hermes, pi), which the UI explains via their one-time mcpSetup steps.
 * Content holds no secrets, but the file stays 0600 — least exposure is free.
 */
export function registerSubshellMcp(
  harness: HarnessPlugin,
  subshellId: string,
  launch: McpLaunchSpec = resolveMcpLaunch(),
): McpRegistration | undefined {
  const file = subshellMcpConfigPath(subshellId);
  const reg = harness.mcpRegistration?.(launch, file);
  if (!reg) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, reg.fileContent, { mode: 0o600 });
  return reg;
}

/** Where a subshell's MCP config lives (also the write target — one definition). */
export function subshellMcpConfigPath(subshellId: string): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "mcp", `${subshellId}.json`);
}

/**
 * The PURE (no-disk-write) mirror of {@link registerSubshellMcp} for AGENT
 * nodes (spec §6.4): computes the same harness dialect but against the
 * node's own filesystem — `subshell mcp` as the spawn command (its
 * `executablePath` from the `ready` facts, the bare name as fallback) and
 * `<dataDir>/mcp/<subshellId>.json` as the target path. Nothing is written
 * locally: `RemoteLauncher.launch` ships `reg.fileContent` inline with the
 * launch command — the launch command is the ONLY writer of node-side MCP
 * configs; `RemoteLauncher.subshellArtifacts` owns the layout for cleanup.
 * The capability gate and the debug-log note live in the
 * subshell manager, not here — this function answers "what would the
 * registration be", for any node facts handed to it.
 * @param harness - The resolved plugin (its `mcpRegistration` dialect)
 * @param subshellId - The subshell the config is generated for
 * @param facts - The node's live `ready` facts (dataDir + executablePath)
 * @returns the registration plus the node-side path, or undefined for
 *          harnesses with no per-subshell format (hermes, pi)
 */
export function planRemoteSubshellMcp(
  harness: HarnessPlugin,
  subshellId: string,
  facts: Pick<NodeAgentFacts, "dataDir" | "executablePath">,
): { reg: McpRegistration; configPath: string } | undefined {
  const launch: McpLaunchSpec = { command: facts.executablePath ?? "subshell", args: ["mcp"] };
  const configPath = `${facts.dataDir}/mcp/${subshellId}.json`;
  const reg = harness.mcpRegistration?.(launch, configPath);
  if (!reg) return undefined;
  return { reg, configPath };
}
