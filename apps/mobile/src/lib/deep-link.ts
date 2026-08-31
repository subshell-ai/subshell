/**
 * `mote://session/<id>` — the notification/deep-link route (spec §Security
 * notes): the link carries a UUID only; opening it still passes the
 * biometric gate downstream. expo-router matches the path natively; this
 * parser guards the push-response handler which sees raw URLs.
 */

const SESSION_RE =
  /^mote:\/\/session\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#].*)?$/;

/** @param url - Raw incoming link @returns The session id when the link names exactly one, else null. */
export function parseSessionDeepLink(url: string): string | null {
  return SESSION_RE.exec(url)?.[1]?.toLowerCase() ?? null;
}

/** Builds the link for a session (notification payloads, tests). */
export function sessionDeepLink(id: string): string {
  return `mote://session/${id}`;
}
