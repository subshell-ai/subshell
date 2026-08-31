import { runMoteMcp } from "@/mcp/server.js";

/**
 * Standalone entrypoint for the compiled `mote-mcp` binary (and `bun
 * src/mcp/main.ts` in dev). Deliberately imports ONLY the mcp modules — no
 * db/auth/server chain — so a client process never opens the app database.
 */
runMoteMcp().catch((err: unknown) => {
  process.stderr.write(`mote mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
