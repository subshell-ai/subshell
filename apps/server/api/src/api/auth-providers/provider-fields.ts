import { t } from "elysia";

/** The booleans the wire speaks → the 0/1 the row stores. */
export const b2n = (value: boolean): number => (value ? 1 : 0);

export const ProviderKindSchema = t.Union([t.Literal("email"), t.Literal("google"), t.Literal("oidc")], {
  description:
    'Provider kind: the reserved "email" credential row, or an OIDC/genericOAuth provider ("google" is the preset id, driven the same way)',
});

/** The POST body field set; PATCH is its Partial (id/kind immutable there). */
export const CreateProviderFieldsSchema = t.Object({
  id: t.Optional(
    t.String({
      description:
        "Id slug to store. Defaults to the slugified name; the create dialog sends its own preview so the registration panel's prediction is the stored truth. Lowercase [a-z0-9-], at most 40 characters, and not the reserved email id",
    }),
  ),
  kind: ProviderKindSchema,
  name: t.String({
    description:
      "Display name shown on the sign-in page; stored through the shared label normalizer (format characters dropped, control characters to spaces, whitespace collapsed) and capped at 120 code points; refused when nothing remains after normalization",
  }),
  issuer: t.Optional(
    t.String({ description: "OIDC issuer URL. Required for google/oidc kinds; discovery runs against it at save" }),
  ),
  clientId: t.Optional(t.String({ description: "OAuth client id. Required for google/oidc kinds" })),
  clientSecret: t.Optional(
    t.String({
      description:
        "OAuth client secret. Required for google/oidc kinds on create. On PATCH an empty string means leave the stored secret untouched; it is never read back, only replaced",
    }),
  ),
  entryOrigins: t.Optional(
    t.Array(t.String({ description: "One entry origin; http(s), bare host[:port], canonicalized to URL.origin" }), {
      description:
        "Origins this provider is reached from. When none are sent, the instance's own APP_BASE_URL origin is used; position 0 is the canonical one the redirect URI is built from (spec §5a)",
    }),
  ),
  allowedDomains: t.Optional(
    t.Union(
      [
        t.String({ description: "Comma-separated e-mail domains" }),
        t.Array(t.String({ description: "One allowed e-mail domain, bare form" }), {
          description: "The domain list as an array",
        }),
      ],
      {
        description:
          "Allowed e-mail domains (spec §5), comma-separated string or array. The dialog sends either; both are normalized to lowercase bare form and deduped. An empty string or empty array CLEARS the column to NULL (= any domain), never a stored empty value",
      },
    ),
  ),
  enabled: t.Boolean({ description: "Master switch for this provider" }),
  signInEnabled: t.Boolean({ description: "Whether this provider may sign accounts in" }),
  registrationEnabled: t.Optional(
    t.Boolean({
      description:
        "Whether this provider may create accounts. Omitted on create means false; OIDC rows always carry an explicit value (spec §2)",
    }),
  ),
  requireApproval: t.Boolean({
    description: "Whether accounts created through this provider land on pending (spec §6)",
  }),
});

/** PATCH /api/auth-providers/:id body: a partial of the create fields. */
export const PatchProviderSchema = t.Partial(CreateProviderFieldsSchema);
