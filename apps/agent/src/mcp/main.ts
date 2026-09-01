import { readMcpEnv } from "./env.js";
import { runMoteMcp } from "./server.js";

/**
 * `runAgentMcp` — the `mote-agent mcp` entry: the `mote mcp` stdio server
 * running INSIDE the compiled agent binary (spec §6.4), so a session launched
 * on an agent node gets the same cross-session tools a local session has.
 *
 * ---------------------------------------------------------------------------
 * SPIKE SUBSTITUTION TABLE (Task 13 Step 1 — the port contract, brief §"Interfaces")
 * ---------------------------------------------------------------------------
 * All seven backend modules (`apps/backend/src/mcp/`) were read in full before
 * porting. SURPRISE: none of them imported `@/constants.js`, `@/services/*`, or
 * `@/utils/logger.js` — the MCP tree was already self-contained on the pane-env
 * contract (`env.ts`) and raw `process.stderr.write`. So the sanctioned
 * "backend imports → pane env" rehoming had nothing to rehome; every
 * substitution below is either a module-path rewrite or an entry-point
 * decision. 10 substitutions total (≤ 10 budget):
 *
 *  1. `@/mcp/crypto.js`   → `./crypto.js`   (identity-store.ts, pin-store.ts, server.ts, tools.ts)
 *  2. `@/mcp/api-client.js` → `./api-client.js` (server.ts, tools.ts)
 *  3. `@/mcp/env.js`      → `./env.js`      (pin-store.ts, server.ts)
 *  4. `@/mcp/identity-store.js` → `./identity-store.js` (server.ts)
 *  5. `@/mcp/tools.js`    → `./tools.js`    (server.ts)
 *  6. `@/mcp/pin-store.js` → `./pin-store.js` (tools.ts)
 *  7. `env.ts` — PORTED VERBATIM, not replaced: it already IS the pane-env
 *     reader (MOTE_API_KEY / MOTE_BASE_URL / MOTE_SESSION_ID / MOTE_SESSION_NAME
 *     / MOTE_DATA_DIR, the contract `sessionMcpEnv` produces). Byte-identical
 *     copy (like api-client.ts and crypto.ts).
 *  8. Backend `mcp/main.ts` (top-level `runMoteMcp().catch(stderr; exit 1)`) →
 *     `runAgentMcp(): Promise<void>` here; the fatal-to-stderr+exit behavior
 *     moves to the CLI entry (`cli.ts` case "mcp" → `main.ts` catch), since the
 *     binary now serves several subcommands. The `server.ts` `runMoteMcp()`
 *     itself is copied verbatim (only its import specifiers changed).
 *  9. Identity semantics UNCHANGED — STOP clause checked and CLEARED:
 *     `loadOrCreateIdentity` creates-on-miss (ENOENT → `writeFresh`: generated
 *     P-256 keypair, mode 0600 — apps/agent/src/mcp/identity-store.ts), so a
 *     node session simply mints its OWN keypair under the agent dataDir and
 *     registers it via the existing `POST /api/identities` path in
 *     `runMoteMcp` — E2EE works with no launch-payload change. Files land at
 *     `${MOTE_DATA_DIR}/identities/sess-<id>.json` + `${MOTE_DATA_DIR}/peers.json`;
 *     on nodes `MOTE_DATA_DIR` is the agent's dataDir (session-manager override,
 *     Task 9), mirroring the local layout under the session's data dir.
 * 10. Dev-only additions (NOT in the ported files): `cli.ts` (command wiring,
 *     missing `MOTE_*` env → exit 2), `daemon.ts` (`HAS_MCP = true` → the
 *     `ready` frame advertises `["uploads", "mcp"]`), `package.json`
 *     (`@modelcontextprotocol/server` 2.0.0 + `zod` 4.4.3, exact backend pins).
 *
 * No plugin change: `mcpRegistration` composes the launch spec's command STRING
 * (`planRemoteSessionMcp` bakes `executablePath` + `["mcp"]`), which is already
 * correct for the compiled binary.
 * ---------------------------------------------------------------------------
 */
export async function runAgentMcp(): Promise<void> {
  // Fail fast on an incomplete pane env BEFORE touching stdio: the throw's
  // message ("mote mcp: MOTE_API_KEY is not set") is what the CLI maps to
  // exit 2. `runMoteMcp` reads the env again internally (its own copy is the
  // verbatim backend twin); the double read is idempotent per the read-once
  // contract in env.ts.
  readMcpEnv();
  await runMoteMcp();
}
