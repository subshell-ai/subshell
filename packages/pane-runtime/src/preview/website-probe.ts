import {
  isPreviewAttachmentDisposition,
  isPreviewDocumentContentType,
  PREVIEW_DOCUMENT_ACCEPT,
  PREVIEW_PAGE_TITLE_MAX_LENGTH,
} from "@internal/subshell-protocol";
import { decodeHTML } from "entities";

export interface WebsiteInfo {
  /** Page-authored display text, never markup. */
  title?: string;
}

/** Read only a bounded document prefix; slow or absent titles don't hide a website. */
async function pageTitle(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let source = "";
  let remaining = 64 * 1024;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      source += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= value.length;
      if (/<\/title\s*>|<\/head\s*>/i.test(source)) break;
    }
    // SVG titles label graphics, not the page. Bun's rewriter reports the
    // HTML namespace for these too, so exclude SVG before selecting titles.
    source = await new HTMLRewriter()
      .on("svg", {
        element(element) {
          element.remove();
        },
      })
      .transform(new Response(source))
      .text();
    let title = "";
    let found = false;
    let collecting = false;
    await new HTMLRewriter()
      .on("title", {
        element(element) {
          collecting = !found;
          found = true;
          element.onEndTag(() => {
            collecting = false;
          });
        },
        text(chunk) {
          if (collecting && title.length < 4096) title += chunk.text.slice(0, 4096 - title.length);
        },
      })
      .transform(new Response(source))
      .text();
    if (!found) return undefined;
    return (
      decodeHTML(title)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: page titles must not carry terminal or bidi controls.
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PREVIEW_PAGE_TITLE_MAX_LENGTH) || undefined
    );
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** What one loopback family gets before the probe moves on from it. */
const ATTEMPT_TIMEOUT_MS = 700;

/**
 * Check for HTML without following redirects off this port or downloading an
 * unbounded body, on both spellings of loopback.
 *
 * Each family gets its OWN slice of the window. Usually the family nobody
 * listened on answers with a refused socket, which costs nothing; when it stalls
 * instead (a firewall DROP, or a listener holding 127.0.0.1 while the app bound
 * `::1`) one shared budget would spend the whole window on the side that never
 * replies and leave a real IPv6-only website out of the picker. The caller's
 * signal stays the outer bound: once the scan is over, the scan is over.
 */
export async function probeWebsite(port: number, signal: AbortSignal): Promise<WebsiteInfo | null> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
      const info = await probeWebsiteOrigin(`http://${host}:${port}`, attempt);
      if (info) return info;
      // This family answered and says it is not a website. Ask the other one
      // anyway: the two are different sockets that may hold different servers,
      // and a tool bound to 127.0.0.1 while the dev server holds ::1 is a real
      // arrangement. One "no" does not settle a port number.
    } catch {
      // The scan's own budget running out ends the question; a refused or
      // stalled family does not.
      if (signal.aborted) return null;
    }
  }
  return null;
}

async function probeWebsiteOrigin(origin: string, signal: AbortSignal): Promise<WebsiteInfo | null> {
  let url = `${origin}/`;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { accept: PREVIEW_DOCUMENT_ACCEPT, "accept-encoding": "identity" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) return null;
      const next = new URL(location, url);
      if (next.origin !== origin || next.username || next.password) return null;
      url = next.href;
      continue;
    }
    // A 2xx only, which is deliberately stricter than the proxy's navigation
    // guard: this answer decides what to OFFER, and a crash page or an auth
    // wall is not a website to put in front of someone. They can still navigate
    // to that port and read what came back.
    if (
      response.status >= 200 &&
      response.status < 300 &&
      response.status !== 204 &&
      response.status !== 205 &&
      isPreviewDocumentContentType(response.headers.get("content-type")) &&
      !isPreviewAttachmentDisposition(response.headers.get("content-disposition"))
    ) {
      const title = await pageTitle(response);
      return title ? { title } : {};
    }
    await response.body?.cancel();
    return null;
  }
  return null;
}
