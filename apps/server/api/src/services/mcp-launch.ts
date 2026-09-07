import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessPlugin, McpLaunchSpec, McpRegistration } from "@internal/harnesses";
import { APP_BASE_URL, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { resolveMcpLaunch } from "@/services/mcp-resolve.js";
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
 * The SUBSHELL_* env the `subshell mcp` child reads (contract: `env.ts` in
 * `@internal/mcp-core`).
 * Single producer so the create path and the auto-restart path can never
 * drift apart on the variables the child depends on. (HOW the command itself
 * is found lives in `mcp-resolve.ts` — the pure, side-effect-free half.)
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
