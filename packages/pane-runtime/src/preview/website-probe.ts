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

/** Check for HTML without following redirects off this port or downloading an unbounded body. */
export async function probeWebsite(port: number, signal: AbortSignal): Promise<WebsiteInfo | null> {
  try {
    return await probeWebsiteOrigin(`http://127.0.0.1:${port}`, signal);
  } catch {
    if (signal.aborted) return null;
    // Match forwarding's loopback fallback for IPv6-only listeners.
    return probeWebsiteOrigin(`http://[::1]:${port}`, signal).catch(() => null);
  }
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
