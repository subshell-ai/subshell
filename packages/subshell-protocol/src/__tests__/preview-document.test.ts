import { expect, it } from "bun:test";
import {
  acceptsPreviewDocument,
  isPreviewAttachmentDisposition,
  isPreviewDocumentContentType,
  isPreviewPaintableNavigation,
  isPreviewRefusalReason,
  isPreviewStrandingClient,
  isPreviewXmlDocumentContentType,
  PREVIEW_DOCUMENT_ACCEPT,
} from "../preview-document.js";

/**
 * One question, four callers: what a web page is for previews. These cells are
 * the contract discovery, the navigation guard and the rewriter each lean on,
 * and both directions of the mistakes are worth pinning. Refusing too much hides
 * a site that works (a Java app serving XHTML, a dev server that forgets to say
 * what it sent); accepting too much hands a phone a PDF to open somewhere with
 * no way back.
 */

it("recognizes the document types, and only whole ones", () => {
  expect(isPreviewDocumentContentType("text/html")).toBe(true);
  expect(isPreviewDocumentContentType("Text/HTML; charset=utf-8")).toBe(true);
  expect(isPreviewDocumentContentType("application/xhtml+xml")).toBe(true);
  expect(isPreviewDocumentContentType("application/xhtml+xml; charset=utf-8")).toBe(true);
  // A prefix of an accepted type is not that type.
  expect(isPreviewDocumentContentType("text/html-fragment")).toBe(false);
  expect(isPreviewDocumentContentType("application/json")).toBe(false);
  expect(isPreviewDocumentContentType("image/pdf")).toBe(false);
  expect(isPreviewDocumentContentType(null)).toBe(false);
  expect(isPreviewDocumentContentType("")).toBe(false);
});

it("offers the same list it recognizes", () => {
  // A server that answers only what it was offered would 406 the probe, and the
  // probe silently finding nothing reads as "this pane runs no website".
  expect(PREVIEW_DOCUMENT_ACCEPT).toBe("text/html,application/xhtml+xml");
  expect(acceptsPreviewDocument("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
  expect(acceptsPreviewDocument("application/json")).toBe(false);
  // A wildcard offer is not a request for a page: it is what a script or a
  // health check sends, and treating it as a navigation would refuse it.
  expect(acceptsPreviewDocument("*/*")).toBe(false);
  expect(acceptsPreviewDocument("text/html-fragment")).toBe(false);
  // q=0 is a refusal, not a preference: this client asked not to receive a page,
  // so it must not be classified as navigating into one.
  expect(acceptsPreviewDocument("text/html;q=0, application/json;q=0.9")).toBe(false);
  expect(acceptsPreviewDocument("application/json;q=0.9, text/html;q=0.5")).toBe(true);
  expect(acceptsPreviewDocument(null)).toBe(false);
});

it("reads a requested download out of the disposition", () => {
  expect(isPreviewAttachmentDisposition("attachment")).toBe(true);
  expect(isPreviewAttachmentDisposition("ATTACHMENT; filename=data.bin")).toBe(true);
  // `attachmentish` is not a disposition the server meant.
  expect(isPreviewAttachmentDisposition("attachmentish")).toBe(false);
  expect(isPreviewAttachmentDisposition('inline; filename="a.html"')).toBe(false);
  expect(isPreviewAttachmentDisposition(null)).toBe(false);
});

it("splits the documents by which parser they will meet", () => {
  // The rewriter needs this distinction: inline script is inert text to an HTML
  // parser and markup to an XML one, and getting it wrong is a page the browser
  // refuses to render rather than a cosmetic difference.
  expect(isPreviewXmlDocumentContentType("application/xhtml+xml")).toBe(true);
  expect(isPreviewXmlDocumentContentType("application/xhtml+xml; charset=utf-8")).toBe(true);
  expect(isPreviewXmlDocumentContentType("text/html")).toBe(false);
  expect(isPreviewXmlDocumentContentType("text/html; charset=utf-8")).toBe(false);
  expect(isPreviewXmlDocumentContentType(null)).toBe(false);
});

it("refuses a navigation only for the clients that cannot get back", () => {
  // The stranding the guard exists for is iOS handing the frame's file to a
  // system viewer. A desktop browser downloads in its own UI, so refusing there
  // would break an "Export CSV" link that has always worked inside a preview.
  expect(isPreviewStrandingClient("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe(
    true,
  );
  expect(isPreviewStrandingClient("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe(true);
  expect(isPreviewStrandingClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe(false);
  expect(isPreviewStrandingClient("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0")).toBe(false);
  expect(isPreviewStrandingClient(null)).toBe(false);
});

it("reads only its own reason words out of a refusal message", () => {
  // The frame that posts this is sandboxed app content, so the client accepts a
  // known word and renders fixed copy rather than anything it was given.
  expect(isPreviewRefusalReason("download")).toBe(true);
  expect(isPreviewRefusalReason("not-a-page")).toBe(true);
  expect(isPreviewRefusalReason("DELETE_SESSION")).toBe(false);
  expect(isPreviewRefusalReason("")).toBe(false);
  expect(isPreviewRefusalReason(undefined)).toBe(false);
  expect(isPreviewRefusalReason(1)).toBe(false);
});

it("paints a chosen navigation unless the response names something else", () => {
  expect(isPreviewPaintableNavigation("text/html", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/xhtml+xml; charset=utf-8", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/pdf", null)).toBe(false);
  // The guard's own asymmetry: a server that says NO type at all is not claiming
  // to hand over a file, and a browser renders such a body as text rather than
  // opening a system viewer, so a dev server that omits the header still shows
  // the page someone asked for. Absent and blank are the same answer, and the
  // caller reads a missing header as `""`.
  expect(isPreviewPaintableNavigation("", null)).toBe(true);
  expect(isPreviewPaintableNavigation("   ", null)).toBe(true);
  expect(isPreviewPaintableNavigation(undefined, null)).toBe(true);
  // Discovery asks the stricter question, so the same headerless response is not
  // a site to advertise.
  expect(isPreviewDocumentContentType("")).toBe(false);
  // An attachment outranks its own type, even a document one.
  expect(isPreviewPaintableNavigation("text/html", "attachment; filename=report")).toBe(false);
  // What a browser presents itself stays paintable: refusing these would block a
  // dev server's plain-text log page or a PNG someone tapped, neither of which
  // leaves the frame. The strand risk is the file the server hands over.
  expect(isPreviewPaintableNavigation("text/plain", null)).toBe(true);
  expect(isPreviewPaintableNavigation("image/png", null)).toBe(true);
  expect(isPreviewPaintableNavigation("video/webm", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/pdf", null)).toBe(false);
  expect(isPreviewPaintableNavigation("application/octet-stream", null)).toBe(false);
  // A browser also shows JSON and XML itself, so a dev server's /api/status stays
  // reachable on the client the feature targets.
  expect(isPreviewPaintableNavigation("application/json", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/json; charset=utf-8", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/xml", null)).toBe(true);
  expect(isPreviewPaintableNavigation("application/rss+xml", null)).toBe(true);
  // A type that merely starts with one of these is not it.
  expect(isPreviewPaintableNavigation("application/json-lines", null)).toBe(false);
  // A download keeps its refusal whatever the type claims.
  expect(isPreviewPaintableNavigation("text/plain", "attachment")).toBe(false);
});
