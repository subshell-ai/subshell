import type { JsonValue } from "@internal/subshell-protocol";
/** JSON-safe machine operation outcome, validated before it crosses a transport. */
export type MachineSshResult = { ok: true; data?: JsonValue } | { ok: false; error: string };
