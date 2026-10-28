/**
 * What counts as a web page for previews, said once.
 *
 * Discovery and forwarding both refuse anything else, so the two have to
 * agree: a type the probe will not list is a port nobody can pick, and a type
 * the proxy will not navigate to turns a working site into an error page. The
 * rule lives here rather than beside either caller because a third reader
 * (another client, a future check) should ask the same question of the same
 * answer.
 *
 * XHTML is in the set because a browser renders `application/xhtml+xml` as
 * HTML: older Java app servers and XML pipelines still serve documents that
 * way, and refusing them would hide a site that works.
 */

/** The media types a browser paints as a document, in the order a client offers them. */
export const PREVIEW_DOCUMENT_TYPES = ["text/html", "application/xhtml+xml"] as const;

/** What the discovery probe offers, so a document-only server answers it. */
export const PREVIEW_DOCUMENT_ACCEPT = PREVIEW_DOCUMENT_TYPES.join(",");

/** Matched against a whole type, so parameters are allowed and prefixes are not. */
const DOCUMENT_TYPE = new RegExp(
  `^(?:${PREVIEW_DOCUMENT_TYPES.map((type) => type.replace(/[+.*?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\\s*;|\\s*$)`,
  "i",
);

/**
 * Does this `Content-Type` name a document a preview may show? A missing or
 * non-string header answers false, and a type that merely starts with an
 * accepted name (`text/html-fragment`) does not pass.
 */
export function isPreviewDocumentContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && DOCUMENT_TYPE.test(contentType);
}

/**
 * Does this request's `Accept` list ask for a document? Loose on purpose, the
 * way the caller already is: a browser sends a weighted list, and this only
 * decides whether the response is a navigation worth guarding.
 */
export function acceptsPreviewDocument(accept: string | null | undefined): boolean {
  return typeof accept === "string" && PREVIEW_DOCUMENT_TYPES.some((type) => accept.includes(type));
}

/** `attachment`, alone or with parameters: the server is handing over a file. */
const ATTACHMENT_DISPOSITION = /^attachment(?:\s*;|\s*$)/i;

/**
 * Does this `Content-Disposition` ask for a download? A yes here outranks the
 * type: a server that labels its HTML an attachment means it, and handing that
 * to an iOS PWA puts the person in Quick Look with no way back.
 */
export function isPreviewAttachmentDisposition(disposition: string | null | undefined): boolean {
  return typeof disposition === "string" && ATTACHMENT_DISPOSITION.test(disposition);
}
