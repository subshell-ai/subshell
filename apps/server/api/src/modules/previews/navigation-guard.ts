import {
  acceptsPreviewDocument,
  isPreviewAttachmentDisposition,
  isPreviewPaintableNavigation,
  isPreviewStrandingClient,
  PREVIEW_REFUSAL_MESSAGE,
  type PreviewRefusalReason,
} from "@internal/subshell-protocol";

/** What the guard needs from the upstream answer; the lane's own header shape. */
export interface UpstreamAnswer {
  status: number;
  headers: [string, string][];
}

/**
 * Should this navigation be refused, and why?
 *
 * A download or an unknown type handed to the frame can take the whole
 * presentation away from an iOS client, which then has no back button to press.
 * Those clients get a page they can read and close. A desktop browser downloads
 * in its own UI and leaves the preview where it was, which is what someone
 * clicking "Export CSV" expects, so the same bytes go through there. Subresources
 * keep their original MIME either way, which is why this asks about navigations
 * only.
 *
 * `rest` is the path past the capability prefix: an empty one is the session root,
 * where a client that sends no `Sec-Fetch-*` at all and offers HTML is navigating
 * even if we cannot see the gesture.
 *
 * The known gap: a client that sends no `Sec-Fetch-*` on a SUBPATH looks like a
 * fetch, not a navigation, and is left alone. Guessing otherwise would refuse the
 * JSON a page's own code asks for. In practice this means WebKit old enough to
 * predate `Sec-Fetch-Dest` (before Safari 16.4) is not covered by the guard, on a
 * service whose whole trust model is the operator's own LAN and browser.
 *
 * @returns a reason word when the frame must not be given this response, else null
 */
export function strandingNavigationReason(
  request: Request,
  rest: string,
  answer: UpstreamAnswer,
): PreviewRefusalReason | null {
  const destination = request.headers.get("sec-fetch-dest");
  const navigation =
    destination === "document" ||
    destination === "iframe" ||
    request.headers.get("sec-fetch-mode") === "navigate" ||
    (!destination && !rest && acceptsPreviewDocument(request.headers.get("accept")));
  if (!navigation || !isPreviewStrandingClient(request.headers.get("user-agent"))) return null;
  // Redirects are the app's own business, and a no-content answer strands nobody.
  if (answer.status < 200 || (answer.status >= 300 && answer.status < 400)) return null;
  if (answer.status === 204 || answer.status === 205) return null;
  const contentType = answer.headers.find(([name]) => name === "content-type")?.[1] ?? "";
  const disposition = answer.headers.find(([name]) => name === "content-disposition")?.[1] ?? "";
  if (isPreviewPaintableNavigation(contentType, disposition)) return null;
  return isPreviewAttachmentDisposition(disposition) ? "download" : "not-a-page";
}

/**
 * The page a refused navigation shows a stranding client.
 *
 * It also announces itself to the dashboard, because a person watching the toolbar
 * sees a frame change with no explanation. The page runs in the same opaque-origin
 * sandbox, so the one channel out is postMessage to the parent, and what crosses is
 * a fixed marker, this session's own ref, and one of two known words: nothing the
 * app could author. The panel believes a message only from the frame it created,
 * and the sentences here stay ours.
 */
export function previewRefusalPage(ref: string, origin: string, reason: PreviewRefusalReason): string {
  const advice =
    reason === "download"
      ? "The app offered a file, which would have taken this screen over with no way back. Have the app show it in the page, or open the address in a new tab."
      : "This address returned something other than a web page. Close this preview and choose a website port.";
  // `<` is escaped so a host name cannot close the script element early.
  const payload = JSON.stringify({ type: PREVIEW_REFUSAL_MESSAGE, ref, reason }).replace(/</g, "\\u003c");
  const parent = JSON.stringify(origin).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta name=viewport content="width=device-width, initial-scale=1"><title>Preview unavailable</title></head><body><h1>This isn't a web page</h1><p>${advice}</p><script>try{parent.postMessage(${payload},${parent})}catch{}</script></body></html>`;
}
