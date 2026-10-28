import {
  acceptsPreviewDocument,
  isPreviewAttachmentDisposition,
  isPreviewDocumentContentType,
  serviceAuthority,
} from "@internal/subshell-protocol";
import { Elysia } from "elysia";
import { LaneDuplex } from "@/modules/previews/lane-duplex.js";
import { LaneClosedError, LaneProtocolError, sendLaneRequest } from "@/modules/previews/lane-http.js";
import { getPreviewBroker, PreviewRefusal } from "@/modules/previews/preview-broker.js";
import { previewUrl } from "@/modules/previews/preview-url.js";
import { DEFAULT_PREVIEW_PROXY_SETTINGS } from "@/modules/previews/proxy-settings.js";
import { transformPreviewResponse } from "@/modules/previews/response-transform.js";
import { HttpError } from "@/shared/errors.js";

/**
 * The same-origin `/pv/<ref>/...` HTTP half of the pane-preview proxy
 * (spec 2026-10-21 §6).
 *
 * One session, one response, one lane: every browser request under the
 * session's proxy path opens its own forward lane (the browser reconnects
 * per request; lanes are cheap and one-shot), carries the session's cookies
 * from the jar instead of the browser's, and rewrites the answer so the
 * target believes it lives under `/pv/<ref>/`. Its cookies stay in the
 * server's session jar rather than the browser's dashboard cookie store.
 * The session ref in the path is the whole credential (spec §10), so an unknown one is a plain 404 saying nothing
 * else.
 *
 * The request itself is hand-framed over the lane (`lane-http.ts`): Bun's
 * `node:http` client silently ignores `createConnection` (measured on 1.4.2
 * three ways), so a proxy built on it would answer with bytes from a
 * plane-local dial while believing it had used the lane. The transforms, and
 * why each one exists:
 *
 * - INBOUND: drop the browser's `Cookie` and attach the jar (spec §6: the
 *   jar reaches lane requests only, and every request the proxy makes is
 *   one); set `Host` to the literal `127.0.0.1:<port>` the node dials (a
 *   vhost-aware dev server must not see the plane's hostname, and `Host` is
 *   exactly what a Host-checking dev server checks); drop `Connection`/
 *   `Keep-Alive` (the lane is one-shot; a keep-alive promise to the target
 *   would outlive the lane).
 * - OUTBOUND: keep target cookies only in the session jar, rewrite relative
 *   redirects, and replace target framing restrictions with our own. A CSP
 *   sandbox gives every document an opaque origin, including direct tabs;
 *   CORS permits its modules and requests only under the capability URL.
 *   Preview responses cannot set cookies on the dashboard origin.
 */

/** Header names describing the lane's transport rather than the proxied exchange. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Browser-context headers the jar/Host/one-shot rules replace or re-frame. */
const INBOUND_DROP = new Set([
  "cookie",
  "host",
  "content-length",
  "authorization",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "x-api-key",
  "forwarded",
  "remote-user",
  ...HOP_BY_HOP,
]);

// Edge authentication belongs to the dashboard, never to a pane's dev server.
function isIdentityHeader(name: string): boolean {
  return /^(cf-access-|x-auth-|x-auth-request-|x-amzn-oidc-|x-forwarded-)/.test(name);
}

// A target may describe its document, but cannot clear dashboard storage,
// install transport policy, or request HTTP authentication for our host.
const OUTBOUND_DROP = new Set([
  ...HOP_BY_HOP,
  "set-cookie",
  "content-length",
  "x-frame-options",
  "clear-site-data",
  "www-authenticate",
  "strict-transport-security",
  "alt-svc",
  "nel",
  "report-to",
  "reporting-endpoints",
  "accept-ch",
  "critical-ch",
]);

/** The 404 text. Deliberately about the link, never about the pane behind it. */
const DEAD_LINK = "This preview link is no longer valid. Reopen the preview to get a fresh one.";

/**
 * Store the name=value pair of every `Set-Cookie` in the session jar, keyed
 * by cookie name with last-write-wins. Attributes are stripped because the
 * jar's values ARE what gets attached to later requests, and a value still
 * wearing `Path=` or `Expires=` would ship to the target as a bogus cookie
 * (spec §6). Name-only keying across paths is the deliberate v1
 * simplification. Shared with `pv-ws.ts` so the upgrade-set cookie (the
 * redial's response) lands in the SAME jar: §6's jar sentence is unqualified
 * about which lane sets it.
 */
export function storeCookiesInJar(jar: Map<string, string>, setCookies: readonly string[]): void {
  for (const raw of setCookies) {
    const pair = raw.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    // The jar is target-controlled and outlives individual HTTP requests.
    // Bound both entry count and bytes, evicting the oldest cookie first.
    if (Buffer.byteLength(pair) > 4096) continue;
    jar.delete(name);
    jar.set(name, pair);
    let bytes = [...jar.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    while (jar.size > 128 || bytes > 64 * 1024) {
      const oldest = jar.entries().next().value;
      if (!oldest) break;
      bytes -= Buffer.byteLength(oldest[1]);
      jar.delete(oldest[0]);
    }
  }
}

/** The jar as a `Cookie` header value, or "" when the jar is empty. */
export function jarCookieHeader(jar: Map<string, string>): string {
  return [...jar.values()].join("; ");
}

/** Enforce the browser boundary on embedded documents and direct preview tabs. */
export function isolatedPreviewHeaders(headers = new Headers()): Headers {
  headers.append(
    "content-security-policy",
    "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups; frame-ancestors 'self'",
  );
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-credentials", "false");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * Drop only the `frame-ancestors` directive from a CSP value. Splitting on
 * `;` treats a quoted semicolon inside a directive as a separator; the
 * directive families that could carry one are not the ones iframe-embedding
 * dev servers ship, so v1 takes the simple split and keeps everything else
 * byte-identical.
 */
export function stripFrameAncestors(csp: string): string {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => !/^frame-ancestors(\s|$)/i.test(directive))
    .join("; ");
}

/** Prefix a root-relative `Location` so the redirect stays inside the proxy. */
export function rewriteLocation(location: string, ref: string): string {
  if (!location.startsWith("/") || location.startsWith("//")) return location;
  return `/pv/${ref}${location}`;
}

/** Transform the raw lane answer's header pairs into the browser-facing `Headers`. */
function outHeadersToWeb(pairs: [string, string][], jar: Map<string, string>, ref: string): Headers {
  const headers = new Headers();
  const setCookies = pairs.filter(([n]) => n === "set-cookie").map(([, v]) => v);
  for (const [name, value] of pairs) {
    if (OUTBOUND_DROP.has(name)) continue;
    if (name === "content-security-policy" || name === "content-security-policy-report-only") {
      headers.append(name, stripFrameAncestors(value));
    } else if (name === "location") {
      headers.append(name, rewriteLocation(value, ref));
    } else {
      headers.append(name, value);
    }
  }
  if (setCookies.length > 0) {
    storeCookiesInJar(jar, setCookies);
  }
  return isolatedPreviewHeaders(headers);
}

/**
 * One proxied request: lane, hand-framed request, streamed answer, lane
 * release. The lane closes exactly once, `viewer-left`, whatever the ending
 * (complete body, client abort, dead lane, refusal), because every one of
 * those is the proxy finishing its one-shot. A lane the NODE closed keeps
 * its own reason word inside `LaneDuplex`, and the 502 quotes it. A lane
 * that dies mid-body ends the stream: a POST may already have landed, and
 * there is never a mid-stream retry.
 */
async function proxyRequest(request: Request, sessionRef: string, rest: string): Promise<Response> {
  const broker = getPreviewBroker();
  const session = broker.sessionFor(sessionRef);
  if (!session) throw new HttpError(404, DEAD_LINK);

  // Opaque-origin scripts need CORS for modules and fetch. The unguessable
  // session path authorizes these reads; dashboard API CORS remains unchanged.
  if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
    const headers = isolatedPreviewHeaders();
    headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    const requested = request.headers.get("access-control-request-headers");
    if (requested) headers.set("access-control-allow-headers", requested);
    return new Response(null, { status: 204, headers });
  }

  let laneRef: string;
  try {
    ({ laneRef } = await broker.openLaneForConnection(sessionRef));
  } catch (err) {
    if (err instanceof PreviewRefusal) {
      // The named refusal, verbatim: the SPA turns this word into "close a
      // preview first". Never an anonymous 500, never a hang.
      throw new HttpError(
        503,
        `${err.code}: this pane is already carrying too many preview lanes. Try again once one closes.`,
      );
    }
    throw err;
  }

  let laneReleased = false;
  const releaseLane = (): void => {
    if (laneReleased) return;
    laneReleased = true;
    void broker.closeLaneForConnection(laneRef, "viewer-left").catch(() => undefined);
  };

  const duplex = new LaneDuplex({
    writeOut: (bytes) => broker.sendLaneBytes(laneRef, bytes),
    onLane: (cb) => broker.subscribeLane(laneRef, cb),
  });
  // The browser giving up ends the lane stream; whatever the target answers
  // after that has nowhere to go, and the body reader's finish/close path
  // still runs `releaseLane`.
  request.signal.addEventListener("abort", () => duplex.destroy());

  const url = new URL(request.url);
  const headers: [string, string][] = [
    ["host", serviceAuthority(session.service?.host ?? "127.0.0.1", session.port)],
    ["connection", "close"],
  ];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (INBOUND_DROP.has(lower) || isIdentityHeader(lower)) continue;
    headers.push([lower, value]);
  }
  const jarCookie = jarCookieHeader(session.cookieJar);
  if (jarCookie) headers.push(["cookie", jarCookie]);

  const settings = session.proxySettings ?? DEFAULT_PREVIEW_PROXY_SETTINGS;
  const targetOrigin = `${session.service?.protocol ?? "http"}://${serviceAuthority(session.service?.host ?? "127.0.0.1", session.port)}`;
  const proxyBase = `${url.origin}/pv/${sessionRef}/`;
  if (settings.passHost) headers[0] = ["host", url.host];
  // These are capability-authorized server-to-server requests. The sandbox's
  // opaque origin describes the browser→proxy hop, not the backend request.
  // Leave unrelated Origin values intact; never translate them into trusted ones.
  for (let i = headers.length - 1; i >= 0; i--) {
    const [name, value] = headers[i];
    if (name === "origin" && (value === "null" || value === url.origin)) headers.splice(i, 1);
  }
  if (settings.rewriteUrls) {
    for (let i = headers.length - 1; i >= 0; i--)
      if (["accept-encoding", "range", "if-range", "if-none-match", "if-modified-since"].includes(headers[i][0]))
        headers.splice(i, 1);
    headers.push(["accept-encoding", "identity"]);
  }
  const isHead = request.method === "HEAD";
  try {
    const res = await sendLaneRequest(
      duplex,
      {
        method: request.method,
        path: `/${rest}${url.search}`,
        headers,
        // A request body rides chunk-encoded (the browser's own framing is
        // dropped with `content-length` above, and an unknown-length fetch
        // stream cannot promise a length to the target). GET/HEAD carry none.
        body: isHead || request.method === "GET" ? null : (request.body ?? null),
      },
      isHead,
      () => {
        duplex.destroy();
        releaseLane();
      },
    );
    // A navigation to an internal service or download can hand an iOS PWA
    // to Quick Look with no way back. Subresources keep their original MIME.
    const destination = request.headers.get("sec-fetch-dest");
    const navigation =
      destination === "document" ||
      destination === "iframe" ||
      request.headers.get("sec-fetch-mode") === "navigate" ||
      (!destination && !rest && acceptsPreviewDocument(request.headers.get("accept")));
    const contentType = res.headers.find(([name]) => name === "content-type")?.[1] ?? "";
    const disposition = res.headers.find(([name]) => name === "content-disposition")?.[1] ?? "";
    if (
      navigation &&
      res.status >= 200 &&
      !(res.status >= 300 && res.status < 400) &&
      res.status !== 204 &&
      res.status !== 205 &&
      (!isPreviewDocumentContentType(contentType) || isPreviewAttachmentDisposition(disposition))
    ) {
      // The navigation is refused, but the answer is still the app's: cookies
      // it set (a CSRF or session token its later pages expect) belong to this
      // preview's jar. Dropping them with the body would half-log the session
      // out on the one request that carried them.
      const refusedCookies = res.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
      if (refusedCookies.length > 0) storeCookiesInJar(session.cookieJar, refusedCookies);
      await res.body?.cancel();
      duplex.destroy();
      releaseLane();
      return new Response(
        '<!doctype html><html><head><meta name=viewport content="width=device-width, initial-scale=1"><title>Preview unavailable</title></head><body><h1>This isn\'t a web page</h1><p>This address returned a download or another type of response. Close this preview and choose a website port.</p></body></html>',
        {
          status: 502,
          headers: isolatedPreviewHeaders(new Headers({ "content-type": "text/html; charset=utf-8" })),
        },
      );
    }
    const headersOut = outHeadersToWeb(res.headers, session.cookieJar, sessionRef);
    const location = res.headers.find(([name]) => name === "location")?.[1];
    if (location) {
      const mapped = settings.rewriteRedirects
        ? previewUrl(location, `${targetOrigin}/${rest}${url.search}`, targetOrigin, proxyBase)
        : rewriteLocation(location, sessionRef);
      headersOut.set("location", mapped.startsWith(proxyBase) ? mapped.slice(url.origin.length) : mapped);
    }
    if (res.body === null) {
      duplex.destroy();
      releaseLane();
    }
    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headersOut,
    });
    return settings.rewriteUrls && !isHead
      ? await transformPreviewResponse(response, targetOrigin, proxyBase, `/${rest}${url.search}`)
      : response;
  } catch (err) {
    duplex.destroy();
    releaseLane();
    if (err instanceof LaneClosedError) {
      throw new HttpError(502, `The preview target could not answer: ${err.message}.`);
    }
    if (err instanceof LaneProtocolError) {
      throw new HttpError(502, `The preview target answered with something unparseable: ${err.message}.`);
    }
    throw err;
  }
}

/**
 * The seven plain verbs for the session's proxy path (the WS upgrade for the
 * same wildcard lives in `pv-ws.ts`; spike-verified that a GET route and a
 * `.ws()` route coexist on one dynamic pattern). Mounted by `server.ts`
 * BEFORE the static SPA plugin (that file's `installScriptRoute` comment: a
 * root-level path mounted after it is 404'd by the file branch).
 */
const PATTERN = "/pv/:session/*";
const pvHandler = ({ params, request }: { params: { session: string; "*": string }; request: Request }) =>
  proxyRequest(request, params.session, params["*"] ?? "");

export const pvHttpRoute = new Elysia({ name: "pv-http" })
  .get(PATTERN, pvHandler)
  .post(PATTERN, pvHandler)
  .put(PATTERN, pvHandler)
  .patch(PATTERN, pvHandler)
  .delete(PATTERN, pvHandler)
  .head(PATTERN, pvHandler)
  .options(PATTERN, pvHandler);
