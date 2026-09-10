import { readMcpEnv, runSubshellMcp } from "@internal/mcp-core";

/**
 * `runAgentMcp` — the `subshell mcp` entry: the `subshell mcp` stdio server
 * running INSIDE the compiled agent binary (spec §6.4), so a subshell launched
 * on an agent node gets the same cross-subshell tools a local subshell has.
 *
 * This file used to carry a byte-identical copy of the seven backend MCP
 * modules plus a spike substitution table documenting every `@/mcp/*` →
 * `./x.js` rewrite. The copy is gone: backend and agent now share
 * `@internal/mcp-core` (the TmuxRunner precedent — extracted "so the node
 * agent can reuse it"), so there are no substitutions left to enumerate. What
 * remains true here:
 *
 * - The pane-env contract (SUBSHELL_API_KEY / SUBSHELL_BASE_URL / SUBSHELL_ID /
 *   SUBSHELL_NAME / SUBSHELL_DATA_DIR — what `subshellMcpEnv` produces) is the
 *   package's `env.ts`; this entry only fail-fasts on it before touching stdio.
 * - Identity semantics UNCHANGED — `loadOrCreateIdentity` creates-on-miss
 *   (generated P-256 keypair, mode 0600), so a node subshell mints its OWN
 *   keypair under the agent dataDir and registers it via the existing
 *   `POST /api/identities` path inside `runSubshellMcp` — E2EE works with no
 *   launch-payload change. Files land at `${SUBSHELL_DATA_DIR}/identities/
 *   sess-<id>.json` + `${SUBSHELL_DATA_DIR}/peers.json`; on nodes `SUBSHELL_DATA_DIR`
 *   is the agent's dataDir (subshell-manager override), mirroring the local
 *   layout under the subshell's data dir.
 * - Fatal-to-stderr+exit behavior lives at the CLI entry (`cli.ts` case
 *   "mcp"), since the binary serves several subcommands; the missing-env
 *   throw maps to exit 2 there.
 *
 * No plugin change: `mcpRegistration` composes the launch spec's command
 * STRING and args from the `McpLaunchSpec` (`planRemoteSubshellMcp` bakes the
 * agent's ready-reported `mcpLaunch` — its full `selfInvocation("mcp")`, or
 * the `subshell` mcp fallback), which is right for a compiled binary AND for
 * a bun-interpreted run, because the agent answered the shape, not a bare
 * execPath.
 */
export async function runAgentMcp(): Promise<void> {
  // Fail fast on an incomplete pane env BEFORE touching stdio: the throw's
  // message ("subshell mcp: SUBSHELL_API_KEY is not set") is what the CLI maps to
  // exit 2. `runSubshellMcp` reads the env again internally; the double read is
  // idempotent per the read-once contract in the package's env.ts.
  readMcpEnv();
  await runSubshellMcp();
}
