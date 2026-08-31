/**
 * The multi-instance registry (spec §Decisions: multi-instance is
 * first-class). Non-secret by design — origins, labels, the last-used email —
 * so it lives in AsyncStorage, not the Keychain. `id` IS the normalized
 * origin: one instance = one origin.
 */
export interface InstanceRecord {
  /** Normalized origin (from normalizeInstanceOrigin) — also the store key. */
  id: string;
  /** User-visible name (defaults to the host part). */
  label: string;
  /** Last email signed in here — prefills the sign-in form. */
  email: string | null;
  /** Persisted probe verdict: this instance tunnels no WS upgrades. */
  wsBlocked: boolean;
  /** Plain-HTTP origin — the connection screen marks it (token crosses in clear). */
  plainHttp: boolean;
}

/** Registry cap — beyond ten origins the operator is inventory-keeping, not switching. */
const MAX_INSTANCES = 10;

/** Inserts/refreshes `rec` at the head (most-recent-first). Returns a new array. */
export function upsertInstance(list: readonly InstanceRecord[], rec: InstanceRecord): InstanceRecord[] {
  return [rec, ...list.filter((r) => r.id !== rec.id)].slice(0, MAX_INSTANCES);
}

/** Removes one origin entry (long-press delete on the connect screen). */
export function removeInstance(list: readonly InstanceRecord[], id: string): InstanceRecord[] {
  return list.filter((r) => r.id !== id);
}
