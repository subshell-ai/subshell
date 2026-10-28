/** Live terminal access leases, including connections still resolving their identity. */
interface TerminalAccess {
  paneId: string;
  userId: () => string | undefined;
  revoke: () => void;
}
const terminals = new Set<TerminalAccess>();

/** Register before authentication awaits; release on refusal, failure or disconnect. */
export function trackTerminalAccess(paneId: string, userId: TerminalAccess["userId"], revoke: () => void): () => void {
  const entry = { paneId, userId, revoke };
  terminals.add(entry);
  return () => {
    terminals.delete(entry);
  };
}

/** Grantees reconnect through the current share gate; the owner's access is unchanged. */
export function invalidateSharedTerminalAccess(paneId: string, ownerId: string): void {
  for (const entry of [...terminals]) {
    if (entry.paneId !== paneId || entry.userId() === ownerId) continue;
    terminals.delete(entry);
    entry.revoke();
  }
}

/** @internal Test isolation for transports that leave fake sockets registered. */
export function resetTerminalAccessForTests(): void {
  terminals.clear();
}
