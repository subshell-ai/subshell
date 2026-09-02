import { runSubshellMcp } from "@internal/mcp-core";

/**
 * Standalone entrypoint for the compiled `subshell-mcp` binary (and `bun
 * src/mcp/main.ts` in dev). Deliberately imports ONLY `@internal/mcp-core` —
 * no db/auth/server chain — so a client process never opens the app database.
 * The implementation (api-client/crypto/env/identity-store/pin-store/server/
 * tools) lives in that package, shared with the agent's `subshell mcp`.
 */
runSubshellMcp().catch((err: unknown) => {
  process.stderr.write(`subshell mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
