import { normalizeServiceHost } from "./service-target.js";

export interface PreviewConfiguration {
  host: string;
  protocol: "http" | "https";
  ignoreCertificateErrors: boolean;
  sandbox: boolean;
  rewriteUrls: boolean;
  passHost: boolean;
  rewriteRedirects: boolean;
}
export const DEFAULT_PREVIEW_CONFIGURATION: Readonly<PreviewConfiguration> = Object.freeze({
  host: "localhost",
  protocol: "http",
  ignoreCertificateErrors: false,
  sandbox: true,
  rewriteUrls: true,
  passHost: false,
  rewriteRedirects: true,
});
export function parsePreviewConfiguration(value: unknown): PreviewConfiguration | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.host !== "string" || !normalizeServiceHost(v.host) || (v.protocol !== "http" && v.protocol !== "https"))
    return null;
  const host = normalizeServiceHost(v.host);
  if (!host) return null;
  for (const key of ["ignoreCertificateErrors", "sandbox", "rewriteUrls", "passHost", "rewriteRedirects"]) {
    if (typeof v[key] !== "boolean") return null;
  }
  if (v.protocol === "http" && v.ignoreCertificateErrors) return null;
  return {
    host,
    protocol: v.protocol,
    ignoreCertificateErrors: v.ignoreCertificateErrors as boolean,
    sandbox: v.sandbox as boolean,
    rewriteUrls: v.rewriteUrls as boolean,
    passHost: v.passHost as boolean,
    rewriteRedirects: v.rewriteRedirects as boolean,
  };
}
