/** OS the token was minted on — recorded for diagnostics; Expo routes by token. */
export type DevicePlatform = "ios" | "android";

/**
 * Database table schema for one enrolled native device (Expo push token).
 * Owned by the user who last signed in on it.
 */
export interface DeviceTokenTable {
  /** Unique row id (uuid) */
  id: string;
  /** Owner of this device */
  userId: string;
  /** Expo push token (`ExponentPushToken[...]`) — globally unique */
  token: string;
  /** OS the token belongs to */
  platform: DevicePlatform;
  /** ISO 8601 timestamp when first stored */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent (re-)enrollment */
  updatedAt: string;
}
