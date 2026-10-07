import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { db } from "@/db/index.js";
import { SshSavedLocationsRepository } from "@/db/repositories/ssh-saved-locations.repository.js";
import { sshResolve } from "./discovery.service.js";
import { resolveDestinationDir } from "./launch-dir.js";
import { getSession } from "./session-registry.js";
import { openSession } from "./sessions.service.js";
import { getSessionView, listSessions, requireOwnedSession } from "./sessions-lifecycle.js";
import type { SshCaller } from "./ssh-actor.js";

export const savedLocationsRepository = new SshSavedLocationsRepository(db);
function refuse(code: BackendErrorCodes, message: string): never {
  throwApiError({ code, message, doNotLog: true });
}
export async function saveLocation(userId: string, sessionId: string, path: string) {
  const session = requireOwnedSession(sessionId, userId);
  const canonicalPath = await resolveDestinationDir(session, path);
  const row = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    originKind: session.connectingNodeId.startsWith("desktop:") ? ("desktop" as const) : ("node" as const),
    originId: session.connectingNodeId,
    alias: session.target.alias,
    host: session.target.host,
    port: session.target.port,
    user: session.target.user,
    path: canonicalPath,
    createdAt: new Date().toISOString(),
  };
  const existing = (await savedLocationsRepository.list(userId)).find(
    (l) =>
      l.originKind === row.originKind && l.originId === row.originId && sameDestination(l, row) && l.path === row.path,
  );
  return existing ?? (await savedLocationsRepository.create(row));
}
/** Exact destination identity is required for reconnect and reuse. */
export function sameDestination(
  a: { host: string; port: number; user: string | null },
  b: { host: string; port: number; user: string | null },
) {
  return a.host === b.host && a.port === b.port && a.user === b.user;
}
export async function connectLocation(caller: SshCaller, id: string) {
  const location = await savedLocationsRepository.find(id, caller.userId);
  if (!location) refuse(BackendErrorCodes.NOT_FOUND_ERROR, "Saved location not found.");
  const active = (await listSessions(caller.userId)).find(
    (s) =>
      s.status === "active" &&
      s.connectingNodeId === location.originId &&
      sameDestination(s, location) &&
      getSession(s.id)?.status === "active",
  );
  if (active) return { location, session: await getSessionView(active.id, caller.userId) };
  const resolved = await sshResolve(caller, { nodeId: location.originId, alias: location.alias });
  if (!resolved.accepted)
    refuse(
      BackendErrorCodes.EXISTS_ERROR,
      "This SSH host needs setup again. Connect and review its destination before launching.",
    );
  if (!sameDestination(resolved.snapshot, location))
    refuse(
      BackendErrorCodes.EXISTS_ERROR,
      "This SSH alias now points to a different destination. Connect and review the new destination before saving it again.",
    );
  const session = await openSession(caller.userId, {
    connectingNodeId: location.originId,
    target: {
      alias: location.alias,
      host: location.host,
      port: location.port,
      user: location.user,
      identityFile: resolved.snapshot.identityFiles[0] ?? null,
    },
  });
  return { location, session };
}
