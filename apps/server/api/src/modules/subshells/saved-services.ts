import { randomUUID } from "node:crypto";
import {
  normalizeLabel,
  normalizeServiceHost,
  type PreviewConfiguration,
  parsePreviewConfiguration,
} from "@internal/subshell-protocol";
import { publishLive } from "@/app/live-bus.js";
import { db } from "@/db/index.js";
import { audit } from "@/modules/audit.js";
import { getPreviewBroker } from "@/modules/previews/preview-broker.js";
import { HttpError } from "@/shared/errors.js";

export const MAX_SAVED_SERVICES = 100;
function serviceView<T extends { ignoreCertificateErrors: number; configuration: string | null }>(row: T) {
  const { ignoreCertificateErrors, configuration, ...rest } = row;
  return {
    ...rest,
    ignoreCertificateErrors: ignoreCertificateErrors === 1,
    configuration: configuration ? parsePreviewConfiguration(JSON.parse(configuration)) : null,
  };
}

export async function listServices(subshellId: string) {
  const rows = await db
    .selectFrom("subshellServices")
    .selectAll()
    .where("subshellId", "=", subshellId)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();
  return rows.map(serviceView);
}
export async function getService(subshellId: string, id: string) {
  const row = await db
    .selectFrom("subshellServices")
    .selectAll()
    .where("subshellId", "=", subshellId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new HttpError(404, "This saved service was removed. Add it again from Web previews & screens.");
  return serviceView(row);
}
export async function saveService(
  subshellId: string,
  input: {
    expectedRevision?: number;
    name?: string;
    host?: string;
    port: number;
    protocol: "http" | "https";
    ignoreCertificateErrors?: boolean;
    configuration?: PreviewConfiguration;
  },
  actorUserId: string | null = null,
  serviceId?: string,
) {
  const host = normalizeServiceHost(input.host ?? "localhost");
  if (!host) throw new HttpError(400, "Enter a hostname or IP address without a protocol, path, or credentials.");
  if (input.ignoreCertificateErrors && input.protocol !== "https") {
    throw new HttpError(400, "Ignoring certificate validation is only available for HTTPS services.");
  }
  const ignoreCertificateErrors = input.ignoreCertificateErrors === true ? 1 : 0;
  const configuration = input.configuration
    ? parsePreviewConfiguration({
        ...input.configuration,
        host,
        protocol: input.protocol,
        ignoreCertificateErrors: !!ignoreCertificateErrors,
      })
    : null;
  if (input.configuration && !configuration) throw new HttpError(400, "Choose valid preview options.");
  const values = {
    host,
    port: input.port,
    protocol: input.protocol,
    ignoreCertificateErrors,
    configuration: configuration ? JSON.stringify(configuration) : null,
    name: normalizeLabel(input.name ?? "", 80),
  };
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
    if (serviceId) {
      const previous = await tx
        .selectFrom("subshellServices")
        .selectAll()
        .where("subshellId", "=", subshellId)
        .where("id", "=", serviceId)
        .executeTakeFirst();
      if (!previous) throw new HttpError(404, "This saved service was removed.");
      if (input.expectedRevision !== previous.revision)
        throw new HttpError(409, "This saved service changed. Reopen the editor before saving again.");
      if (existing && existing.id !== serviceId)
        throw new HttpError(409, "This destination is already saved. Edit that service instead.");
      return tx
        .updateTable("subshellServices")
        .set({ ...values, revision: previous.revision + 1 })
        .where("id", "=", serviceId)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (existing) {
      if (
        existing.name !== values.name ||
        existing.ignoreCertificateErrors !== ignoreCertificateErrors ||
        existing.configuration !== values.configuration
      ) {
        throw new HttpError(
          409,
          "This destination is already saved with different preview settings. Edit the saved service instead.",
        );
      }
      return existing;
    }
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
        ...values,
        createdAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  if (serviceId) await getPreviewBroker().removeService(subshellId, serviceId);
  await audit({
    actorUserId,
    action: serviceId ? "subshell.service.update" : "subshell.service.save",
    targetType: "subshell",
    targetId: subshellId,
    metadataJson: JSON.stringify({
      serviceId: row.id,
      host: row.host,
      port: row.port,
      protocol: row.protocol,
      ignoreCertificateErrors: row.ignoreCertificateErrors === 1,
      sandbox: configuration?.sandbox ?? true,
    }),
  });
  publishLive({ kind: "subshell.changed", id: subshellId });
  return serviceView(row);
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
