import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeConfig, saveConfig } from "../../config.js";
import { newHome } from "../../test-preload.js";
import { refuseRequest } from "../guards.js";
import { buildRoutes } from "../routes.js";
import { getDaemonState, registerRestart, setDaemonState } from "../state.js";

/**
 * The dashboard's routes against a throwaway enrolled config — the contract
 * the extracted `@internal/node-admin` cards fetch, pinned HERE because the
 * cards are green against both backends only while this shape holds.
 *
 * Every mutation arrives with the JSON content-type the guard demands — a
 * test that skipped it would silently be testing the refusal. The routes
 * themselves run their own `isSelf`; the guard composition lives in
 * `server.ts` and is pinned separately at the end.
 */

async function enrolled(): Promise<NodeConfig> {
  newHome();
  const cfg: NodeConfig = {
    serverUrl: "http://plane.invalid",
    nodeId: "node-abc",
    nodeKey: "nk_test",
    controlPublicKey: "{}",
    dataDir: mkdtempSync(join(tmpdir(), "subshell-dash-")),
    name: "testbed",
  };
  await saveConfig(cfg);
  return cfg;
}

/** The request helper: loopback Host, loopback Origin (browser-like), JSON mutations. */
async function call(cfg: NodeConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const app = buildRoutes(cfg);
  const hdrs: Record<string, string> = {
    host: "127.0.0.1:3090",
    origin: "http://127.0.0.1:3090",
  };
  if (method !== "GET") hdrs["content-type"] = "application/json";
  return await app.handle(
    new Request(`http://127.0.0.1:3090${path}`, {
      method,
      headers: hdrs,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

test("GET /api/self answers the bootstrap identity", async () => {
  const cfg = await enrolled();
  const r = await call(cfg, "GET", "/api/self");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ id: "node-abc", name: "testbed" });
});

test("a foreign :id is a 404 on every node route", async () => {
  const cfg = await enrolled();
  for (const path of ["/api/nodes/node-other", "/api/nodes/node-other/allowed-dirs"]) {
    const r = await call(cfg, "GET", path);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not found");
  }
});

test("GET /api/nodes/:id answers the local view — online, owner-managed, serverUrl present", async () => {
  const cfg = await enrolled();
  const v = await (await call(cfg, "GET", "/api/nodes/self")).json();
  expect(v.id).toBe("node-abc");
  expect(v.kind).toBe("agent");
  expect(v.status).toBe("online");
  expect(v.access).toBe("owner");
  expect(v.canManage).toBe(true);
  expect(v.canLaunch).toBe(true);
  expect(v.held).toBeNull();
  expect(v.harnesses).toEqual([]);
  expect(v.capabilities).toEqual(["uploads", "mcp"]);
  // The field the plane's view cannot always carry and this one always can.
  expect(v.serverUrl).toBe("http://plane.invalid");
  expect(v.runningSubshells).toBe(0);
});

test("the maintenance flip round-trips through the real mirror, and `off` carries stopped: []", async () => {
  const cfg = await enrolled();
  // `on` with no panes running is the clean case the CLI answers identically.
  const on = await call(cfg, "PUT", "/api/nodes/self/maintenance", { on: true });
  expect(on.status).toBe(200);
  const body = await on.json();
  expect(body.maintenance).toBe(true);
  expect(body.canLaunch).toBe(false);
  expect(body.stopped).toEqual([]);
  expect(body.failed).toBeUndefined(); // absence IS the clean case on both backends
  // The mirror file is the daemon's reconciliation contract — the route must
  // have written it through the real writer (and the real CLI path), not
  // faked the view.
  const file = JSON.parse(readFileSync(join(cfg.dataDir, "maintenance.json"), "utf8"));
  expect(file.on).toBe(true);
  expect(typeof file.changedAt).toBe("string");

  const off = await call(cfg, "PUT", "/api/nodes/self/maintenance", { on: false });
  const offBody = await off.json();
  expect(offBody.maintenance).toBe(false);
  expect(offBody.stopped).toEqual([]);
  expect(JSON.parse(readFileSync(join(cfg.dataDir, "maintenance.json"), "utf8")).on).toBe(false);
});

test("GET logs answers a slice, and a follow-up cursor reads empty", async () => {
  const cfg = await enrolled();
  const a = await (await call(cfg, "GET", "/api/nodes/self/logs?fromByte=0")).json();
  expect(typeof a.text).toBe("string");
  expect(typeof a.nextByte).toBe("number");
  const again = await call(cfg, "GET", `/api/nodes/self/logs?fromByte=${a.nextByte}`);
  expect((await again.json()).text).toBe("");
});

test("PATCH config repoints and says restartRequired; a bad URL is a 409 with the CLI's sentence", async () => {
  const cfg = await enrolled();
  const bad = await call(cfg, "PATCH", "/api/nodes/self/config", { serverUrl: "not a url" });
  expect(bad.status).toBe(409);
  expect((await bad.json()).error.length).toBeGreaterThan(0);

  const ok = await call(cfg, "PATCH", "/api/nodes/self/config", { serverUrl: "https://plane.example/" });
  expect(ok.status).toBe(200);
  const r = await ok.json();
  expect(r.serverUrl).toBe("https://plane.example");
  expect(r.restartRequired).toBe(true);
  // The identity survives the repoint — this is `configure`, not `enroll`.
  const saved = JSON.parse(readFileSync(join(process.env.SUBSHELL_CONFIG_HOME as string, "config.json"), "utf8"));
  expect(saved.nodeId).toBe("node-abc");
  expect(saved.serverUrl).toBe("https://plane.example");
});

test("PUT logging answers the setting echo; the env-forced case refuses 409", async () => {
  const cfg = await enrolled();
  const ok = await call(cfg, "PUT", "/api/nodes/self/logging", { debug: true });
  expect((await ok.json()).debug).toBe(true);
  const off = await call(cfg, "PUT", "/api/nodes/self/logging", { debug: false });
  expect((await off.json()).debug).toBe(false);

  // The environment-wins refusal answers 409 here because the local SET
  // throws (debug-logging.ts) — the plane's route answers the same fact
  // differently, and the cards tolerate both spellings.
  process.env.SUBSHELL_DEBUG_LOGGING = "1";
  try {
    const forced = await call(cfg, "PUT", "/api/nodes/self/logging", { debug: false });
    expect(forced.status).toBe(409);
    expect((await forced.json()).error).toContain("SUBSHELL_DEBUG_LOGGING");
  } finally {
    delete process.env.SUBSHELL_DEBUG_LOGGING;
  }
});

test("service verbs answer the plane's ServiceResult, and refusals are DATA (ok:false), not status", async () => {
  const cfg = await enrolled();
  // No daemon state ⇒ runtime null ⇒ the most specific refusal, verbatim
  // constant, in a 200 body — the plane's 409 mapping is the web's job and
  // the cards already do it.
  setDaemonState({ runtime: null });
  const r = await call(cfg, "POST", "/api/nodes/self/service", { verb: "restart" });
  expect(r.status).toBe(200);
  const b = await r.json();
  expect(b.ok).toBe(false);
  // The plane's contract for a refused verb is a SENTENCE the card prints,
  // not the wire constant — the dashboard owns its half of that mapping
  // (`serviceRefusal`), and "that node" reads wrong on the machine itself.
  expect(b.detail).toContain("not running under a service manager");
  expect(b.detail.startsWith("This ")).toBe(true);

  // A verb the schema does not know never reaches the executor: Elysia's own
  // validation answers it (a 4xx of its making, not a ServiceResult) before
  // any handler runs — which is a refusal no manager ever sees either. The
  // `NODE_SERVICE_VERBS` re-check in the handler is the belt for a verb added
  // to the protocol and not yet to this schema.
  const bogus = await call(cfg, "POST", "/api/nodes/self/service", { verb: "destroy" });
  expect(bogus.status).toBeGreaterThanOrEqual(400);
  expect(bogus.status).toBeLessThan(500);
});

test("POST update on an air-gapped host refuses by name before any download or refusal-race", async () => {
  const cfg = await enrolled();
  // Air-gapped by preload (SUBSHELL_RELEASE_URL=""), so resolution refuses
  // with the CLI's own sentence — the rule and the pointer, one string. The
  // daemon-state runtime says supervised, so the supervision gate passes
  // without a manager query and the release source is the first to answer.
  setDaemonState({ runtime: fakeRuntime(true, "keeps") });
  const r = await call(cfg, "POST", "/api/self/update", {});
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain("--from");
});

test("POST update refuses an unsupervised node before the release source is asked", async () => {
  const cfg = await enrolled();
  // The most specific truth comes first — the same ORDER `execUpdate` uses,
  // for the same reason: exiting would be a stop, and an air-gapped host's
  // download refusal is a worse first answer than "there is nothing to
  // restart into".
  setDaemonState({ runtime: fakeRuntime(false, "keeps") });
  const r = await call(cfg, "POST", "/api/self/update", {});
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain("service manager");
});

function fakeRuntime(supervised: boolean, paneSafety: "keeps" | "kills" | "unknown") {
  // The runtime report as the daemon would publish it — the two gates read
  // `supervised` and `service.paneSafety`, the rest is the protocol shape.
  return {
    startedAt: new Date().toISOString(),
    supervised,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/dev/null",
      state: "running",
      pid: process.pid,
      enabled: true,
      linger: null,
      paneSafety,
    },
    configPath: "/dev/null",
    logPath: null,
    logHint: null,
    agentLogPath: "/dev/null",
    logging: { debug: false, source: "default" as const },
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/usr/local/bin/subshell",
  } as never;
}

test("POST rollback with nothing to roll back to refuses honestly and never restarts", async () => {
  const cfg = await enrolled();
  let asked = 0;
  registerRestart(() => {
    asked += 1;
  });
  try {
    const rb = await call(cfg, "POST", "/api/self/update/rollback", {});
    expect(rb.status).toBe(409);
    expect((await rb.json()).error.length).toBeGreaterThan(0);
    expect(asked).toBe(0); // a refusal never restarts
  } finally {
    registerRestart(null);
  }
});

test("GET /api/self/update carries the version, protocol, and marker fields the Updates page reads", async () => {
  const cfg = await enrolled();
  const b = await (await call(cfg, "GET", "/api/self/update")).json();
  expect(typeof b.currentVersion).toBe("string");
  expect(typeof b.protocolVersion).toBe("number");
  expect(b.releaseConfigured).toBe(false); // preload: SUBSHELL_RELEASE_URL=""
  expect(b.pending).toBeNull();
  expect(b.lastFailure).toBeNull();
  expect(typeof b.debugLogging).toBe("boolean");
});

test("the guard travels WITH the routes instance", async () => {
  const cfg = await enrolled();
  const app = buildRoutes(cfg);
  const req = new Request("http://127.0.0.1:3090/api/self", {
    headers: { host: "evil.example.com" },
  });
  // Elysia lifecycle hooks are definition-ordered and do not cross an
  // instance boundary, so buildRoutes guards its OWN routes (the first
  // registration on the instance) and `server.ts`'s static fallback calls
  // `guardResponse` explicitly. The composed server (test below) refuses
  // every path; this pins the API half of that split.
  expect(
    refuseRequest({
      method: "GET",
      hostHeader: req.headers.get("host"),
      originHeader: null,
      contentType: null,
    })?.status,
  ).toBe(403);
  expect((await app.handle(req)).status).toBe(403);
});

test("the server-level guard refuses a foreign Host on EVERY path, SPA fallback included", async () => {
  // The first live smoke caught this exact bug: the guard in
  // `onBeforeHandle` did not fire on the catch-all route, so a rebinding
  // `Host:` got a 200 page. server.ts composes the two on the `request`
  // lifecycle; this pins that composition, which no per-route test can see.
  const cfg = await enrolled();
  const { startNodeDashboard } = await import("../server.js");
  const dash = await startNodeDashboard(cfg, { port: 0, hostname: "127.0.0.1" });
  // curl, not fetch: the Fetch spec forbids setting `Host`, and the whole
  // rebinding case IS a Host header — curl is the client that can send one.
  const status = async (path: string, host?: string): Promise<number> => {
    const argv = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}"];
    if (host !== undefined) argv.push("-H", `Host: ${host}`);
    argv.push(`http://127.0.0.1:${dash.port}${path}`);
    const child = Bun.spawn(argv);
    return Number(await new Response(child.stdout).text());
  };
  try {
    for (const path of ["/api/self", "/", "/some/spa/route"]) {
      expect([path, await status(path, "evil.example.com")]).toEqual([path, 403]);
    }
    // And the same requests with a loopback Host still work — the guard
    // refuses the NAME, not the port.
    expect(await status("/api/self")).toBe(200);
  } finally {
    dash.stop();
  }
});

test("GET /api/self/state reads the daemon bridge, and the bridge survives the daemon leaving", () => {
  registerRestart(null);
  setDaemonState({ connected: true, lastHeartbeatAt: "2026-09-19T00:00:00.000Z" });
  const s = getDaemonState();
  expect(s.connected).toBe(true);
  expect(s.lastHeartbeatAt).toBe("2026-09-19T00:00:00.000Z");
  setDaemonState({ connected: false });
  expect(getDaemonState().connected).toBe(false);
});
