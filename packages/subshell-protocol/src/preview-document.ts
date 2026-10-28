/**
 * What counts as a web page for previews, said once.
 *
 * Discovery and the navigation guard both ask this of a response, so the two
 * cannot disagree: a type the probe will not list is a port nobody can pick,
 * and a type the proxy will not navigate to turns a working site into an error
 * page. The rule lives here rather than beside either caller because a third
 * reader (another client, a future check) should ask the same question of the
 * same answer. Each caller then asks its own second question, and the answers
 * differ on purpose: discovery lists a port only when its document answers with
 * a 2xx, since an error page is no site to advertise, while the proxy guards a
 * navigation the person already chose, so a 401 or a crash page is theirs to
 * read, and only a stranding client's non-document navigation is refused with a
 * page they can close. The rewriter covers the whole set, but it has to ask
 * which parser the document will meet: the shim it injects is inline script, and
 * inline script is CDATA to an XML parser.
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
 * Does this request's `Accept` list ask for a document? Each comma-separated
 * entry is read as a whole media type, parameters and all, so a wildcard offer
 * is not a request for HTML, and neither is a type that merely begins with one.
 * A browser navigating sends `text/html` explicitly, which is what this is for.
 */
export function acceptsPreviewDocument(accept: string | null | undefined): boolean {
  if (typeof accept !== "string") return false;
  return accept.split(",").some((entry) => isPreviewDocumentContentType(entry.split(";")[0]?.trim()));
}

/** XHTML, the one document in the set a browser parses as strict XML. */
const XML_DOCUMENT_TYPE = /^application\/xhtml\+xml(?:\s*;|\s*$)/i;

/**
 * Will this document be parsed as XML rather than HTML? It decides how the
 * rewriter must inject its shim: inline script content is CDATA to an XML
 * parser, where a raw `<` or `&` is a fatal error rather than JavaScript.
 */
export function isPreviewXmlDocumentContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && XML_DOCUMENT_TYPE.test(contentType);
}

/** The message a refusal page posts to the dashboard that embedded the frame. */
export const PREVIEW_REFUSAL_MESSAGE = "subshell:preview-refused";

/** The two things the refusal page can say it refused, and nothing else. */
export const PREVIEW_REFUSAL_REASONS = ["download", "not-a-page"] as const;

/** A refusal reason as the wire names it. */
export type PreviewRefusalReason = (typeof PREVIEW_REFUSAL_REASONS)[number];

/** Is this a reason we know how to explain? Payloads from a frame are data. */
export function isPreviewRefusalReason(value: unknown): value is PreviewRefusalReason {
  return typeof value === "string" && (PREVIEW_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** The clients whose presentation a handed-off file can hijack with no way back. */
const STRANDING_CLIENT = /iPhone|iPod|iPad/i;

/**
 * Is this navigation from a client that can be stranded by a file? On iOS a
 * download or an unknown type handed to the frame can be taken up by the system
 * viewer, and in a home-screen PWA there is no back button to press. A desktop
 * browser keeps the download in its own UI and leaves the page where it was, so
 * the same response is left alone there.
 *
 * The gap worth knowing: an iPad offering its desktop UA says `Macintosh`, and
 * nothing in the request tells the two apart, so it downloads like a desktop.
 */
export function isPreviewStrandingClient(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && STRANDING_CLIENT.test(userAgent);
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

/** Type families a browser presents in the frame itself, no system handler. */
const SELF_PRESENTED = /^(?:text|image|audio|video)\//i;

/**
 * May the proxy paint this navigation?
 *
 * The question is what the phone does with the response, not whether it is a web
 * page. A browser shows a document, a chunk of text, an image, and an audio or
 * video clip itself, so those stay: a dev server's log page served as text/plain
 * is a page someone tapped for, and refusing it strands nothing. What leaves the
 * frame is a file the server is handing over (an `attachment`, whatever its type
 * claims) or a binary the view has no reader for, which is where iOS takes the
 * presentation away in a system viewer with no back button in a home-screen app.
 * A response naming no type is left to the browser, which renders it as text, and
 * a dev server that forgets the header still serves what was asked for.
 */
export function isPreviewPaintableNavigation(
  contentType: string | null | undefined,
  disposition: string | null | undefined,
): boolean {
  if (isPreviewAttachmentDisposition(disposition)) return false;
  if (typeof contentType !== "string" || contentType.trim() === "") return true;
  return isPreviewDocumentContentType(contentType) || SELF_PRESENTED.test(contentType);
}
