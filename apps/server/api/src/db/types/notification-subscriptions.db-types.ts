/**
 * Database table schema for one browser's Web Push subscription.
 * Owned by the user who enabled notifications in that browser.
 */
export interface NotificationSubscriptionTable {
  /** Unique id (uuid) */
  id: string;
  /** Owner of this device subscription */
  userId: string;
  /** Push endpoint URL from pushManager.subscribe() (unique — a re-authorized browser replaces its row) */
  endpoint: string;
  /** P-256 ECDH public key (base64url) */
  p256dh: string;
  /** Auth secret (base64url) */
  auth: string;
  /** ISO 8601 timestamp when stored */
  createdAt: string;
}

/** Insert shape: createdAt is written by the repository (no DB default). */
export type NewNotificationSubscription = Omit<NotificationSubscriptionTable, "createdAt"> & {
  createdAt?: string;
};
