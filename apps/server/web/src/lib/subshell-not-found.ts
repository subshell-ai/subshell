import { ApiError } from "@internal/node-admin";

/**
 * True when a subshell fetch was answered with 404. The backend answers 404 —
 * never 403 — for BOTH a deleted and a not-shared-with-me subshell (spec
 * 2026-08-31 sharing), so one flag honestly covers both readings. Anything
 * else (5xx, network) is transient and must stay on the reconnect path.
 * Extracted as a pure predicate so `bun test` covers the branch without a
 * DOM (the lib/shell-gate.ts precedent).
 */
export function isNotFoundSubshellError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
