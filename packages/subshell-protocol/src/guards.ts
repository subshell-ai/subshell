/**
 * Internal type-guard kit for this package's hand-rolled validators
 * (`node-frames.ts`, `node-results.ts`) — one definition of each primitive,
 * shared instead of mirrored. Deliberately NOT exported from the package
 * index: these are validation plumbing, not wire contract. Consumers get
 * narrowed values from the `parse*` functions, never the guards themselves.
 */

/** Strict base64 (the alphabet used by `Buffer.toString("base64")` / `btoa`). */
export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isStr(value: unknown): value is string {
  return typeof value === "string";
}
export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function isInt(value: unknown): value is number {
  return isNum(value) && Number.isInteger(value);
}
export function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}
