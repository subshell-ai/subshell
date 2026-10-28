import { expect, it } from "bun:test";
import {
  acceptsPreviewDocument,
  isPreviewAttachmentDisposition,
  isPreviewDocumentContentType,
  isPreviewPaintableNavigation,
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
});
