import { t } from "elysia";
export const PreviewConfigurationSchema = t.Object({
  host: t.String({ minLength: 1, maxLength: 253 }),
  protocol: t.Union([t.Literal("http"), t.Literal("https")]),
  ignoreCertificateErrors: t.Boolean(),
  sandbox: t.Boolean(),
  rewriteUrls: t.Boolean(),
  passHost: t.Boolean(),
  rewriteRedirects: t.Boolean(),
});
