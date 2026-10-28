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

/**
 * What one loopback family gets before the probe moves on from it. Generous
 * enough that a dev server compiling its first route usually answers inside it;
 * see the policy on probeWebsite for what happens when it does not.
 */
const ATTEMPT_TIMEOUT_MS = 900;

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
 *
 * THE POLICY, because the two pressures here pull opposite ways and this has
 * been decided once already: a port is offered when something on it ANSWERED
 * with a document, and not offered when it merely accepted a connection. A
 * socket that takes and never replies is indistinguishable from a wedged
 * database, a language server, or a leftover bind, and advertising those as
 * "Web preview" is the exact thing this feature exists to stop. The cost is a
 * first compile longer than this window, which appears on the next poll seconds
 * later instead of now; the alternative hides nothing but fills the picker with
 * ports that cannot render.
 *
 * THE SECOND FAMILY, and why it is a fallback rather than a second opinion:
 * `forward.ts` dials `127.0.0.1` and stays on that socket whenever the connect
 * succeeds, walking to `::1` only after a REFUSED connect. The socket the lane
 * will dial is therefore the only one allowed to describe the row. An IPv4 that
 * answers settles the port on its own merits even when that answer is not a
 * document, and an IPv4 that accepts and stalls strands the lane wherever IPv6
 * stands: in both cases the port is not offered on IPv6's behalf. A refused
 * IPv4 is the one case where the two agree, because then the lane goes to `::1`
 * too, and a site only IPv6 serves is listed and opens.
 */
export async function probeWebsite(port: number, signal: AbortSignal): Promise<WebsiteInfo | null> {
  const v4 = await probeFamily(`http://127.0.0.1:${port}`, signal);
  if (v4.kind === "page") return v4.info;
  if (v4.kind !== "unreachable") return null;
  // Nothing answered IPv4, so ask IPv6, which is where the lane would go too.
  // A scan that has already run out of budget asks nothing further.
  if (signal.aborted) return null;
  const v6 = await probeFamily(`http://[::1]:${port}`, signal);
  return v6.kind === "page" ? v6.info : null;
}

/** What one loopback family said about the port. */
type FamilyVerdict =
  /** A document, with or without a title: this is what a frame would render. */
  | { kind: "page"; info: WebsiteInfo }
  /** Answered, but not with an offerable document: the socket is talking about itself. */
  | { kind: "no-page" }
  /** Accepted and never answered inside the family's window. */
  | { kind: "stalled" }
  /** No socket at all (refused), or the caller's budget ended the question. */
  | { kind: "unreachable" };

/** Ask one family once, in its own window, and classify what came back. */
async function probeFamily(origin: string, signal: AbortSignal): Promise<FamilyVerdict> {
  // The family's own timer is separate from the scan's, because the two aborts
  // mean different things: one is this socket's silence, the other is the
  // caller no longer asking.
  const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  try {
    const info = await probeWebsiteOrigin(origin, AbortSignal.any([signal, attempt]));
    return info ? { kind: "page", info } : { kind: "no-page" };
  } catch {
    if (signal.aborted) return { kind: "unreachable" };
    return attempt.aborted ? { kind: "stalled" } : { kind: "unreachable" };
  }
}

/** What the probe says it is: a probe, in the shape servers expect of a client. */
const PROBE_USER_AGENT = "Mozilla/5.0 (compatible; SubshellPreviewProbe/1.0)";

async function probeWebsiteOrigin(origin: string, signal: AbortSignal): Promise<WebsiteInfo | null> {
  let url = `${origin}/`;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      // The offer names the document types and a client class, because internal
      // tools commonly 404 anything that does not look like a browser, and a port
      // hidden from discovery is a site the person cannot reach even though the
      // frame would have rendered it. It says what it is rather than borrowing a
      // real browser's identity: the proxy forwards the viewer's own UA when the
      // page is actually opened.
      headers: {
        accept: PREVIEW_DOCUMENT_ACCEPT,
        "accept-encoding": "identity",
        "user-agent": PROBE_USER_AGENT,
      },
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
