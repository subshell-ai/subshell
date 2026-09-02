import { readMcpEnv, runMoteMcp } from "@internal/mcp-core";

/**
 * `runAgentMcp` — the `mote-agent mcp` entry: the `mote mcp` stdio server
 * running INSIDE the compiled agent binary (spec §6.4), so a session launched
 * on an agent node gets the same cross-session tools a local session has.
 *
 * This file used to carry a byte-identical copy of the seven backend MCP
 * modules plus a spike substitution table documenting every `@/mcp/*` →
 * `./x.js` rewrite. The copy is gone: backend and agent now share
 * `@internal/mcp-core` (the TmuxRunner precedent — extracted "so the node
 * agent can reuse it"), so there are no substitutions left to enumerate. What
 * remains true here:
 *
 * - The pane-env contract (MOTE_API_KEY / MOTE_BASE_URL / MOTE_SESSION_ID /
 *   MOTE_SESSION_NAME / MOTE_DATA_DIR — what `sessionMcpEnv` produces) is the
 *   package's `env.ts`; this entry only fail-fasts on it before touching stdio.
 * - Identity semantics UNCHANGED — `loadOrCreateIdentity` creates-on-miss
 *   (generated P-256 keypair, mode 0600), so a node session mints its OWN
 *   keypair under the agent dataDir and registers it via the existing
 *   `POST /api/identities` path inside `runMoteMcp` — E2EE works with no
 *   launch-payload change. Files land at `${MOTE_DATA_DIR}/identities/
 *   sess-<id>.json` + `${MOTE_DATA_DIR}/peers.json`; on nodes `MOTE_DATA_DIR`
 *   is the agent's dataDir (session-manager override), mirroring the local
 *   layout under the session's data dir.
 * - Fatal-to-stderr+exit behavior lives at the CLI entry (`cli.ts` case
 *   "mcp"), since the binary serves several subcommands; the missing-env
 *   throw maps to exit 2 there.
 *
 * No plugin change: `mcpRegistration` composes the launch spec's command
 * STRING (`planRemoteSessionMcp` bakes `executablePath` + `["mcp"]`), which is
 * correct for the compiled binary.
 */
export async function runAgentMcp(): Promise<void> {
  // Fail fast on an incomplete pane env BEFORE touching stdio: the throw's
  // message ("mote mcp: MOTE_API_KEY is not set") is what the CLI maps to
  // exit 2. `runMoteMcp` reads the env again internally; the double read is
  // idempotent per the read-once contract in the package's env.ts.
  readMcpEnv();
  await runMoteMcp();
}
