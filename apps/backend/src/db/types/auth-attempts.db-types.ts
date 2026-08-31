/**
 * Database table schema for failed sign-in tracking.
 *
 * Used by the sign-in rate limiter (exponential backoff per email).
 */
export interface AuthAttemptsTable {
  /** Lowercased email all failed sign-in attempts are attributed to */
  email: string;
  /** Number of consecutively failed sign-in attempts (0 = none recorded) */
  attemptCount: number;
  /** ISO 8601 timestamp of the most recent failed attempt (null before the first) */
  lastAttemptAt: string | null;
}

export type NewAuthAttempt = Omit<AuthAttemptsTable, "attemptCount" | "lastAttemptAt"> & {
  attemptCount?: number;
  lastAttemptAt?: string | null;
};
