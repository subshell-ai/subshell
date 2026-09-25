import { t } from "elysia";
import { ProviderKindSchema } from "@/api/auth-providers/provider-fields.js";
import type { AuthProviderRow } from "@/db/types/auth-providers.db-types.js";
import { asProviderKind } from "@/db/types/auth-providers.db-types.js";

/** Parse a stored JSON origin array defensively: a hand-corrupted column costs an empty list, never a 500. */
export function parseStoredOrigins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Both accepted wire spellings of `allowed_domains` (comma string, array)
 * converge into the validator's comma form; domains cannot contain a comma
 * (the validator refuses the separator), so the join is lossless. */
export function domainsInput(raw: string | string[]): string {
  return Array.isArray(raw) ? raw.join(",") : raw;
}

/** The stored comma list back to the view's array; "" (a hand edit) reads as null = any. */
export function storedDomainsToView(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
}

/** One provider as the admin list serves it — spec §8: the secret is NOT here. */
export const ProviderViewSchema = t.Object({
  id: t.String({ description: "Provider id slug; the callback path segment, immutable after create" }),
  kind: ProviderKindSchema,
  name: t.String({ description: "Display name shown on the sign-in page" }),
  issuer: t.Nullable(t.String({ description: "OIDC issuer URL; null only on the email row" })),
  clientId: t.Nullable(t.String({ description: "OAuth client id; null only on the email row" })),
  hasSecret: t.Boolean({ description: "Whether a client secret is stored. Never the secret itself" }),
  entryOrigins: t.Array(t.String({ description: "Bare origin, canonical URL.origin spelling" }), {
    description:
      "Origins this provider may be reached from; position 0 is canonical (spec §5a). Empty only on the email row",
  }),
  allowedDomains: t.Nullable(
    t.Array(t.String({ description: "One allowed e-mail domain, lowercase bare form" }), {
      description: "Allowed e-mail domains; null means any domain (spec §5)",
    }),
  ),
  enabled: t.Boolean({
    description: "Master switch: a disabled provider does nothing, however open its half-switches are",
  }),
  signInEnabled: t.Boolean({ description: "Whether this provider may sign accounts in" }),
  registrationEnabled: t.Nullable(
    t.Boolean({
      description:
        "Whether this provider may create accounts; null is the legacy dynamic gate, legal only on the email row",
    }),
  ),
  requireApproval: t.Boolean({ description: "Whether accounts this provider creates land on pending (spec §6)" }),
  endpointsResolved: t.Boolean({
    description: "Whether discovery endpoints were captured at save; drives the table's badge (spec §7)",
  }),
});

export function toView(row: AuthProviderRow) {
  return {
    id: row.id,
    kind: asProviderKind(row.kind),
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    hasSecret: row.clientSecret !== null,
    entryOrigins: parseStoredOrigins(row.entryOrigins),
    allowedDomains: storedDomainsToView(row.allowedDomains),
    enabled: row.enabled === 1,
    signInEnabled: row.signInEnabled === 1,
    registrationEnabled: row.registrationEnabled === null ? null : row.registrationEnabled === 1,
    requireApproval: row.requireApproval === 1,
    endpointsResolved: row.endpointsJson !== null && row.endpointsJson !== "",
  };
}
