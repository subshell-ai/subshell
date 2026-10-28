import { normalizeServiceHost } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { HttpError } from "@/shared/errors.js";

export interface PreviewProxySettings {
  rewriteUrls: boolean;
  passHost: boolean;
  rewriteRedirects: boolean;
}
export const DEFAULT_PREVIEW_PROXY_SETTINGS: Readonly<PreviewProxySettings> = Object.freeze({
  rewriteUrls: true,
  passHost: false,
  rewriteRedirects: true,
});
export const PREVIEW_SETTINGS_PER_USER = 256;
export interface PreviewSettingsTarget {
  userId: string;
  nodeId: string;
  host: string;
  protocol: "http" | "https";
  port: number;
}
function key(target: PreviewSettingsTarget): PreviewSettingsTarget {
  const host = normalizeServiceHost(target.host);
  if (!host) throw new HttpError(400, "This preview's host isn't valid.");
  return { ...target, host };
}
export async function readPreviewProxySettings(target: PreviewSettingsTarget): Promise<PreviewProxySettings> {
  const row = await db
    .selectFrom("previewProxySettings")
    .selectAll()
    .where((eb) => eb.and({ ...key(target) }))
    .executeTakeFirst();
  return row
    ? { rewriteUrls: !!row.rewriteUrls, passHost: !!row.passHost, rewriteRedirects: !!row.rewriteRedirects }
    : { ...DEFAULT_PREVIEW_PROXY_SETTINGS };
}
export async function savePreviewProxySettings(
  target: PreviewSettingsTarget,
  settings: PreviewProxySettings | null,
): Promise<PreviewProxySettings> {
  const targetKey = key(target);
  await db.transaction().execute(async (trx) => {
    if (!settings) {
      await trx
        .deleteFrom("previewProxySettings")
        .where((eb) => eb.and({ ...targetKey }))
        .execute();
      return;
    }
    const existing = await trx
      .selectFrom("previewProxySettings")
      .select("port")
      .where((eb) => eb.and({ ...targetKey }))
      .executeTakeFirst();
    if (!existing) {
      const count = await trx
        .selectFrom("previewProxySettings")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("userId", "=", target.userId)
        .executeTakeFirstOrThrow();
      if (count.count >= PREVIEW_SETTINGS_PER_USER)
        throw new HttpError(
          409,
          "You've saved settings for too many previews. Reset an unused preview to save another.",
        );
    }
    const values = {
      rewriteUrls: Number(settings.rewriteUrls),
      passHost: Number(settings.passHost),
      rewriteRedirects: Number(settings.rewriteRedirects),
    };
    await trx
      .insertInto("previewProxySettings")
      .values({ ...targetKey, ...values })
      .onConflict((oc) => oc.columns(["userId", "nodeId", "host", "protocol", "port"]).doUpdateSet(values))
      .execute();
  });
  return settings ?? { ...DEFAULT_PREVIEW_PROXY_SETTINGS };
}
