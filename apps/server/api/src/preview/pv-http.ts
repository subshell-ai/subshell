import { Elysia } from "elysia";
import { HttpError } from "@/api/auth-guard.js";
import { LaneDuplex } from "@/preview/lane-duplex.js";
import { LaneClosedError, LaneProtocolError, sendLaneRequest } from "@/preview/lane-http.js";
import { getPreviewBroker, PreviewRefusal } from "@/services/preview-broker.js";

/**
 * The same-origin `/pv/<ref>/...` HTTP half of the pane-preview proxy
 * (spec 2026-10-21 §6).
 *
 * One session, one response, one lane: every browser request under the
 * session's proxy path opens its own forward lane (the browser reconnects
 * per request; lanes are cheap and one-shot), carries the session's cookies
 * from the jar instead of the browser's, and rewrites the answer so the
 * target believes it lives under `/pv/<ref>/` and the browser's cookie store
 * stays inside that path. The session ref in the path is the whole
 * credential (spec §10), so an unknown one is a plain 404 saying nothing
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
 * - OUTBOUND: drop hop-by-hop headers (they describe the lane's transport,
 *   not the proxied exchange); force `Set-Cookie` Path onto the session's
 *   proxy path (without it the target's own path guess, normally `/`, lets
 *   the cookie leak plane-wide, and it would never come back on the next
 *   request either); store only the name=value pair in the jar; prefix a
 *   relative `Location` with the proxy path; strip `frame-ancestors` from
 *   both CSP headers (the iframe IS the product; the rest of a target's CSP
 *   is its own business and survives untouched).
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
const INBOUND_DROP = new Set(["cookie", "host", "content-length", ...HOP_BY_HOP]);

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
    jar.set(pair.slice(0, eq), pair);
  }
}

/** The jar as a `Cookie` header value, or "" when the jar is empty. */
export function jarCookieHeader(jar: Map<string, string>): string {
  return [...jar.values()].join("; ");
}

/** Force one `Set-Cookie` to ride the session's proxy path, attributes kept. */
function rewriteSetCookiePath(raw: string, ref: string): string {
  const [pair, ...attributes] = raw.split(";");
  const kept = attributes.filter((attr) => !/^\s*path\s*=/i.test(attr));
  return `${pair?.trim() ?? ""}; Path=/pv/${ref}/${kept.length > 0 ? `; ${kept.map((a) => a.trim()).join("; ")}` : ""}`;
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
    if (HOP_BY_HOP.has(name) || name === "set-cookie") continue;
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
    for (const cookie of setCookies) headers.append("set-cookie", rewriteSetCookiePath(cookie, ref));
  }
  return headers;
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
    ["host", `127.0.0.1:${session.port}`],
    ["connection", "close"],
  ];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (INBOUND_DROP.has(lower)) continue;
    headers.push([lower, value]);
  }
  const jarCookie = jarCookieHeader(session.cookieJar);
  if (jarCookie) headers.push(["cookie", jarCookie]);

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
    const headersOut = outHeadersToWeb(res.headers, session.cookieJar, sessionRef);
    if (res.body === null) {
      duplex.destroy();
      releaseLane();
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headersOut,
    });
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
