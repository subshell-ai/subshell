import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import {
  type NodeCommandBody,
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_LANE_BUFFER_MAX_BYTES,
  PREVIEW_LANE_QUEUE_MAX,
  type PreviewDataFrame,
} from "@internal/subshell-protocol";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { pvHttpRoute } from "@/api/previews/http.js";
import { previewWsRoute } from "@/api/previews/ws.js";
import { originRegistry } from "@/modules/network/trusted-origins.js";
import { getPreviewBroker, resetForTests, shutdownPreviewBrokerForTests } from "@/modules/previews/preview-broker.js";
import { createApp } from "@/server.js";
import { ensureMigratedTestDb } from "@/testing/test-database.js";

/**
 * The same-origin `/pv` proxy (pane-preview spec 2026-10-21 §6, Task 10).
 *
 * Two halves, one path: the HTTP rewrite half (`pv-http.ts`) and the WS
 * tunnel half (`pv-ws.ts`). The session ref in the path IS the credential,
 * so these tests stand the whole surface up the way production does: an
 * in-proc `Bun.serve` target answering on plane loopback (a client that
 * bypassed the lane would still connect, so every byte assertion
 * rides the fake node's COUNT, not just the response), and the REAL broker
 * over faked wire seams, exactly like `preview-broker.test.ts`.
 *
 * The HTTP-side requests drive `createApp()`, the production composition,
 * through `app.handle`, so an unmounted proxy cannot pass this file while a
 * module-level unit test would; the WS refusals probe the same mounted app
 * over a raw socket (a rejected upgrade never becomes a WebSocket client
 * event, so the answer is an HTTP status line), and the tunnels run against
 * the real listener.
 */

const NODE = "n-pv";
const PANE = "p-pv-pane";
const USER = "u-pv";
const DOC_ORIGIN = "http://203.0.113.77:3080";
const PLUGIN = "pv-proxy-test";

/* ------------------------------------------------------------------ */
/* the fake node                                                       */
/* ------------------------------------------------------------------ */

/**
 * A ~50-line node: it acks every `preview_open` (the broker's probe open and
 * each lane open ride the SAME wire command, so the fake keys "dialed" on the
 * first `in` byte, which only a real lane ever sends), pipes each lane's `in`
 * frames to a fresh loopback socket pointed at the port the open named,
 * streams the target's replies back as `out` frames through the real broker,
 * and volunteers `target-gone` when a target socket dies. It COUNTS every
 * byte it writes toward a target. That count is the lane-bypass guard: a
 * proxy that dialed plane loopback directly would still satisfy a naive
 * byte-equality check while leaving this at zero.
 */
interface FakeNode {
  piped: number;
  /** Every ref this fake served a lane for (lanes that actually sent bytes). */
  dialOrder: string[];
  /** Lane closes that reached this fake AFTER the lane did work (probe closes excluded). */
  closedLanes: { ref: string; reason: string }[];
  send(nodeId: string, cmd: NodeCommandBody): Promise<unknown>;
  linkSend(nodeId: string, frame: PreviewDataFrame): void;
  /** Ports answer: the display screen is reported only when the test asks. */
  reportScreenRfbPort: number | null;
}

function makeFakeNode(): FakeNode {
  const lanes = new Map<string, { port: number; sock: net.Socket | null; held: Buffer[] }>();
  const fake: FakeNode = {
    piped: 0,
    dialOrder: [],
    closedLanes: [],
    reportScreenRfbPort: null,
    async send(_nodeId, cmd) {
      if (cmd.type === "preview_open") {
        lanes.set(cmd.ref, { port: cmd.port, sock: null, held: [] });
        return { ref: cmd.ref, pending: true };
      }
      if (cmd.type === "preview_close") {
        const lane = lanes.get(cmd.ref);
        if (lane) {
          lane.sock?.destroy();
          lanes.delete(cmd.ref);
          if (lane.sock) fake.closedLanes.push({ ref: cmd.ref, reason: cmd.reason });
        }
        return { ref: cmd.ref, closed: true };
      }
      if (cmd.type === "preview_ports_get") {
        return {
          ports: [],
          cdpPort: null,
          screen: fake.reportScreenRfbPort
            ? { display: ":7", viewer: { protocol: "vnc", port: fake.reportScreenRfbPort } }
            : null,
        };
      }
      throw new Error(`pv proxy fake node: unexpected command ${cmd.type}`);
    },
    linkSend(_nodeId, frame) {
      if (frame.type !== "preview_data" || frame.dir !== "in") return;
      const lane = lanes.get(frame.ref);
      if (!lane) return;
      const bytes = Buffer.from(frame.blob, "base64");
      if (bytes.byteLength === 0) return;
      fake.piped += bytes.byteLength;
      if (!lane.sock) {
        fake.dialOrder.push(frame.ref);
        lane.sock = net.connect(lane.port, "127.0.0.1", () => {
          for (const h of lane.held.splice(0)) lane.sock?.write(h);
        });
        lane.sock.on("data", (d: Buffer) => {
          getPreviewBroker().onNodeLaneFrame(NODE, {
            type: "preview_data",
            ref: frame.ref,
            dir: "out",
            blob: d.toString("base64"),
          });
        });
        lane.sock.on("close", () => {
          if (lanes.delete(frame.ref)) {
            void getPreviewBroker().onNodeReportedClose(NODE, frame.ref, "target-gone");
          }
        });
        lane.sock.on("error", () => lane.sock?.destroy());
      }
      if (lane.sock.connecting || !lane.sock.writable) {
        lane.held.push(bytes);
        return;
      }
      lane.sock.write(bytes);
    },
  };
  return fake;
}

/* ------------------------------------------------------------------ */
/* the in-proc target                                                  */
/* ------------------------------------------------------------------ */

/** What the target last saw, per lane: the assertions read this, not a guess. */
interface TargetSeen {
  method: string;
  url: string;
  host: string | null;
  cookie: string | null;
  identity: (string | null)[];
  body: string;
}
let lastSeen: TargetSeen = { method: "", url: "", host: null, cookie: null, identity: [], body: "" };
let targetPort = 0;
let target: Bun.Server<{ path: string }> | undefined;

/** Raw byte-echo TCP target for `raw` mode (an x11vnc stand-in). */
let rfbPort = 0;
const rfbLog: Buffer[] = [];
const rfbAcceptList: net.Socket[] = [];
let rfbServer: net.Server | undefined;
/** TCP target that accepts and NEVER answers: stalls the http-mode handshake. */
let silentPort = 0;
const silentSockets: net.Socket[] = [];
let silentServer: net.Server | undefined;

beforeAll(async () => {
  await ensureMigratedTestDb();
  target = Bun.serve<{ path: string }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/hmr" || url.pathname.startsWith("/hmr")) {
        // The /hmr-cookie path answers the 101 with a Set-Cookie: the
        // upgrade-answer jar leg needs a target that sets one.
        const upgraded =
          url.pathname === "/hmr-cookie"
            ? server.upgrade(req, {
                data: { path: url.pathname },
                headers: { "set-cookie": "hsid=upgraded; Path=/deep; HttpOnly" },
              })
            : server.upgrade(req, { data: { path: url.pathname } });
        if (upgraded) return undefined;
        return new Response("upgrade refused", { status: 400 });
      }
      lastSeen = {
        method: req.method,
        url: url.pathname + url.search,
        host: req.headers.get("host"),
        cookie: req.headers.get("cookie"),
        identity: [
          "authorization",
          "x-api-key",
          "cf-access-jwt-assertion",
          "x-auth-request-user",
          "x-forwarded-user",
          "forwarded",
        ].map((name) => req.headers.get(name)),
        body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
      };
      if (["/download", "/download-error"].includes(url.pathname))
        return new Response(new Uint8Array([1, 2]), {
          status: url.pathname === "/download-error" ? 404 : 200,
          headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=data" },
        });
      if (url.pathname === "/download-cookie")
        return new Response(new Uint8Array([3]), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename=data",
            "set-cookie": "csrf=abc; Path=/",
          },
        });
      if (url.pathname === "/headers") return Response.json(Object.fromEntries(req.headers));
      // A binary with no disposition and no reader: refused on a navigation the
      // way an attachment is, because the view cannot present it.
      if (url.pathname === "/blob")
        return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/page")
        return new Response('<head><link href="/style.css"></head><h1>App</h1>', {
          headers: { "content-type": "text/html" },
        });
      if (url.pathname === "/xhtml")
        // A well-formed XML document, the way a real XHTML server answers: an
        // unclosed <link> or a stray top-level element would fail the parse for
        // reasons that have nothing to do with what the proxy injects.
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="/style.css" /></head><body><h1>XHTML App</h1></body></html>',
          { headers: { "content-type": "application/xhtml+xml" } },
        );
      if (url.pathname === "/absolute-redirect")
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${targetPort}/page` } });
      if (url.pathname === "/echo") {
        return Response.json(lastSeen);
      }
      if (url.pathname === "/cookie") {
        return new Response("ok", {
          headers: [
            ["set-cookie", "sid=9; Path=/deep; HttpOnly; Max-Age=60"],
            ["set-cookie", "theme=dark; Path=/app; Domain=example.com; Secure"],
            ["clear-site-data", '"cookies", "storage"'],
            ["www-authenticate", 'Basic realm="dashboard"'],
            ["strict-transport-security", "max-age=31536000"],
            ["alt-svc", 'h3=":443"'],
            ["nel", '{"report_to":"target","max_age":86400}'],
            ["report-to", '{"group":"target","max_age":86400,"endpoints":[{"url":"https://collector.example"}]}'],
            ["reporting-endpoints", 'target="https://collector.example"'],
            ["accept-ch", "Sec-CH-UA-Platform-Version"],
            ["critical-ch", "Sec-CH-UA-Platform-Version"],
          ],
        });
      }
      if (url.pathname === "/csp") {
        return new Response("ok", {
          headers: [
            ["content-security-policy", "default-src 'self'; frame-ancestors 'none'; img-src *"],
            [
              "content-security-policy-report-only",
              "default-src 'self'; frame-ancestors https://evil; script-src 'self'",
            ],
          ],
        });
      }
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/foo?x=1" } });
      }
      return new Response("hello-target", { status: 200 });
    },
    websocket: {
      open() {},
      message(ws, msg) {
        // Echo verbatim: Bun hands bytes as Buffer and text as string, and
        // re-sending either preserves the frame type.
        ws.send(msg as string | Uint8Array);
      },
      close() {},
    },
  });
  targetPort = target.port as number;

  rfbServer = net.createServer((sock) => {
    rfbAcceptList.push(sock);
    rfbLog.length = 0;
    sock.on("data", (d: Buffer) => {
      rfbLog.push(Buffer.from(d));
      sock.write(Buffer.from(d).reverse()); // echo reversed: direction is visible in the bytes
    });
  });
  await new Promise<void>((res, rej) => {
    if (!rfbServer) return rej(new Error("no rfb server"));
    rfbServer.listen(0, "127.0.0.1", res);
  });
  rfbPort = (rfbServer.address() as net.AddressInfo).port;

  silentServer = net.createServer((sock) => {
    silentSockets.push(sock); // accepted, then silence: the RFB/dev handshake stalls
  });
  await new Promise<void>((res, rej) => {
    if (!silentServer) return rej(new Error("no silent server"));
    silentServer.listen(0, "127.0.0.1", res);
  });
  silentPort = (silentServer.address() as net.AddressInfo).port;
});

afterAll(async () => {
  target?.stop();
  rfbServer?.close();
  for (const s of silentSockets) s.destroy();
  silentServer?.close();
  originRegistry().clearPlugin(PLUGIN);
  shutdownPreviewBrokerForTests();
});

/* ------------------------------------------------------------------ */
/* per-test broker + session                                           */
/* ------------------------------------------------------------------ */

let fake: FakeNode;

function freshBroker(nextFake: FakeNode): void {
  resetForTests({ send: nextFake.send.bind(nextFake), linkSend: nextFake.linkSend.bind(nextFake) });
}

async function openSession(port: number): Promise<string> {
  const { ref } = await getPreviewBroker().openForward({ viewerUserId: USER, paneId: PANE, nodeId: NODE, port });
  return ref;
}

beforeEach(() => {
  fake = makeFakeNode();
  freshBroker(fake);
  lastSeen = { method: "", url: "", host: null, cookie: null, identity: [], body: "" };
});

afterEach(() => {
  originRegistry().clearPlugin(PLUGIN);
  for (const s of rfbAcceptList) s.destroy();
  rfbAcceptList.length = 0;
  for (const s of silentSockets) s.destroy();
  silentSockets.length = 0;
});

/** Drive one request through the PRODUCTION composition. */
async function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp();
  return app.handle(new Request(`http://localhost:3080${path}`, init));
}

/* ------------------------------------------------------------------ */
/* raw-socket upgrade probe                                            */
/* ------------------------------------------------------------------ */

interface UpgradeProbe {
  status: number;
  raw: string;
}

/**
 * Writes a WebSocket upgrade by hand. A REFUSED upgrade is an HTTP answer the
 * browser's WebSocket client only sees as a failed connection, so the status
 * line and body can only be read off the socket.
 */
async function probeUpgrade(port: number, path: string, origin?: string): Promise<UpgradeProbe> {
  return new Promise<UpgradeProbe>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          (origin ? `Origin: ${origin}\r\n` : "") +
          "\r\n",
      );
    });
    let raw = "";
    let settle: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`upgrade probe timed out; saw: ${raw.slice(0, 200)}`));
    }, 4_000);
    sock.on("data", (d) => {
      raw += d.toString("latin1");
      // Status answers complete when the head is in and the body has settled;
      // 101 has no body, refusals get a beat to flush theirs.
      if (raw.includes("101 Switching Protocols")) {
        clearTimeout(timeout);
        sock.destroy();
        resolve({ status: 101, raw });
      } else if (raw.includes("\r\n\r\n") && !settle) {
        settle = setTimeout(() => {
          clearTimeout(timeout);
          sock.destroy();
          resolve({ status: Number(raw.match(/^HTTP\/1\.\d (\d{3})/)?.[1] ?? 0), raw });
        }, 150);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timeout);
      if (settle) clearTimeout(settle);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* the HTTP rewrite half                                               */
/* ------------------------------------------------------------------ */

/** The clients the navigation guard refuses for: iOS can hand the frame's file
 * to a system viewer with no way back. A desktop browser downloads in its own UI. */
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("pv-http: the same-origin rewrite", () => {
  it("keeps non-document responses inside the preview on navigation while preserving fetches", async () => {
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    // What is refused is what leaves the frame: a file handed over, or a binary
    // the view has no reader for.
    for (const path of ["download", "download-error", "blob"]) {
      const response = await proxyFetch(`/pv/${ref}/${path}`, {
        headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "user-agent": IPHONE_UA },
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-disposition")).toBeNull();
      const refused = await response.text();
      expect(refused).toContain("This isn't a web page");
      // The page also tells the dashboard what it refused, so the person is not
      // left reading a frame that quietly changed.
      expect(refused).toContain("subshell:preview-refused");
      expect(refused).toContain(`"ref":"${ref}"`);
    }
    const response = await proxyFetch(`/pv/${ref}/download`, { headers: { "sec-fetch-dest": "empty" } });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("shows an API response a phone would have rendered itself", async () => {
    // Someone who tapped /api/status on a phone gets the JSON, the way every
    // browser presents it: refusing it strands nothing and loses the answer.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const response = await proxyFetch(`/pv/${ref}/headers`, {
      headers: { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml", "user-agent": IPHONE_UA },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // The app's own bytes, not our error page, and the request reached it with
    // the offer it made.
    const body = (await response.json()) as Record<string, string>;
    expect(body.accept).toContain("text/html");
  });

  it("lets a desktop click download instead of showing it an error page", async () => {
    // The stranding this guard prevents is an iOS one. On a desktop the browser
    // handles the file in its own UI and leaves the preview alone, so refusing
    // here would break the "Export CSV" link that worked before the guard.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const response = await proxyFetch(`/pv/${ref}/download`, {
      headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "user-agent": DESKTOP_UA },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("refuses a HEAD navigation with no body at all", async () => {
    // A body on a HEAD response is a protocol error, and a client that does not
    // strip it reads the leftover bytes as the start of the next response.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const response = await proxyFetch(`/pv/${ref}/download`, {
      method: "HEAD",
      headers: { "sec-fetch-dest": "document", "user-agent": IPHONE_UA },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });

  it("keeps the cookies of a refused navigation in the session jar", async () => {
    // A download endpoint commonly sets the CSRF or session cookie its later
    // pages then expect. Refusing to paint the file in the frame is the right
    // answer; losing the cookie it carried is not, because the preview wakes up
    // half signed out on the request after it.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const response = await proxyFetch(`/pv/${ref}/download-cookie`, {
      headers: { "sec-fetch-dest": "document", "user-agent": IPHONE_UA },
    });
    expect(response.status).toBe(502);
    // The refusal is our own page, so nothing of the upstream headers rides out.
    expect(response.headers.get("set-cookie")).toBeNull();
    // The jar holds the pair, not just the value: that is what a Cookie header
    // is rebuilt from on the request after this one.
    expect(getPreviewBroker().sessionFor(ref)?.cookieJar.get("csrf")).toBe("csrf=abc");
  });

  it("rewrites a document served as XHTML, for a parser that reads script as markup", async () => {
    // A browser paints application/xhtml+xml as HTML, so the guard must not read
    // it as a download, and the rewriter must not skip it either: the page's
    // root-relative stylesheet and dynamic URLs break without the rewrite. But
    // this document will be parsed as strict XML, where the raw < and && inside
    // the shim are fatal rather than JavaScript, so the shim goes in as CDATA and
    // the page keeps the type it arrived with.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const response = await proxyFetch(`/pv/${ref}/xhtml`, {
      headers: { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml,application/xml;q=0.9" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xhtml+xml; charset=utf-8");
    const body = await response.text();
    expect(body).not.toContain("This isn't a web page");
    // Rewritten like any other document, and still typed as what it is.
    expect(body).toContain("XHTML App");
    expect(body).toContain(`href="http://localhost:3080/pv/${ref}/style.css"`);
    expect(body).toContain("installPreviewCompat");
    // The part that keeps it renderable: to an XML parser the shim's content is
    // markup, so it has to arrive inside a CDATA section, delimited by lines the
    // JavaScript engine reads as comments.
    const opened = body.indexOf("<script>") + "<script>".length;
    const shim = body.slice(opened, body.indexOf("</script>"));
    expect(shim.startsWith("//<![CDATA[\n")).toBe(true);
    expect(shim.endsWith("\n//]]>")).toBe(true);
  });

  it("injects the plain shim into an HTML document, with no CDATA to explain", async () => {
    // The other half of the pair above: a page the browser parses as HTML must
    // not be wrapped, because there the markers would be JavaScript, not a comment.
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
    });
    const body = await (await proxyFetch(`/pv/${ref}/page`)).text();
    expect(body).toContain("installPreviewCompat");
    expect(body).not.toContain("<![CDATA[");
  });

  it("applies snapshotted host/rewrite settings to the real lane", async () => {
    const broker = getPreviewBroker();
    const { ref } = await broker.openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
      proxySettings: { rewriteUrls: false, passHost: true, rewriteRedirects: false },
    });
    const headers = (await (
      await proxyFetch(`/pv/${ref}/headers`, {
        headers: {
          origin: "null",
          referer: `http://localhost:3080/pv/${ref}/`,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
        },
      })
    ).json()) as Record<string, string>;
    expect(headers.host).toBe("localhost:3080");
    expect(headers.origin).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers["sec-fetch-site"]).toBeUndefined();
    expect(await (await proxyFetch(`/pv/${ref}/page`)).text()).toContain('href="/style.css"');
    expect((await proxyFetch(`/pv/${ref}/redirect`)).headers.get("location")).toBe(`/pv/${ref}/foo?x=1`);
    const redirect = await proxyFetch(`/pv/${ref}/absolute-redirect`);
    expect(redirect.headers.get("location")).toBe(`http://127.0.0.1:${targetPort}/page`);
    const defaultRef = await openSession(targetPort);
    expect(await (await proxyFetch(`/pv/${defaultRef}/page`)).text()).toContain(`/pv/${defaultRef}/style.css`);
    expect((await proxyFetch(`/pv/${defaultRef}/absolute-redirect`)).headers.get("location")).toBe(
      `/pv/${defaultRef}/page`,
    );
    const otherOrigin = (await (
      await proxyFetch(`/pv/${defaultRef}/headers`, { headers: { origin: "https://elsewhere.test" } })
    ).json()) as Record<string, string>;
    expect(otherOrigin.origin).toBe("https://elsewhere.test");
  });
  it("preserves escaped characters in the target request path", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/asset%20name%2Fpart?name=a%20b`);
    expect(res.status).toBe(200);
    await res.text();
    expect(lastSeen?.url).toBe("/asset%20name%2Fpart?name=a%20b");
  });

  it("does not expose an unsandboxed preview through its capability alone", async () => {
    const { ref } = await getPreviewBroker().openForward({
      viewerUserId: USER,
      paneId: PANE,
      nodeId: NODE,
      port: targetPort,
      sandbox: false,
    });
    const res = await proxyFetch(`/pv/${ref}/`);
    expect(res.status).toBe(403);
    expect(fake.piped).toBe(0);
  });

  it("keeps target cookies out of the dashboard browser and isolates preview documents", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/cookie`);
    expect(res.headers.getSetCookie()).toEqual([]);
    for (const name of [
      "clear-site-data",
      "www-authenticate",
      "strict-transport-security",
      "alt-svc",
      "nel",
      "report-to",
      "reporting-endpoints",
      "accept-ch",
      "critical-ch",
    ]) {
      expect(res.headers.get(name)).toBeNull();
    }
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBe("false");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("ok");
  });

  it("does not forward dashboard or edge authentication to the dev server", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/echo`, {
      headers: {
        authorization: "Bearer dashboard-secret",
        "x-api-key": "dashboard-key",
        "cf-access-jwt-assertion": "edge-jwt",
        "x-auth-request-user": "private-user",
        "x-forwarded-user": "private-user",
        forwarded: "for=192.0.2.1",
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TargetSeen).identity).toEqual([null, null, null, null, null, null]);
  });

  it("answers opaque-origin preflights without dialing the target", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/echo`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(["*", "null"]).toContain(res.headers.get("access-control-allow-origin") ?? "");
    expect(fake.dialOrder).toHaveLength(0);
  });

  it("never forwards the browser's Cookie; the jarred cookie rides a fresh lane's request", async () => {
    const ref = await openSession(targetPort);
    // Request one: the browser's own cookie must NOT reach the target, and
    // the target's Set-Cookie lands in the jar.
    const first = await proxyFetch(`/pv/${ref}/echo`, { headers: { cookie: "plane=supersecret" } });
    expect(first.status).toBe(200);
    expect(((await first.json()) as TargetSeen).cookie).toBeNull();
    const setOne = await proxyFetch(`/pv/${ref}/cookie`);
    expect(setOne.headers.getSetCookie()).toEqual([]);
    // Request two on the SAME session: no Cookie header, but the jar carries
    // the pairs. And it rode a FRESH lane: each of the four proxy requests
    // dialed its own, so a lane quietly reused between requests fails here
    // even if the jar itself works.
    const second = await proxyFetch(`/pv/${ref}/echo`);
    const seen = (await second.json()) as { cookie: string | null };
    expect(seen.cookie).toBe("sid=9; theme=dark");
    // A DIFFERENT session's proxy path carries nothing.
    const ref2 = await openSession(targetPort);
    const foreign = (await (await proxyFetch(`/pv/${ref2}/echo`)).json()) as { cookie: string | null };
    expect(foreign.cookie).toBeNull();
    // echo, cookie, jar-echo, foreign-echo: four requests, four distinct lanes.
    expect(fake.dialOrder).toHaveLength(4);
    expect(new Set(fake.dialOrder).size).toBe(4);
  });

  it("a session reopened after closeForPane starts with an empty jar", async () => {
    const ref = await openSession(targetPort);
    await proxyFetch(`/pv/${ref}/cookie`);
    await getPreviewBroker().closeForPane(PANE, "pane-gone");
    // The dead session is now unaddressable, and the fresh one has a clean jar.
    expect((await proxyFetch(`/pv/${ref}/echo`)).status).toBe(404);
    const ref2 = await openSession(targetPort);
    const seen = (await (await proxyFetch(`/pv/${ref2}/echo`)).json()) as { cookie: string | null };
    expect(seen.cookie).toBeNull();
  });

  it("sets Host to the loopback literal the node dials", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/echo`);
    expect(((await res.json()) as TargetSeen).host).toBe(`127.0.0.1:${targetPort}`);
  });

  it("carries the method and the body through", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/echo`, { method: "POST", body: "lane-payload" });
    const seen = (await res.json()) as TargetSeen;
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe("lane-payload");
  });

  it("keeps two of three CSP directives and drops frame-ancestors from both flavors", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/csp`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const report = res.headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src *");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(report).toContain("default-src 'self'");
    expect(report).toContain("script-src 'self'");
    expect(report).not.toContain("frame-ancestors");
  });

  it("prefixes a relative Location with the session's proxy path", async () => {
    const ref = await openSession(targetPort);
    const res = await proxyFetch(`/pv/${ref}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/pv/${ref}/foo?x=1`);
  });

  it("answers an unknown session ref with a 404 that leaks nothing", async () => {
    const ref = await openSession(targetPort);
    const ghost = ref.replace(/^.{6}/, "000000");
    const res = await proxyFetch(`/pv/${ghost}/anything/at/all`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(NODE);
    expect(body).not.toContain(PANE);
    expect(body).not.toContain(ref);
    expect(body.toLowerCase()).not.toContain("pane");
  });

  it("answers a lane-cap refusal with a 503 that names preview-lane-over-cap", async () => {
    const ref = await openSession(targetPort);
    // Fill the pane's pool outside the proxy. The per-pane lanes are live
    // and awaited; the queue waiters can only resolve once a live lane
    // closes, so they are PARKED rather than awaited (awaiting one would
    // await the very cap condition this test asks the proxy about). A
    // parked rejection is the broker's reset word, which teardown may raise;
    // catching it is the test's job, not a swallow.
    const held: string[] = [];
    for (let i = 0; i < PREVIEW_FORWARD_SESSIONS_PER_PANE; i += 1) {
      held.push((await getPreviewBroker().openLaneForConnection(ref)).laneRef);
    }
    const parked: Promise<void>[] = [];
    for (let i = 0; i < PREVIEW_LANE_QUEUE_MAX; i += 1) {
      parked.push(
        getPreviewBroker()
          .openLaneForConnection(ref)
          .then(
            ({ laneRef }) => void held.push(laneRef),
            () => undefined,
          ),
      );
    }
    const res = await proxyFetch(`/pv/${ref}/echo`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("preview-lane-over-cap");
    // Closing a live lane drains one waiter into a fresh lane, which the
    // sweep sees because `held` grows while it iterates. Two passes plus
    // the waiter join, so every minted lane is closed and no double-close
    // error escapes.
    const sweep = async (): Promise<void> => {
      for (const laneRef of held) {
        await getPreviewBroker()
          .closeLaneForConnection(laneRef, "viewer-left")
          .catch(() => undefined);
      }
    };
    await sweep();
    await Promise.all(parked);
    await sweep();
  });
});

/* ------------------------------------------------------------------ */
/* the WS half: gates (refusals are HTTP, read off a raw socket)       */
/* ------------------------------------------------------------------ */

describe("pv-ws: the upgrade gates", () => {
  let proxyPort = 0;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    const app = createApp();
    app.listen({ port: 0, hostname: "127.0.0.1" });
    proxyPort = app.server?.port ?? 0;
    if (!proxyPort) throw new Error("the proxy did not report a bound port");
    stop = () => app.server?.stop();
  });
  afterAll(() => stop?.());

  it("refuses a cross-site Origin and passes the plane origin, an opaque origin, a registry origin, and a missing Origin", async () => {
    const ref = await openSession(targetPort);
    const planeOrigin = originRegistry().current()[0];
    expect((await probeUpgrade(proxyPort, `/pv/${ref}/hmr`, "null")).status).toBe(101);
    expect(await probeUpgrade(proxyPort, `/pv/${ref}/hmr`, "http://203.0.113.66:9999")).toMatchObject({ status: 403 });
    originRegistry().setPluginOrigins(PLUGIN, [DOC_ORIGIN]);
    expect((await probeUpgrade(proxyPort, `/pv/${ref}/hmr`, planeOrigin)).status).toBe(101);
    expect((await probeUpgrade(proxyPort, `/pv/${ref}/hmr`, DOC_ORIGIN)).status).toBe(101);
    expect((await probeUpgrade(proxyPort, `/pv/${ref}/hmr`)).status).toBe(101);
  });

  it("refuses an unknown session ref before the socket exists", async () => {
    const ref = await openSession(targetPort);
    const probe = await probeUpgrade(proxyPort, `/pv/${ref.replace(/^.{6}/, "000000")}/hmr`);
    expect(probe.status).toBe(404);
  });

  it("refuses a lane-cap overflow upgrade with a 503 naming preview-lane-over-cap", async () => {
    const ref = await openSession(targetPort);
    // Same fill as the HTTP cap leg: live lanes awaited, queue waiters
    // parked (see the comment there for why awaiting one is awaiting the
    // cap itself).
    const held: string[] = [];
    for (let i = 0; i < PREVIEW_FORWARD_SESSIONS_PER_PANE; i += 1) {
      held.push((await getPreviewBroker().openLaneForConnection(ref)).laneRef);
    }
    const parked: Promise<void>[] = [];
    for (let i = 0; i < PREVIEW_LANE_QUEUE_MAX; i += 1) {
      parked.push(
        getPreviewBroker()
          .openLaneForConnection(ref)
          .then(
            ({ laneRef }) => void held.push(laneRef),
            () => undefined,
          ),
      );
    }
    const probe = await probeUpgrade(proxyPort, `/pv/${ref}/hmr`);
    expect(probe.status).toBe(503);
    expect(probe.raw).toContain("preview-lane-over-cap");
    const sweep = async (): Promise<void> => {
      for (const laneRef of held) {
        await getPreviewBroker()
          .closeLaneForConnection(laneRef, "viewer-left")
          .catch(() => undefined);
      }
    };
    await sweep();
    await Promise.all(parked);
    await sweep();
  });
});

/* ------------------------------------------------------------------ */
/* the WS half: tunnels                                                */
/* ------------------------------------------------------------------ */

describe("pv-ws: the tunnels", () => {
  let proxyPort = 0;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    const app = createApp();
    app.listen({ port: 0, hostname: "127.0.0.1" });
    proxyPort = app.server?.port ?? 0;
    if (!proxyPort) throw new Error("the proxy did not report a bound port");
    stop = () => app.server?.stop();
  });
  afterAll(() => stop?.());

  it("round-trips binary and text byte-exactly in http mode, all through the lane", async () => {
    const ref = await openSession(targetPort);
    const payload = Buffer.from([0, 7, 128, 255, 61, 10]);
    const before = fake.piped;
    const got = await new Promise<{ binary: number[]; text: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pv/${ref}/hmr`);
      ws.binaryType = "arraybuffer";
      const out: { binary?: number[]; text?: string } = {};
      ws.onopen = () => {
        ws.send(payload);
        ws.send("plain text, not JSON");
      };
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) out.binary = [...new Uint8Array(e.data)];
        else out.text = String(e.data);
        if (out.binary && out.text) {
          ws.close();
          resolve(out as { binary: number[]; text: string });
        }
      };
      ws.onerror = (e) => reject(new Error(`tunnel failed: ${String(e)}`));
      setTimeout(() => reject(new Error(`tunnel stalled; got ${JSON.stringify(out)}`)), 5_000);
    });
    expect(got.binary).toEqual([...payload]);
    expect(got.text).toBe("plain text, not JSON");
    // The bypass guard: the handshake AND both payloads rode the fake node.
    // The in-proc target answers on plane loopback, so a client that had
    // dialed around the lane would look identical while this sat at `before`.
    expect(fake.piped).toBeGreaterThan(before);
  });

  it("carries Elysia-coerced text frames as text: primitives ride their string form, JSON re-stringifies", async () => {
    const ref = await openSession(targetPort);
    const frames = [
      '{ plain: "text" }',
      'spaced {"a": 1} json',
      "123",
      "true",
      "null",
      '{ "type": "update", "updates": [] }',
      '{ "buffer": 1, "byteOffset": 0 }',
    ];
    const got = await new Promise<string[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pv/${ref}/hmr`);
      const back: string[] = [];
      ws.onopen = () => {
        for (const f of frames) ws.send(f);
      };
      ws.onmessage = (e) => {
        back.push(String(e.data));
        if (back.length === frames.length) {
          ws.close();
          resolve(back);
        }
      };
      ws.onerror = (e) => reject(new Error(`coerced-frame tunnel failed: ${String(e)}`));
      setTimeout(() => reject(new Error(`coerced-frame tunnel stalled; got ${JSON.stringify(back)}`)), 5_000);
    });
    // Text that merely LOOKS JSONed but is not valid JSON stays a string at
    // the handler and rides byte-exact, whitespace and all: the brace-object
    // with unquoted keys and the word-wrapped JSON fragment both arrive
    // exactly as written.
    expect(got[0]).toBe('{ plain: "text" }');
    expect(got[1]).toBe('spaced {"a": 1} json');
    // Elysia's parser hands "123"/"true"/"null" over as the number/boolean/
    // null the JSON coercion made them. They must still arrive as the TEXT
    // the browser wrote: the target sees bare digits and words.
    expect(got[2]).toBe("123");
    expect(got[3]).toBe("true");
    expect(got[4]).toBe("null");
    // A frame that parses as real JSON arrives re-parsed; the promise is
    // semantics, so pin the compact re-stringification. A parser change
    // that starts delivering raw text still passes; one that eats the
    // frame does not.
    expect(got[5]).toBe(JSON.stringify({ type: "update", updates: [] }));
    // A JSON object whose content happens to pair the key names `buffer` and
    // `byteOffset` is still a plain object, not a buffer view: it rides
    // re-stringified text. A duck-check of those key names would read the
    // JSON values as view offsets, throw, and destroy the frame.
    expect(got[6]).toBe(JSON.stringify({ buffer: 1, byteOffset: 0 }));
  });

  it("rides an upgrade-response Set-Cookie into the jar and onto the next HTTP request", async () => {
    const ref = await openSession(targetPort);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pv/${ref}/hmr-cookie`);
      // The browser `onopen` is the PLANE's answer, not the lane's: the
      // redial handshake is still in flight. Closing here would tear the
      // duplex down before the 101 (and its cookie) lands. One echoed
      // frame proves the redial completed, which is also the moment the
      // jar took the cookie.
      ws.onopen = () => ws.send("ping");
      ws.onmessage = () => {
        ws.onclose = () => resolve();
        ws.close();
      };
      ws.onerror = (e) => reject(new Error(`cookie upgrade failed: ${String(e)}`));
      setTimeout(() => reject(new Error("cookie upgrade stalled")), 5_000);
    });
    // Spec §6's jar sentence is unqualified about WHICH lane sets a cookie:
    // the WS redial's upgrade answer rides the session like an HTTP answer's.
    const seen = (await (await proxyFetch(`/pv/${ref}/echo`)).json()) as TargetSeen;
    expect(seen.cookie).toContain("hsid=upgraded");
    // A different session's proxy path carries nothing.
    const ref2 = await openSession(targetPort);
    const other = (await (await proxyFetch(`/pv/${ref2}/echo`)).json()) as TargetSeen;
    expect(other.cookie).toBeNull();
  });

  it("pumps raw mode verbatim, answers as binary frames, and carries target-gone to the close event", async () => {
    fake.reportScreenRfbPort = rfbPort;
    const ref = await openSession(rfbPort); // the registered screen port => raw
    const pipedBefore = fake.piped;
    expect(getPreviewBroker().sessionFor(ref)?.mode).toBe("raw");
    const hello = Buffer.from([0x52, 0x46, 0x42, 0x00]); // "RFB\x00"
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pv/${ref}/`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(hello);
      ws.onmessage = (e) => {
        // The raw target echoed REVERSED bytes: the payload must come back
        // intact, not as an HTTP-reformatted anything.
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        expect([...bytes]).toEqual([...hello].reverse());
        // Kill the target's side; the fake node reports target-gone.
        for (const s of rfbAcceptList) s.destroy();
      };
      ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
      ws.onerror = (e) => reject(new Error(`raw tunnel failed: ${String(e)}`));
      setTimeout(() => reject(new Error("raw tunnel stalled")), 5_000);
    });
    expect(closed.code).toBe(1011);
    expect(closed.reason).toBe("target-gone");
    // No HTTP upgrade ever reached the raw target: whatever it read starts
    // with the RFB payload, never "GET ".
    const seen = Buffer.concat(rfbLog).toString("latin1");
    expect(seen.startsWith("GET ")).toBe(false);
    expect(seen).toContain("RFB");
    // The bypass guard, same doctrine as the http-mode leg: the rfb target
    // answers on plane loopback, so only the pump counter proves the bytes
    // rode the fake node rather than a direct dial.
    expect(fake.piped).toBeGreaterThan(pipedBefore);
  });

  it("closes the lane viewer-left when the viewer's socket goes first", async () => {
    const ref = await openSession(targetPort);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pv/${ref}/hmr`);
      ws.onopen = () => ws.close();
      ws.onclose = () => resolve();
      ws.onerror = (e) => reject(new Error(String(e)));
    });
    // The lane close rides the wire with the viewer-left reason.
    await new Promise((res) => setTimeout(res, 200));
    expect(fake.closedLanes.some((c) => c.reason === "viewer-left")).toBe(true);
  });

  it("refuses slow links: bytes past preAckMaxBytes before the handshake closes slow-link", async () => {
    // The seam: a small pre-ack budget so the boundary is drivable (the same
    // doctrine as Task 5's laneBufferMaxBytes). Production default is
    // PREVIEW_LANE_BUFFER_MAX_BYTES.
    expect(PREVIEW_LANE_BUFFER_MAX_BYTES).toBe(1_048_576);
    fake.reportScreenRfbPort = null;
    const ref = await openSession(silentPort);
    const app = new Elysia()
      .use(errorHandlerPlugin)
      .use(pvHttpRoute)
      .use(previewWsRoute({ preAckMaxBytes: 64 }));
    app.listen({ port: 0, hostname: "127.0.0.1" });
    const port = app.server?.port ?? 0;
    if (!port) throw new Error("the slow-link proxy did not report a bound port");
    try {
      const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/pv/${ref}/hmr`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          // The silent target never answers the lane-side handshake: pump
          // past the budget and wait for the named death.
          const chunk = Buffer.alloc(32, 0x41);
          for (let i = 0; i < 10; i += 1) ws.send(Buffer.from(chunk));
        };
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
        ws.onerror = (e) => reject(new Error(String(e)));
        setTimeout(() => reject(new Error("slow-link never fired")), 5_000);
      });
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("slow-link");
    } finally {
      app.server?.stop();
    }
  });
});
