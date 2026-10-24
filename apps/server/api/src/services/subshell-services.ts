import { randomUUID } from "node:crypto";
import { normalizeLabel, normalizeServiceHost } from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { audit } from "@/services/audit.js";
import { publishLive } from "@/services/live-bus.js";
import { getPreviewBroker } from "@/services/preview-broker.js";

export const MAX_SAVED_SERVICES = 100;
export function listServices(subshellId: string) {
  return db
    .selectFrom("subshellServices")
    .selectAll()
    .where("subshellId", "=", subshellId)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();
}
export async function getService(subshellId: string, id: string) {
  const row = await db
    .selectFrom("subshellServices")
    .selectAll()
    .where("subshellId", "=", subshellId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new HttpError(404, "This saved service was removed. Add it again from Apps & screens.");
  return row;
}
export async function saveService(
  subshellId: string,
  input: { name?: string; host?: string; port: number; protocol: "http" | "https" },
  actorUserId: string | null = null,
) {
  const host = normalizeServiceHost(input.host ?? "localhost");
  if (!host) throw new HttpError(400, "Enter a hostname or IP address without a protocol, path, or credentials.");
  // The insert and limit check share one transaction: concurrent tabs cannot exceed the bound.
  const row = await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("subshellServices")
      .selectAll()
      .where("subshellId", "=", subshellId)
      .where("host", "=", host)
      .where("port", "=", input.port)
      .where("protocol", "=", input.protocol)
      .executeTakeFirst();
    if (existing) return existing;
    const count = await tx
      .selectFrom("subshellServices")
      .select(tx.fn.countAll<number>().as("n"))
      .where("subshellId", "=", subshellId)
      .executeTakeFirstOrThrow();
    if (count.n >= MAX_SAVED_SERVICES)
      throw new HttpError(409, "This subshell has 100 saved services. Remove one before adding another.");
    return tx
      .insertInto("subshellServices")
      .values({
        id: randomUUID(),
        subshellId,
        host,
        port: input.port,
        protocol: input.protocol,
        name: normalizeLabel(input.name ?? "", 80),
        createdAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  await audit({
    actorUserId,
    action: "subshell.service.save",
    targetType: "subshell",
    targetId: subshellId,
    metadataJson: JSON.stringify({ serviceId: row.id, host: row.host, port: row.port, protocol: row.protocol }),
  });
  publishLive({ kind: "subshell.changed", id: subshellId });
  return row;
}
export async function removeService(subshellId: string, id: string, actorUserId: string | null = null) {
  await db.deleteFrom("subshellServices").where("subshellId", "=", subshellId).where("id", "=", id).execute();
  await getPreviewBroker().removeService(subshellId, id);
  await audit({
    actorUserId,
    action: "subshell.service.remove",
    targetType: "subshell",
    targetId: subshellId,
    metadataJson: JSON.stringify({ serviceId: id }),
  });
  publishLive({ kind: "subshell.changed", id: subshellId });
  return { ok: true };
}
