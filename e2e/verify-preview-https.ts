/** Real enrolled-node HTTPS preview check, including a TLS-terminating edge.
 * Run with unused E2E_PORT_* values; PREVIEW_VITE_PORT defaults to 5199.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, request } from "@playwright/test";
import { BASE_URL, PORTS } from "./ports";
import { startStack, stopStack } from "./stack";
import { startNode } from "./stub/client";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    tls: { cert: Buffer; key: Buffer };
    fetch: (req: Request) => Response | Promise<Response>;
  }): { port: number; stop(closeActive: boolean): void };
};

const scratch = mkdtempSync(path.join(tmpdir(), "ss-https-"));
const cleanup: (() => unknown | Promise<unknown>)[] = [() => rmSync(scratch, { recursive: true, force: true })];
const vitePort = Number(process.env.PREVIEW_VITE_PORT ?? 5199);
const viteOrigin = `http://localhost:${vitePort}`;
try {
  // Refuse occupied fixture ports before creating an account or touching a stack.
  for (const port of [vitePort, PORTS.backend, PORTS.fakeRegistry, PORTS.fakeIdp]) {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", () =>
        reject(new Error(`Port ${port} is unavailable; choose unused E2E_PORT_* and PREVIEW_VITE_PORT values.`)),
      );
      probe.listen(port, "127.0.0.1", () => probe.close((error) => (error ? reject(error) : resolve())));
    });
  }
  const cert = path.join(scratch, "cert.pem");
  const key = path.join(scratch, "key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  const tls = { cert: readFileSync(cert), key: readFileSync(key) };
  const hits: string[] = [];
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      if (url.pathname === "/")
        return new Response(
          '<!doctype html><html><head><title>HTTPS fixture</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script><script type="module" src="/module.js"></script><script src="/_next/static/chunks/check.js" defer></script></head><body><h1>HTTPS fixture</h1><img alt="TLS image" src="/image.svg"><p id="result">Waiting</p></body></html>',
          { headers: { "content-type": "text/html" } },
        );
      if (url.pathname === "/style.css")
        return new Response("h1 { color: rgb(12, 123, 45) }", { headers: { "content-type": "text/css" } });
      if (url.pathname === "/app.js")
        return new Response(
          'fetch("/data.json").then(r=>r.json()).then(d=>document.querySelector("#result").textContent=d.message)',
          { headers: { "content-type": "application/javascript" } },
        );
      if (url.pathname === "/module.js")
        return new Response(
          'import {value} from "/dependency.js"; const part="/dependency.js"; import(part).then(m=>document.body.dataset.module=String(value+m.value))',
          { headers: { "content-type": "application/javascript" } },
        );
      if (url.pathname === "/dependency.js")
        return new Response("export const value=21", { headers: { "content-type": "application/javascript" } });
      if (url.pathname === "/_next/static/chunks/check.js")
        return new Response("document.body.dataset.chunkBase=globalThis.TURBOPACK_CHUNK_BASE_PATH", {
          headers: { "content-type": "application/javascript" },
        });
      if (url.pathname === "/image.svg")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="green"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      if (url.pathname === "/data.json") return Response.json({ message: "Script and fetch loaded over HTTPS" });
      return new Response("Missing", { status: 404 });
    },
  });
  cleanup.unshift(() => target.stop(true));
  cleanup.unshift(stopStack);
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.unshift(() => api.dispose());
  const call = async (method: "post" | "put" | "patch", url: string, data?: object) => {
    const result = await api[method](url, { data });
    if (!result.ok()) throw new Error(`${method} ${url}: ${result.status()} ${await result.text()}`);
    return result.json();
  };
  const email = "https-preview@example.test",
    password = "preview-https-test-1";
  await call("post", "/api/auth/sign-up/email", { name: "HTTPS preview test", email, password });
  await call("patch", "/api/setup/progress", { step: null });
  const setup = await call("post", "/api/nodes/setup-keys");
  const tmuxBase = path.join(scratch, "t");
  mkdirSync(tmuxBase);
  const agent = await startNode({
    home: path.join(scratch, "home"),
    dataDir: path.join(scratch, "node"),
    tmuxBase,
    setupKey: setup.key,
    name: "HTTPS test node",
  });
  cleanup.unshift(() => agent.stop());
  let nodeId = "";
  await expect
    .poll(
      async () => {
        const nodes = (await (await api.get("/api/nodes")).json()).nodes;
        const node = nodes.find((n: any) => n.name === "HTTPS test node");
        nodeId = node?.id;
        return node?.status;
      },
      { timeout: 30000 },
    )
    .toBe("online");
  await call("post", `/api/nodes/${nodeId}/recheck`);
  await expect
    .poll(
      async () => {
        const nodes = (await (await api.get("/api/nodes")).json()).nodes;
        const node = nodes.find((row: { id: string }) => row.id === nodeId);
        return (
          !node?.inventoryStale &&
          node?.harnesses.some(
            (h: { harnessId: string; installed: boolean }) => h.harnessId === "terminal" && h.installed,
          )
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await call("put", `/api/nodes/${nodeId}/views-enabled`, { on: true });
  const pane = await call("post", "/api/subshells", {
    harnessId: "terminal",
    nodeId,
    name: "HTTPS assets",
    workingDir: scratch,
  });
  cleanup.unshift(() => api.delete(`/api/subshells/${pane.id}`));
  const config = {
    host: "127.0.0.1",
    protocol: "https",
    ignoreCertificateErrors: true,
    sandbox: false,
    rewriteUrls: true,
    passHost: false,
    rewriteRedirects: true,
  };
  await call("post", `/api/subshells/${pane.id}/services`, {
    name: "HTTPS fixture",
    port: target.port,
    ...config,
    configuration: config,
  });
  const workspace = await call("post", "/api/workspaces", { name: "HTTPS regression", subshellId: pane.id });
  // The edge forwards Host but does not provide a trusted forwarded protocol.
  let framePath = "";
  const edge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/test-frame")
        return new Response(
          `<iframe title="HTTPS preview" sandbox="allow-scripts allow-forms" src="${framePath}"></iframe>`,
          { headers: { "content-type": "text/html" } },
        );
      const destination = new URL(
        url.pathname + url.search,
        url.pathname.startsWith("/api/") || url.pathname.startsWith("/pv/") ? BASE_URL : viteOrigin,
      );
      const headers = new Headers(req.headers);
      headers.set("host", url.host);
      headers.delete("connection");
      return fetch(destination, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        redirect: "manual",
      });
    },
  });
  cleanup.unshift(() => edge.stop(true));
  const edgeOrigin = `https://localhost:${edge.port}`;
  const vite = spawn(
    "bun",
    [
      new URL("../apps/server/web/node_modules/vite/bin/vite.js", import.meta.url).pathname,
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
    ],
    {
      cwd: new URL("../apps/server/web", import.meta.url).pathname,
      env: { ...process.env, DEV_API_ORIGIN: BASE_URL, DEV_ALLOWED_ORIGINS: `${edgeOrigin},${viteOrigin}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += d));
  vite.stderr.on("data", (d) => (viteLog += d));
  cleanup.unshift(async () => {
    if (vite.exitCode !== null || vite.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => vite.kill("SIGKILL"), 5000);
      vite.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      vite.kill();
    });
  });
  await expect
    .poll(
      async () => {
        if (vite.exitCode !== null || vite.signalCode !== null) throw new Error(`Vite exited: ${viteLog}`);
        try {
          return (await fetch(viteOrigin, { signal: AbortSignal.timeout(2000) })).status;
        } catch {
          return 0;
        }
      },
      { timeout: 30000 },
    )
    .toBe(200);
  const browser = await chromium.launch();
  cleanup.unshift(() => browser.close());
  // Browser certificate checks are disabled for the disposable edge; the node
  // independently enforces target TLS. Asset assertions below also pin their origin.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1100, height: 680 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${viteOrigin}/login`);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => page.url(), { timeout: 15000 }).not.toContain("/login");
  console.log(`Hot-reload login verified: ${viteOrigin} (${email} / ${password}; disposable account)`);
  await page.goto(`${viteOrigin}/workspaces/${workspace.id}`);
  await page.getByRole("button", { name: /^Open web preview or screen/ }).click();
  await page.getByRole("button", { name: "Edit HTTPS fixture", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit service" });
  for (const size of [
    { width: 1100, height: 680 },
    { width: 430, height: 700 },
  ]) {
    await page.setViewportSize(size);
    const scrolls = await dialog.evaluate(
      (el) =>
        [el, ...el.querySelectorAll("*")].filter(
          (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1,
        ).length,
    );
    expect(scrolls).toBe(1);
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const before = await close.boundingBox();
    await dialog.evaluate((el) => {
      const scroll = [...el.querySelectorAll("*")].find(
        (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1,
      );
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
    expect((await close.boundingBox())?.y).toBe(before?.y);
    console.log(`Dialog ${size.width}x${size.height}: one scrollbar, close button stays fixed`);
  }
  await page.screenshot({ path: "/tmp/subshell-preview-dialog.png" });
  // Cookies are host-bound, so the localhost Vite login also authenticates the edge.
  const opened = await call("post", `/api/subshells/${pane.id}/views/open`, {
    port: target.port,
    configuration: config,
  });
  const errors: string[] = [],
    assetFailures: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Mixed Content/i.test(m.text())) errors.push(m.text());
  });
  page.on("requestfailed", (r) => assetFailures.push(r.url()));
  const assetRequests: string[] = [];
  page.on("request", (r) => {
    if (["script", "stylesheet", "image", "fetch"].includes(r.resourceType())) assetRequests.push(r.url());
  });
  for (const origin of [edgeOrigin, viteOrigin]) {
    await page.goto(origin + opened.proxyBase);
    await expect(page.locator("#result")).toHaveText("Script and fetch loaded over HTTPS");
    await expect(page.locator("h1")).toHaveCSS("color", "rgb(12, 123, 45)");
    await expect(page.locator("body")).toHaveAttribute("data-module", "42");
    await expect(page.locator("body")).toHaveAttribute("data-chunk-base", `${origin}${opened.proxyBase}_next/`);
    await expect
      .poll(() =>
        page.getByAltText("TLS image").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 80),
      )
      .toBe(true);
  }
  const sandboxed = await call("post", `/api/subshells/${pane.id}/views/open`, {
    port: target.port,
    configuration: { ...config, sandbox: true },
  });
  framePath = sandboxed.proxyBase;
  await page.goto(`${edgeOrigin}/test-frame`);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#result")).toHaveText("Script and fetch loaded over HTTPS");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(12, 123, 45)");
  await expect(frame.locator("body")).toHaveAttribute("data-module", "42");
  await expect(frame.locator("body")).toHaveAttribute("data-chunk-base", `${edgeOrigin}${framePath}_next/`);
  await expect
    .poll(() =>
      frame.getByAltText("TLS image").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 80),
    )
    .toBe(true);
  await page.screenshot({ path: "/tmp/subshell-preview-https-assets.png" });
  expect(errors).toEqual([]);
  expect(assetFailures).toEqual([]);
  expect(assetRequests.length).toBeGreaterThan(0);
  for (const url of assetRequests)
    expect([edgeOrigin, viteOrigin].some((origin) => url.startsWith(`${origin}/pv/`))).toBe(true);
  for (const resource of [
    "/",
    "/style.css",
    "/app.js",
    "/image.svg",
    "/data.json",
    "/module.js",
    "/dependency.js",
    "/_next/static/chunks/check.js",
  ])
    expect(hits).toContain(resource);
  console.log(
    "HTTPS edge → HTTP server → encrypted node tunnel → self-signed HTTPS target: script, CSS, image and fetch passed; no mixed content",
  );
  const strict = await call("post", `/api/subshells/${pane.id}/views/open`, {
    port: target.port,
    configuration: { ...config, ignoreCertificateErrors: false },
  });
  const hitsBeforeStrict = hits.length;
  const refused = await api.get(strict.proxyBase);
  expect(refused.status()).toBe(502);
  expect(hits.length).toBe(hitsBeforeStrict);
  console.log(`Certificate validation enabled: target refused (${refused.status()})`);
} finally {
  for (const fn of cleanup) {
    try {
      await fn();
    } catch (e) {
      console.error("Cleanup:", e);
      process.exitCode = 1;
    }
  }
}
