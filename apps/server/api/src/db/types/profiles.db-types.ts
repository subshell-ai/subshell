/**
 * Database table schema for harness profiles.
 *
 * A profile captures how a harness is launched: extra environment variables,
 * CLI flags, a settings JSON blob, and whether config source isolation is
 * wanted. All profiles belong to a user (multi-user ready).
 */
export interface ProfileTable {
  /** Unique profile id (uuid) */
  id: string;
  /** Owning user id (better-auth user id) */
  userId: string;
  /** Harness plugin id this profile applies to, e.g. "claude-code" */
  harnessId: string;
  /** Human-friendly profile name (unique per user + harness) */
  name: string;
  /** Optional longer description */
  description: string | null;
  /** JSON object of extra environment variables to set on the subshell */
  envJson: string | null;
  /** JSON array of extra CLI flags to pass to the harness */
  flagsJson: string | null;
  /** JSON object of settings passed to the harness (e.g. claude --settings) */
  settingsJson: string | null;
  /** 1 = only this profile's config sources (no default ~/.claude files) */
  configIsolation: number;
  /** 1 = new subshells from this profile auto-restart on exit */
  restartOnExit: number;
  /** 1 = auto-seeded default profile — editable, but DELETE refuses it */
  isDefault: number;
  /** Node this profile is pinned to; null = any launch-eligible node */
  nodeId: string | null;
  /** ISO 8601 timestamp when the profile was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill createdAt/updatedAt/restartOnExit/isDefault (and node pin) when omitted. */
export type NewProfile = Omit<ProfileTable, "createdAt" | "updatedAt" | "restartOnExit" | "isDefault" | "nodeId"> & {
  restartOnExit?: number;
  isDefault?: number;
  /** Node pin; omitted = NULL (any launch-eligible node) */
  nodeId?: string | null;
};
export type ProfileUpdate = Partial<Omit<NewProfile, "id" | "userId" | "harnessId">>;

/** Parsed, runtime-friendly profile shape (JSON blobs decoded). */
export interface ProfileParsed {
  id: string;
  userId: string;
  harnessId: string;
  name: string;
  description: string | null;
  env: Record<string, string>;
  flags: string[];
  settings: Record<string, unknown> | null;
  configIsolation: boolean;
}
