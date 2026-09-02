import { runMoteMcp } from "@internal/mcp-core";

/**
 * Standalone entrypoint for the compiled `mote-mcp` binary (and `bun
 * src/mcp/main.ts` in dev). Deliberately imports ONLY `@internal/mcp-core` —
 * no db/auth/server chain — so a client process never opens the app database.
 * The implementation (api-client/crypto/env/identity-store/pin-store/server/
 * tools) lives in that package, shared with the agent's `subshell mcp`.
 */
runMoteMcp().catch((err: unknown) => {
  process.stderr.write(`mote mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
