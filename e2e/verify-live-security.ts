/**
 * Live HTTP, WebSocket, browser, and enrolled-node probes against a disposable
 * running stack with test mode disabled. No server internals or test hooks.
 * Run with unused E2E_PORT_* values; LIVE_SECURITY_REPORT selects the JSON report.
 * LIVE_SECURITY_NGINX_IMAGE enables a real nginx edge with a disposable canary.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, chromium, request } from "@playwright/test";
import { BASE_URL, PORTS } from "./ports";
import { startStack, stopStack } from "./stack";
import { startNode } from "./stub/client";

const scratch = mkdtempSync(path.join(tmpdir(), "ss-pen-"));
const checks: { label: string; passed: boolean; actual?: unknown }[] = [];
const cleanup: (() => unknown | Promise<unknown>)[] = [() => rmSync(scratch, { recursive: true, force: true })];
const reportPath = process.env.LIVE_SECURITY_REPORT ?? path.join(tmpdir(), "subshell-live-security.json");
const nginxPort = Number(process.env.LIVE_SECURITY_NGINX_PORT ?? 43293);

function check(label: string, passed: boolean, actual?: unknown): void {
  checks.push({ label, passed, ...(actual === undefined ? {} : { actual }) });
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
}
async function call(
  api: APIRequestContext,
  method: string,
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
) {
  return api.fetch(url, { method, data, headers, maxRedirects: 0, timeout: 15000 });
}
async function expectStatus(
  label: string,
  api: APIRequestContext,
  method: string,
  url: string,
  status: number,
  data?: unknown,
  headers?: Record<string, string>,
) {
  const result = await call(api, method, url, data, headers);
  check(label, result.status() === status, result.status());
  return result;
}
async function setup(api: APIRequestContext, method: string, url: string, data?: unknown) {
  const result = await call(api, method, url, data);
  if (!result.ok()) throw new Error(`Fixture setup ${method} ${url}: HTTP ${result.status()}`);
  return result.json();
}
async function context() {
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.unshift(() => api.dispose());
  return api;
}
async function poll(predicate: () => boolean | Promise<boolean>, label: string, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const wsOrigin = BASE_URL.replace(/^http/, "ws");
async function rejectedSocket(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Socket wasn't refused"));
    }, 5000);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
    socket.onerror = () => {};
  });
}
async function attachedSocket(token: string, pane: string) {
  const socket = new WebSocket(`${wsOrigin}/ws?subshell=${pane}&token=${encodeURIComponent(token)}`);
  cleanup.unshift(() => socket.close());
  let closed: number | undefined;
  socket.addEventListener("close", (event) => {
    closed = event.code;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No terminal replay")), 10000);
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        if (JSON.parse(event.data).type === "replay") {
          clearTimeout(timer);
          resolve();
        }
      } catch {}
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Terminal socket failed"));
    };
  });
  return { socket, closed: () => closed };
}

try {
  const ports = [PORTS.backend, PORTS.fakeRegistry, PORTS.fakeIdp];
  if (process.env.LIVE_SECURITY_NGINX_IMAGE) ports.push(nginxPort);
  for (const port of ports) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close((err) => (err ? reject(err) : resolve())));
    });
  }
  cleanup.unshift(stopStack);
  await startStack();
  console.log(`Disposable live target: ${BASE_URL}`);
  const admin = await context(),
    alice = await context(),
    bob = await context(),
    anonymous = await context();
  const password = `fixture-${randomUUID()}`;
  await setup(admin, "POST", "/api/auth/sign-up/email", { name: "Audit admin", email: "admin@audit.test", password });
  await setup(admin, "PATCH", "/api/setup/progress", { step: null });
  const owner = await setup(admin, "POST", "/api/users", {
    name: "Audit owner",
    email: "owner@audit.test",
    password,
    role: "user",
  });
  const guest = await setup(admin, "POST", "/api/users", {
    name: "Audit guest",
    email: "guest@audit.test",
    password,
    role: "user",
  });
  await setup(alice, "POST", "/api/auth/sign-in/email", { email: owner.email, password });
  await setup(bob, "POST", "/api/auth/sign-in/email", { email: guest.email, password });

  const working = path.join(scratch, "workspace"),
    outside = path.join(scratch, "outside");
  mkdirSync(working);
  mkdirSync(outside);
  const pane = await setup(alice, "POST", "/api/subshells", {
    harnessId: "terminal",
    nodeId: "local",
    workingDir: working,
    name: "Live audit fixture",
  });
  for (const resource of ["subshells", "nodes", "users", "system-keys", "admin/status", "channels", "workspaces"])
    await expectStatus(`anonymous ${resource}`, anonymous, "GET", `/api/${resource}`, 401);
  for (const suffix of ["", "/log"])
    await expectStatus(`foreign pane ${suffix || "detail"}`, bob, "GET", `/api/subshells/${pane.id}${suffix}`, 404);
  await expectStatus("admin has no private-pane boost", admin, "GET", `/api/subshells/${pane.id}`, 404);
  await expectStatus("foreign pane input", bob, "POST", `/api/subshells/${pane.id}/input`, 404, {
    text: "echo forbidden",
  });
  await expectStatus("foreign pane deletion", bob, "DELETE", `/api/subshells/${pane.id}`, 404);
  await expectStatus("ordinary account cannot promote itself", bob, "PATCH", `/api/users/${guest.id}/role`, 403, {
    role: "admin",
  });
  await expectStatus("ordinary account cannot mint system key", bob, "POST", "/api/system-keys", 403, {
    name: "forbidden",
    permissions: ["subshells:execute"],
  });
  await expectStatus("plugin self-service key creation blocked", alice, "POST", "/api/auth/api-key/create", 403, {
    name: "forged",
    metadata: { kind: "system" },
  });

  for (const origin of ["null", "http://attacker.invalid", `${BASE_URL}.attacker.invalid`])
    await expectStatus(
      `cookie origin refusal (${origin})`,
      alice,
      "POST",
      `/api/subshells/${pane.id}/input`,
      403,
      { text: "echo forbidden" },
      { origin },
    );

  symlinkSync(outside, path.join(working, ".subshell"));
  const upload = await alice.post(`/api/subshells/${pane.id}/uploads`, {
    multipart: { file: { name: "canary.txt", mimeType: "text/plain", buffer: Buffer.from("private canary") } },
  });
  check(
    "HTTP upload rejects planted directory link",
    upload.status() === 400 && readdirSync(outside).length === 0,
    upload.status(),
  );
  rmSync(path.join(working, ".subshell"));
  const goodUpload = await alice.post(`/api/subshells/${pane.id}/uploads`, {
    multipart: { file: { name: "canary.txt", mimeType: "text/plain", buffer: Buffer.from("private canary") } },
  });
  check("ordinary HTTP upload still works", goodUpload.status() === 200);
  const gitVictim = path.join(outside, "git-exclude-canary");
  writeFileSync(gitVictim, "unchanged", { mode: 0o640 });
  mkdirSync(path.join(working, ".git", "info"), { recursive: true });
  linkSync(gitVictim, path.join(working, ".git", "info", "exclude"));
  const linkedExcludeUpload = await alice.post(`/api/subshells/${pane.id}/uploads`, {
    multipart: { file: { name: "canary.txt", mimeType: "text/plain", buffer: Buffer.from("private canary") } },
  });
  check(
    "HTTP upload leaves hard-linked Git exclude untouched",
    linkedExcludeUpload.status() === 200 &&
      readFileSync(gitVictim, "utf8") === "unchanged" &&
      (statSync(gitVictim).mode & 0o777) === 0o640,
  );

  const readKey = await setup(admin, "POST", "/api/system-keys", {
    name: "Live read scope",
    permissions: ["subshells:read"],
  });
  const readHeaders = { authorization: `Bearer ${readKey.key}` };
  await expectStatus("scoped key can list", anonymous, "GET", "/api/subshells", 200, undefined, readHeaders);
  await expectStatus(
    "scoped key cannot execute",
    anonymous,
    "POST",
    `/api/subshells/${pane.id}/input`,
    403,
    { text: "echo forbidden" },
    readHeaders,
  );
  await expectStatus(
    "scoped key cannot mint terminal access",
    anonymous,
    "POST",
    "/api/auth/ws-token",
    403,
    { subshellId: pane.id },
    readHeaders,
  );
  await expectStatus(
    "scoped key cannot enroll nodes",
    anonymous,
    "POST",
    "/api/nodes/setup-keys",
    403,
    {},
    readHeaders,
  );
  await setup(admin, "PATCH", `/api/system-keys/${readKey.id}`, { enabled: false });
  await expectStatus(
    "revoked scoped key fails next authentication",
    anonymous,
    "GET",
    "/api/subshells",
    401,
    undefined,
    readHeaders,
  );

  await setup(admin, "PUT", "/api/nodes/local/views-enabled", { on: true });
  const targetHeaders: Record<string, string>[] = [];
  const target = createServer((req, res) => {
    targetHeaders.push({
      cookie: req.headers.cookie ?? "",
      authorization: req.headers.authorization ?? "",
      edge: String(req.headers["cf-access-jwt-assertion"] ?? ""),
    });
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "target_only=canary; Path=/",
      "x-accel-redirect": "/private/audit-canary",
      "x-sendfile": "/private/instance.db",
      "x-sendfile-temporary": "/private/backup.tar",
      "x-sendfile2": "/private/instance.db 0-",
      "x-lighttpd-send-file": "/private/instance.db",
    });
    res.end(
      "<!doctype html><title>Attack fixture</title><h1>Untrusted preview</h1><script>window.fixtureExecuted=true</script>",
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  cleanup.unshift(() => {
    target.closeAllConnections();
    target.close();
  });
  const targetPort = (target.address() as AddressInfo).port;
  const configuration = {
    host: "127.0.0.1",
    protocol: "http",
    ignoreCertificateErrors: false,
    sandbox: true,
    rewriteUrls: true,
    passHost: false,
    rewriteRedirects: true,
  };
  const openData = { port: targetPort, configuration };
  await setup(alice, "PUT", `/api/subshells/${pane.id}/shares`, {
    shares: [{ granteeUserId: guest.id, permission: "view" }],
  });
  await expectStatus("view grant can read", bob, "GET", `/api/subshells/${pane.id}`, 200);
  await expectStatus("view grant cannot type", bob, "POST", `/api/subshells/${pane.id}/input`, 403, {
    text: "echo forbidden",
  });
  await expectStatus(
    "view grant cannot open a forward",
    bob,
    "POST",
    `/api/subshells/${pane.id}/views/open`,
    403,
    openData,
  );
  const viewTicket = await setup(bob, "POST", "/api/auth/ws-token");
  const viewer = await attachedSocket(viewTicket.token, pane.id);
  const wsCanary = path.join(working, "unauthorized-ws-write");
  viewer.socket.send(JSON.stringify({ type: "input", data: `touch '${wsCanary}'\n`, id: 1 }));
  // Let the socket's input handler run, then verify the independently visible effect.
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("view-only live terminal rejects input", !existsSync(wsCanary));
  const replayCode = await rejectedSocket(
    `${wsOrigin}/ws?subshell=${pane.id}&token=${encodeURIComponent(viewTicket.token)}`,
  );
  check("terminal ticket is single use", replayCode === 4001, replayCode);
  await setup(alice, "PUT", `/api/subshells/${pane.id}/shares`, {
    shares: [{ granteeUserId: guest.id, permission: "edit" }],
  });
  await poll(() => viewer.closed() !== undefined, "share change closes old terminal");
  check("share change closes existing terminal", viewer.closed() === 1012, viewer.closed());
  const editTicket = await setup(bob, "POST", "/api/auth/ws-token");
  const editor = await attachedSocket(editTicket.token, pane.id);
  editor.socket.send(JSON.stringify({ type: "input", data: `touch '${wsCanary}'\n`, id: 1 }));
  await poll(() => existsSync(wsCanary), "positive control: edit-grant terminal input");
  check("same terminal accepts edit-grant input", existsSync(wsCanary));
  const guestPreview = await setup(bob, "POST", `/api/subshells/${pane.id}/views/open`, openData);
  await expectStatus("edit grant can forward", anonymous, "GET", guestPreview.proxyBase, 200);
  await setup(alice, "PUT", `/api/subshells/${pane.id}/shares`, { shares: [] });
  await expectStatus("revoked preview capability dies", anonymous, "GET", guestPreview.proxyBase, 404);
  await expectStatus("revoked share hides pane", bob, "GET", `/api/subshells/${pane.id}`, 404);

  const preview = await setup(alice, "POST", `/api/subshells/${pane.id}/views/open`, openData);
  const proxied = await call(alice, "GET", preview.proxyBase, undefined, {
    authorization: "Bearer private-browser-canary",
    "cf-access-jwt-assertion": "private-edge-canary",
  });
  const responseHeaders = proxied.headers();
  check(
    "proxy strips all file-serving directives",
    ["x-accel-redirect", "x-sendfile", "x-sendfile-temporary", "x-sendfile2", "x-lighttpd-send-file"].every(
      (name) => responseHeaders[name] === undefined,
    ),
  );
  check(
    "proxy strips dashboard credentials on target hop",
    targetHeaders.at(-1)?.authorization === "" &&
      targetHeaders.at(-1)?.edge === "" &&
      !targetHeaders.at(-1)?.cookie.includes("better-auth"),
  );
  check("preview cookie never reaches browser", !responseHeaders["set-cookie"]);
  await call(anonymous, "GET", preview.proxyBase);
  check("target cookie stays in server jar", targetHeaders.at(-1)?.cookie.includes("target_only=canary") === true);

  const browser = await chromium.launch();
  cleanup.unshift(() => browser.close());
  const browserContext = await browser.newContext({ storageState: await alice.storageState() });
  const page = await browserContext.newPage();
  await page.goto(BASE_URL);
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.id = "audit-frame";
    document.body.append(frame);
  }, `${BASE_URL}${preview.proxyBase}`);
  await page.frameLocator("#audit-frame").getByRole("heading", { name: "Untrusted preview" }).waitFor();
  const frame = page.frames().find((f) => f.url().includes("/pv/"));
  if (!frame) throw new Error("Preview frame didn't load");
  const attacks = await frame.evaluate(
    async ({ origin, pane }) => {
      const blocked = (fn: () => unknown) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const parent = blocked(() => window.parent.document.body);
      const storage = blocked(() => localStorage.getItem("audit"));
      const cookies = blocked(() => document.cookie);
      let api = false,
        worker = false,
        write = false;
      try {
        await fetch(`${origin}/api/subshells`, { credentials: "include" });
      } catch {
        api = true;
      }
      try {
        await navigator.serviceWorker.register("./worker.js");
      } catch {
        worker = true;
      }
      try {
        const r = await fetch(`${origin}/api/subshells/${pane}/input`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "echo forbidden" }),
        });
        write = !r.ok;
      } catch {
        write = true;
      }
      return { origin: self.origin, parent, storage, cookies, api, worker, write };
    },
    { origin: BASE_URL, pane: pane.id },
  );
  check(
    "Chromium opaque preview blocks dashboard authority",
    attacks.origin === "null" &&
      attacks.parent &&
      attacks.storage &&
      attacks.cookies &&
      attacks.api &&
      attacks.worker &&
      attacks.write,
    attacks,
  );
  const direct = await browserContext.newPage();
  await direct.goto(`${BASE_URL}${preview.proxyBase}`);
  check("direct preview navigation retains opaque origin", (await direct.evaluate(() => self.origin)) === "null");

  const attacker = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Foreign origin</title>");
  });
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  cleanup.unshift(() => {
    attacker.closeAllConnections();
    attacker.close();
  });
  await page.goto(`http://127.0.0.1:${(attacker.address() as AddressInfo).port}`);
  const csrfCanary = path.join(working, "unauthorized-csrf-write");
  const inputCanary = path.join(working, "authorized-api-write");
  await setup(alice, "POST", `/api/subshells/${pane.id}/input`, { text: `touch '${inputCanary}'` });
  await poll(() => existsSync(inputCanary), "positive control: authenticated HTTP input");
  check("authenticated HTTP input reaches running shell", existsSync(inputCanary));
  const csrf = await page.evaluate(
    async ({ origin, pane, canary }) => {
      try {
        const r = await fetch(`${origin}/api/subshells/${pane}/input`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ text: `touch '${canary}'` }),
        });
        return r.status;
      } catch {
        return "blocked";
      }
    },
    { origin: BASE_URL, pane: pane.id, canary: csrfCanary },
  );
  check(
    "same-site foreign-origin browser cannot submit input",
    (csrf === "blocked" || csrf === 403 || csrf === 400) && !existsSync(csrfCanary),
    csrf,
  );
  const foreignTicket = await setup(alice, "POST", "/api/auth/ws-token");
  const foreignWs = await page.evaluate(
    async (url) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          resolve(false);
        }, 5000);
        socket.onopen = () => {
          clearTimeout(timer);
          socket.close();
          resolve(false);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          resolve(true);
        };
      }),
    `${wsOrigin}/ws?subshell=${pane.id}&token=${foreignTicket.token}`,
  );
  check("foreign-origin WebSocket denied even with valid ticket", foreignWs);

  if (process.env.LIVE_SECURITY_NGINX_IMAGE) {
    const proxyPort = nginxPort;
    const canary = `nginx-private-${randomUUID()}`;
    writeFileSync(path.join(scratch, "canary"), canary);
    writeFileSync(
      path.join(scratch, "nginx.conf"),
      `pid /tmp/nginx.pid; error_log stderr; events {} http {
        access_log off;
        client_body_temp_path /tmp/client;
        proxy_temp_path /tmp/proxy;
        fastcgi_temp_path /tmp/fastcgi;
        uwsgi_temp_path /tmp/uwsgi;
        scgi_temp_path /tmp/scgi;
        server {
          listen 127.0.0.1:${proxyPort};
          location = /private/audit-canary { internal; alias /audit/canary; }
          location /positive { proxy_pass http://127.0.0.1:${targetPort}/; }
          location / { proxy_pass ${BASE_URL}; }
        }
      }`,
    );
    const name = `subshell-pen-${randomUUID().slice(0, 8)}`;
    const proc = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--tmpfs",
        "/tmp",
        "-v",
        `${scratch}:/audit:ro`,
        "--entrypoint",
        "nginx",
        process.env.LIVE_SECURITY_NGINX_IMAGE,
        "-c",
        "/audit/nginx.conf",
        "-g",
        "daemon off;",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let startupError = "";
    proc.stderr?.on("data", (data) => {
      startupError = (startupError + String(data)).slice(-2000);
    });
    cleanup.unshift(() => {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      proc.kill();
    });
    await poll(async () => {
      if (proc.exitCode !== null) throw new Error(`nginx exited: ${startupError.trim()}`);
      try {
        return (await fetch(`http://127.0.0.1:${proxyPort}/positive`)).ok;
      } catch {
        return false;
      }
    }, "nginx fixture");
    const positive = await (await fetch(`http://127.0.0.1:${proxyPort}/positive`)).text();
    check("nginx positive control executes X-Accel redirect", positive === canary);
    const protectedBody = await (await fetch(`http://127.0.0.1:${proxyPort}${preview.proxyBase}`)).text();
    check(
      "real nginx cannot execute preview-supplied redirect",
      protectedBody.includes("Untrusted preview") && !protectedBody.includes(canary),
    );
  }

  const setupKey = await setup(alice, "POST", "/api/nodes/setup-keys");
  const tmuxBase = globalThis.e2eStack?.tmuxBase;
  if (!tmuxBase) throw new Error("Disposable stack lost its tmux directory");
  const nodeHome = path.join(scratch, "node-home"),
    nodeData = path.join(scratch, "node-data");
  const node = await startNode({
    home: nodeHome,
    dataDir: nodeData,
    tmuxBase,
    setupKey: setupKey.key,
    name: "Live audit node",
    env: { SUBSHELL_DASHBOARD: "0" },
  });
  cleanup.unshift(() => node.stop());
  let nodeId = "";
  await poll(
    async () => {
      const nodes = await (await alice.get("/api/nodes")).json();
      const found = nodes.nodes.find((n: { name: string }) => n.name === "Live audit node");
      nodeId = found?.id;
      return found?.status === "online";
    },
    "real enrolled node",
    30000,
  );
  await expectStatus("foreign account cannot inspect enrolled node", bob, "GET", `/api/nodes/${nodeId}`, 404);
  await setup(alice, "PUT", `/api/nodes/${nodeId}/views-enabled`, { on: true });
  const remoteWorking = path.join(scratch, "node-workspace");
  const remoteOutside = path.join(scratch, "node-outside");
  mkdirSync(remoteWorking);
  mkdirSync(remoteOutside);
  const remotePane = await setup(alice, "POST", "/api/subshells", {
    harnessId: "terminal",
    nodeId,
    workingDir: remoteWorking,
    name: "Live node fixture",
  });
  const remoteUpload = () =>
    alice.post(`/api/subshells/${remotePane.id}/uploads`, {
      multipart: { file: { name: "canary.txt", mimeType: "text/plain", buffer: Buffer.from("private canary") } },
    });
  const remoteState = path.join(remoteWorking, ".subshell");
  symlinkSync(remoteOutside, remoteState);
  const escapedUpload = await remoteUpload();
  check(
    "enrolled node refuses upload directory escape",
    escapedUpload.status() === 409 && readdirSync(remoteOutside).length === 0,
    escapedUpload.status(),
  );
  rmSync(remoteState);
  mkdirSync(remoteState);
  // Every remote upload seeds this fixed-name file through the real signed
  // write_file RPC, giving the planted .part attack a deterministic target.
  const part = path.join(remoteState, "..gitignore.part");
  for (const kind of ["symlink", "hardlink"] as const) {
    const victim = path.join(remoteOutside, `${kind}-canary`);
    writeFileSync(victim, "unchanged", { mode: 0o640 });
    if (kind === "symlink") symlinkSync(victim, part);
    else linkSync(victim, part);
    const response = await remoteUpload();
    check(
      `enrolled node leaves ${kind} temporary victim untouched`,
      response.status() === 200 &&
        readFileSync(victim, "utf8") === "unchanged" &&
        (statSync(victim).mode & 0o777) === 0o640 &&
        !existsSync(path.join(remoteState, ".gitignore")),
    );
    rmSync(part, { force: true });
  }
  const cleanRemoteUpload = await remoteUpload();
  check(
    "enrolled node writes normal upload and ignore file",
    cleanRemoteUpload.status() === 200 &&
      readFileSync((await cleanRemoteUpload.json()).path, "utf8") === "private canary" &&
      readFileSync(path.join(remoteState, ".gitignore"), "utf8") === "*\n",
  );
  const nodePreview = await setup(alice, "POST", `/api/subshells/${remotePane.id}/views/open`, openData);
  const nodeResponse = await anonymous.get(nodePreview.proxyBase);
  check(
    "encrypted node link preserves preview isolation",
    nodeResponse.status() === 200 &&
      !nodeResponse.headers()["x-accel-redirect"] &&
      nodeResponse.headers()["content-security-policy"]?.includes("sandbox") === true,
  );
  await setup(alice, "DELETE", `/api/subshells/${remotePane.id}`);
  await expectStatus("deleted node pane revokes preview capability", anonymous, "GET", nodePreview.proxyBase, 404);

  await setup(alice, "PUT", `/api/subshells/${pane.id}/shares`, {
    shares: [{ granteeUserId: guest.id, permission: "edit" }],
  });
  const disablePreview = await setup(bob, "POST", `/api/subshells/${pane.id}/views/open`, openData);
  await setup(admin, "PATCH", `/api/users/${guest.id}/disabled`, { disabled: true });
  await expectStatus("disabled account loses existing cookie access", bob, "GET", "/api/subshells", 401);
  await expectStatus("disable revokes issued preview capability", anonymous, "GET", disablePreview.proxyBase, 404);
  const cachedSession = await setup(bob, "GET", "/api/auth/get-session");
  check("auth cache cannot resurrect a disabled session", cachedSession === null || !cachedSession.session);
  await setup(alice, "DELETE", `/api/subshells/${pane.id}`);
  check("target remains healthy after all probes", (await anonymous.get("/api/setup/status")).ok());
} catch (error) {
  check("probe run completed", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const dispose of cleanup) {
    try {
      await dispose();
    } catch {
      check("fixture cleanup", false);
    }
  }
  writeFileSync(reportPath, JSON.stringify({ target: BASE_URL, at: new Date().toISOString(), checks }, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      total: checks.length,
      passed: checks.filter((c) => c.passed).length,
      failed: checks.filter((c) => !c.passed).length,
      report: reportPath,
    }),
  );
  if (checks.some((c) => !c.passed)) process.exitCode = 1;
}
