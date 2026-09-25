/**
 * `@internal/mcp-core` — the `subshell mcp` stdio server implementation, shared by
 * the server binary's mcp subcommand and the agent's mcp subcommand
 * (the TmuxRunner precedent: extracted so both apps consume one copy).
 *
 * The tree is deliberately self-contained: it speaks the pane-env contract
 * (`env.ts`: SUBSHELL_API_KEY / SUBSHELL_BASE_URL / SUBSHELL_ID / SUBSHELL_NAME
 * / SUBSHELL_DATA_DIR), raw `process.stderr.write`, node builtins, `jose`,
 * `zod` and `@modelcontextprotocol/server` — no db/auth/server chain, so a
 * client process never opens the app database.
 */

export * from "./api-client.js";
export * from "./channel-tools.js";
export * from "./crypto.js";
export * from "./env.js";
export * from "./identity-store.js";
export * from "./pin-store.js";
export * from "./report.js";
export * from "./server.js";
export * from "./subshell-tools.js";
export * from "./tools.js";
