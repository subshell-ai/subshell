import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateExecContext } from "../../commands/update.js";
import { type NodeConfig, saveConfig } from "../../config.js";
import { noteSweepScheduled } from "../../retention-settings.js";
import { newHome } from "../../test-preload.js";
import { NODE_VERSION } from "../../version.js";
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
async function call(
  cfg: NodeConfig,
  method: string,
  path: string,
  body?: unknown,
  // The seam list IS `buildRoutes`'s own parameter — restating it here only
  // drifts, and the arrow literals below are contextually typed from it.
  opts: NonNullable<Parameters<typeof buildRoutes>[1]> = {},
): Promise<Response> {
  const app = buildRoutes(cfg, opts);
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

test("service refusals answer 409 with the plane's sentence — the shape the card treats as failure", async () => {
  const cfg = await enrolled();
  // No daemon state ⇒ runtime null ⇒ the most specific refusal. It MUST be a
  // non-2xx: `useNodeService` resolves on any 2xx and `NodeServiceCard.run()`
  // prints `res.detail` as a *success* line, reaching its red-failure branch
  // only when the fetch rejects — which is exactly how the plane's 409 refusal
  // surfaces. A 200-with-ok:false would render "no service manager" as if the
  // verb had worked.
  setDaemonState({ runtime: null });
  const r = await call(cfg, "POST", "/api/nodes/self/service", { verb: "restart" });
  expect(r.status).toBe(409);
  const b = await r.json();
  // `message` is the key `lib/api.ts` reads; `error` is this surface's own key.
  // Both carry the sentence the dashboard mapped (`serviceRefusal`), and
  // "that node" reads wrong on the machine itself.
  expect(b.message).toContain("not running under a service manager");
  expect(b.error).toBe(b.message);
  expect(b.message.startsWith("This ")).toBe(true);

  // A verb the schema does not know never reaches the executor: Elysia's own
  // validation answers it (a 4xx of its making, not a ServiceResult) before
  // any handler runs — which is a refusal no manager ever sees either. The
  // `NODE_SERVICE_VERBS` re-check in the handler is the belt for a verb added
  // to the protocol and not yet to this schema.
  const bogus = await call(cfg, "POST", "/api/nodes/self/service", { verb: "destroy" });
  expect(bogus.status).toBeGreaterThanOrEqual(400);
  expect(bogus.status).toBeLessThan(500);
});

test("a standalone service refusal's wording reads the resolved runtime, not the absent daemon state", async () => {
  // The route decided from `liveRuntime()` (no daemon state — the standalone
  // dashboard), and its refusal used to pick wording from
  // `getDaemonState().runtime`, which is exactly the null the route had just
  // fallen back past. So a machine whose fresh read said `unknown` ("no
  // answer") got the CERTAIN sentence ("would close every subshell") — the
  // false certainty the plane's own wording rule refuses. The resolved
  // paneSafety must ride to the sentence, the way the update route already
  // threads `proof?.paneSafety`.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  try {
    const r = await call(
      cfg,
      "POST",
      "/api/nodes/self/service",
      { verb: "stop" },
      {
        liveRuntime: async () => fakeRuntime(true, "unknown"),
      },
    );
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.message).toBe(
      "This node's service definition could not be read, so whether this keeps its running subshells is unknown; act anyway with force, or repair the definition on this machine",
    );
    expect(b.message).not.toContain("would close every subshell");
  } finally {
    setDaemonState({ runtime: null });
  }
});

test("a standalone service refusal with a resolved `kills` still says so", async () => {
  // The mirror case: the manager ANSWERED "kills" and the sentence must be
  // the certain one — the threading must not collapse both answers into the
  // hedge, exactly as the update path's kills-wording test pins.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  try {
    const r = await call(
      cfg,
      "POST",
      "/api/nodes/self/service",
      { verb: "stop" },
      {
        liveRuntime: async () => fakeRuntime(true, "kills"),
      },
    );
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.message).toContain("would close every subshell");
    expect(b.message).not.toContain("could not be read");
  } finally {
    setDaemonState({ runtime: null });
  }
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

test("POST update refuses 'already at' and a downgrade-without-force before the installer runs", async () => {
  // The version checks the CLI `update` verb applies but `execUpdate`/`applyUpdate`
  // do NOT. Without them "Update to latest" would re-swap the SAME version or
  // silently DOWNGRADE (a transient mid-publish window), and the card's Force
  // checkbox would gate a refusal that never fires. `resolveRelease` is injected
  // so a chosen version reaches these checks deterministically, with no network.
  const cfg = await enrolled();
  setDaemonState({ runtime: fakeRuntime(true, "keeps") });
  const resolveRelease = async (to?: string) => ({
    version: to ?? NODE_VERSION,
    url: "https://example.invalid/x",
    sha256: "deadbeef",
    manifest: { bytes: Buffer.from("manifest"), sig: "sig" },
  });
  const opts = { resolveRelease };
  try {
    const same = await call(cfg, "POST", "/api/self/update", {}, opts);
    expect(same.status).toBe(409);
    expect((await same.json()).message).toContain("already at");

    const older = await call(cfg, "POST", "/api/self/update", { to: "0.0.1" }, opts);
    expect(older.status).toBe(409);
    expect((await older.json()).message).toContain("older than");
    // (Force=true is not exercised: it clears BOTH version checks and falls
    // through to `execUpdate`, which would run the real installer against the
    // fake URL. The two refusal paths above return before the installer.)
  } finally {
    setDaemonState({ runtime: null });
  }
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

test("POST update threads the boot-window supervision proof INTO the executor (finding 5)", async () => {
  // The mismatch this pins: the frozen runtime report is null (boot window, or
  // a failed boot-time read), the route re-proves supervision with a live
  // manager query, and `execUpdate` used to re-read the same null and 409 the
  // supervised node the page had just proved supervised — two sources, one
  // request. The route's proof must BE the executor's answer. `execUpdate` is
  // a capturing seam because the real one would run the ladder and the network
  // on the test process; what is under test is the threading, not the install.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  let seen: UpdateExecContext | undefined;
  const r = await call(
    cfg,
    "POST",
    "/api/self/update",
    {},
    {
      proveSupervision: async () => ({ supervised: true, paneSafety: "keeps" as const }),
      resolveRelease: async () => ({
        version: "99.0.0",
        url: "https://example.invalid/agent",
        sha256: "0".repeat(64),
        manifest: { bytes: Buffer.from("manifest"), sig: "sig" },
      }),
      execUpdate: async (ctx: UpdateExecContext) => {
        seen = ctx;
        return { ok: true };
      },
    },
  );
  expect(r.status).toBe(200);
  expect((await r.json()).version).toBe("99.0.0");
  expect(seen).toBeDefined();
  expect(seen?.runtime).toBeNull(); // the frozen report stayed the null the proof answers for
  expect(seen?.supervisedProof).toEqual({ supervised: true, paneSafety: "keeps" });
  setDaemonState({ runtime: null });
});

test("POST update with a null report refuses when the live manager does not confirm supervision", async () => {
  // The other half of the same window: a proof that CANNOT confirm is still
  // the refusal, in the page's existing sentence, and nothing downstream runs.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  let executorRan = 0;
  const r = await call(
    cfg,
    "POST",
    "/api/self/update",
    {},
    {
      proveSupervision: async () => ({ supervised: false }),
      resolveRelease: async () => {
        throw new Error("must not be reached");
      },
      execUpdate: async () => {
        executorRan += 1;
        return { ok: true };
      },
    },
  );
  expect(r.status).toBe(409);
  const b = await r.json();
  expect(b.error).toContain("not running under a service manager");
  expect(b.message).toContain("update it with `subshell update`");
  expect(executorRan).toBe(0);
});

test("POST update with a null report refuses on the proof's pane safety, with the kills wording", async () => {
  // Supervised but the definition kills: the proof carries that answer too,
  // `execUpdate` (REAL here — it refuses before any download) must refuse, and
  // the sentence must say "would close every subshell", not "could not be
  // read" — the manager answered, and false hedging is as wrong as false
  // certainty.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  try {
    const r = await call(
      cfg,
      "POST",
      "/api/self/update",
      {},
      {
        proveSupervision: async () => ({ supervised: true, paneSafety: "kills" as const }),
        resolveRelease: async () => ({
          version: "99.0.0",
          url: "https://example.invalid/agent",
          sha256: "0".repeat(64),
          manifest: { bytes: Buffer.from("manifest"), sig: "sig" },
        }),
      },
    );
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.message).toContain("would close every subshell");
    expect(b.message).not.toContain("could not be read");
  } finally {
    setDaemonState({ runtime: null });
  }
});

test("a service refusal where NOTHING answered reads as unknown, not as kills", async () => {
  // The third state, and the one the two above cannot see: no daemon AND no
  // fresh report (a standalone dashboard whose manager query resolves null).
  // The executor still fail-closes the destructive verb with KILLS_PANES —
  // that's its rule about unreadable definitions — but the SENTENCE must not
  // upgrade "nobody read anything" into "every subshell will die". Finding
  // (iter 5): the old wording branch asserted whenever paneSafety was not
  // exactly `unknown`, and `undefined` is a different absence of an answer.
  const cfg = await enrolled();
  setDaemonState({ runtime: null });
  try {
    const r = await call(
      cfg,
      "POST",
      "/api/nodes/self/service",
      { verb: "stop" },
      {
        liveRuntime: async () => null,
      },
    );
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.message).toBe(
      "This node's service definition could not be read, so whether this keeps its running subshells is unknown; act anyway with force, or repair the definition on this machine",
    );
    expect(b.message).not.toContain("would close every subshell");
  } finally {
    setDaemonState({ runtime: null });
  }
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

test("POST rollback swaps always but EXITS only when supervised — never stops a foreground daemon", async () => {
  // The restart gate's own coverage. The binary swap is harmless (the running
  // process keeps its in-memory version until it next boots), but EXITING is
  // only a restart when a manager would bring the process back. A hand-run
  // `subshell run` has no such manager, so a rollback there that exited would
  // take the node — and its own page — down for good. `rollback` is injected so
  // the swap is a no-op stub and the gate is what's under test.
  const cfg = await enrolled();
  const rollback = async () => ({ binary: "/tmp/subshell-under-test", to: "1.8.0" });
  let asked = 0;
  registerRestart(() => {
    asked += 1;
  });
  try {
    setDaemonState({ runtime: fakeRuntime(false, "keeps") });
    const rb = await call(cfg, "POST", "/api/self/update/rollback", {}, { rollback });
    expect(rb.status).toBe(200);
    const b = await rb.json();
    expect(b.ok).toBe(true);
    expect(b.to).toBe("1.8.0");
    expect(b.restarted).toBe(false);
    expect(asked).toBe(0); // unsupervised: the swap ran, the exit did not

    setDaemonState({ runtime: fakeRuntime(true, "keeps") });
    const rb2 = await call(cfg, "POST", "/api/self/update/rollback", {}, { rollback });
    expect((await rb2.json()).restarted).toBe(true);
    expect(asked).toBe(1); // supervised: exiting IS the restart
  } finally {
    registerRestart(null);
    setDaemonState({ runtime: null });
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

test("log-retention: GET answers the layer truth, PUT persists to config.json", async () => {
  const cfg = await enrolled();
  noteSweepScheduled(false); // this suite runs with no daemon: the honest answer is "not scheduled"
  const fresh = await (await call(cfg, "GET", "/api/self/log-retention")).json();
  expect(fresh.days).toEqual({ value: 1, source: "default", forced: false });
  expect(fresh.hours).toEqual({ value: 0, source: "default", forced: false });
  expect(fresh.forever).toBe(false);
  expect(fresh.scheduled).toBe(false); // the boot-shape fact travels beside the window (finding 5)

  const written = await call(cfg, "PUT", "/api/self/log-retention", { days: 7, hours: 3 });
  expect(written.status).toBe(200);
  const state = await written.json();
  expect(state.days).toEqual({ value: 7, source: "stored", forced: false });
  expect(state.hours).toEqual({ value: 3, source: "stored", forced: false });
  expect(state.scheduled).toBe(false); // the write echoes the same process fact
  // The write landed in the machine's own file, identity and everything else
  // round-tripped — the same discipline every saveConfig write owes.
  const saved = JSON.parse(readFileSync(join(process.env.SUBSHELL_CONFIG_HOME as string, "config.json"), "utf8"));
  expect(saved.logRetentionDays).toBe(7);
  expect(saved.logRetentionHours).toBe(3);
  expect(saved.nodeId).toBe("node-abc");
  const reread = await (await call(cfg, "GET", "/api/self/log-retention")).json();
  expect(reread.days.value).toBe(7);
});

test("log-retention: the env forces the field it names, per field", async () => {
  const cfg = await enrolled();
  process.env.SUBSHELL_LOG_RETENTION_DAYS = "3";
  try {
    const view = await (await call(cfg, "GET", "/api/self/log-retention")).json();
    expect(view.days).toEqual({ value: 3, source: "env", forced: true });

    // The forced field refuses, by name, 409 — the debug-logging rule.
    const refused = await call(cfg, "PUT", "/api/self/log-retention", { days: 9 });
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toContain("SUBSHELL_LOG_RETENTION_DAYS");
    // The un-forced half of the same window stays the machine's to set.
    const hours = await call(cfg, "PUT", "/api/self/log-retention", { hours: 6 });
    expect(hours.status).toBe(200);
    expect((await hours.json()).hours).toEqual({ value: 6, source: "stored", forced: false });
    // A combined write naming the forced field stores NOTHING either half.
    const both = await call(cfg, "PUT", "/api/self/log-retention", { days: 1, hours: 2 });
    expect(both.status).toBe(409);
    expect(
      JSON.parse(readFileSync(join(process.env.SUBSHELL_CONFIG_HOME as string, "config.json"), "utf8"))
        .logRetentionHours,
    ).toBe(6);
  } finally {
    delete process.env.SUBSHELL_LOG_RETENTION_DAYS;
  }
});

test("log-retention: values retentionField would junk are refused, 0 is real", async () => {
  const cfg = await enrolled();
  for (const bad of [-1, 1.5, "seven"]) {
    const r = await call(cfg, "PUT", "/api/self/log-retention", { days: bad });
    expect([bad, r.status]).toEqual([bad, 400]);
  }
  const empty = await call(cfg, "PUT", "/api/self/log-retention", {});
  expect(empty.status).toBe(400);

  // 0 + 0 is the documented keep-forever pair, not junk.
  const forever = await call(cfg, "PUT", "/api/self/log-retention", { days: 0, hours: 0 });
  expect(forever.status).toBe(200);
  const foreverState = await forever.json();
  expect(foreverState.forever).toBe(true);
  expect(foreverState.scheduled).toBe(false);
});

test("log-retention: a daemon that armed its sweep says so on both verbs (finding 5)", async () => {
  // The boot shape the card's copy must be able to tell apart: a node that
  // booted FINITE armed the hourly timer, so every later save (including a
  // move away from keep-forever) lands on the next pass. Only the daemon's
  // boot resolution knows this, and it states it through
  // `noteSweepScheduled` — the file cannot answer it, which is the defect the
  // card's old forever-derived sentence asserted wrongly for that daemon.
  const cfg = await enrolled();
  noteSweepScheduled(true);
  try {
    const get = await (await call(cfg, "GET", "/api/self/log-retention")).json();
    expect(get).toMatchObject({ scheduled: true, forever: false });
    const put = await (await call(cfg, "PUT", "/api/self/log-retention", { days: 0, hours: 0 })).json();
    expect(put).toMatchObject({ scheduled: true, forever: true });
  } finally {
    noteSweepScheduled(false); // the memo must not leak into the next case
  }
  const after = await (await call(cfg, "GET", "/api/self/log-retention")).json();
  expect(after.scheduled).toBe(false);
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
