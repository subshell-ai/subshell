/**
 * Channel crypto for the e2e suite. The hand-maintained mirror of
 * `packages/mcp-core/src/crypto.ts` is deleted — e2e now consumes the same
 * module the backend and the agent run (via `@internal/mcp-core`), so drift
 * between the specs and the server is structurally impossible: the tests
 * produce and consume the exact General-JWE envelopes the backend stores and
 * relays because they are encrypted and decrypted by the very same code.
 */
export { generateKeypair, open, seal } from "@internal/mcp-core";
