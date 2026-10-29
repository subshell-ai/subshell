import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";
import { type RunningNode, startNode } from "../stub/client";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Pane preview at the API level (spec 2026-10-21 §6, Task 14 Step 1): a REAL
 * enrolled node, exercising the remote encrypted transport rather than the
 * built-in runtime; a terminal pane whose `bun -e` script is both the
 * dev server and the fake CDP endpoint, and the whole proxy round trip
 * through `/pv/<ref>/` (body bytes and the cookie jar's browser isolation) over
 * REST + the lane. No browser page is involved: this spec is the `request`
 * fixture end to end.
 *
 * What this file deliberately does NOT assert, so the next reader does not
 * hunt for a missing assertion: screencast FRAME delivery through `/ws/live`.
 * The e2e backend is a child process (`stack.ts` spawns it), so there is no
 * in-proc seam to inject a fake stream, and no task creates one. Frames are
 * owned by Task 11's unit matrix (the §11.14 authorization control) and the
 * real JPEGs by the plan's Step 2 container leg with a real chromium. What IS
 * proven here is the whole subscription round trip REST + live can prove:
 * watch POST 200 over a real CDP handshake against the pane's fake devtools
 * port, the broker's `node.preview_watch.open` audit row, and an idempotent
 * DELETE.
 *
 * Async helpers only. The suite learned the hard way (spec 2026-10-21 §10 /
 * the ASYNC SPAWN RULE) that a sync `spawnSync`/`execSync` inside a worker
 * starves the loop the stack's servers need; the tmux sweep below spawns
 * async and awaits close for the same reason. Node/subshell names carry
 * `test.info().retry` and the teardown is spec 12's no-leaves `finally`.
 */

/** The dev server the pane starts, and the port we proxy it through (brief-pinned). */
const HTTP_PORT = PORTS.previewHttp;
/**
 * The pane's fake devtools port. Not 9222: that is where a developer's REAL
 * chromium answers on this machine, and a stray 9222 listener would let the
 * scan detect a CDP port the pane does not own.
 */
const CDP_PORT = PORTS.previewCdp;

/** Pure helpers, so the waits can tighten independently of the 120 s default. */
const SPAWN_TIMEOUT = 30_000;
/** Ports discovery is one /proc pass per ask behind a 5 s plane cache; 90 s is generous. */
const PORTS_DEADLINE_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The pane's one command, typed verbatim through `POST /:id/exec`. Two
 * loopback `Bun.serve`s: the HTTP server (body `ok`, `text/html` so discovery
 * lists it at all, plus a `set-cookie` so browser cookie isolation is
 * observable on the proxied response) and the CDP fake
 * the watch bridge can actually shake hands with: `/json/version` answers
 * the `Browser` field that makes the ports scan call it CDP, `/json/list`
 * carries a `page` target whose `webSocketDebuggerUrl` is loopback, and the
 * websocket handler accepts the upgrade and lets the bridge's `Page.enable`
 * + `Page.startScreencast` land unanswered (the bridge resolves on the
 * socket reaching open; it never waits for a reply).
 *
 * Shell-posture notes: the script carries ONLY double quotes (the -e
 * argument is single-quoted, and `!` would history-expand even inside single
 * quotes, so it appears nowhere), and the trailing `&` keeps the pane at its
 * prompt: the servers run as the shell's background job, still under the
 * pane's shell and therefore inside the pane's process tree, which is
 * exactly what the node's /proc walk scans.
 */
const PANE_SCRIPT =
  `const ver={"Browser":"E2E preview CDP/0.0","Protocol-Version":"1.3","User-Agent":"e2e",` +
  `"webSocketDebuggerUrl":"ws://127.0.0.1:${CDP_PORT}/devtools/browser/e2ebrowser"};` +
  `const target={"description":"","id":"e2epage","title":"E2E preview page","type":"page",` +
  `"url":"http://127.0.0.1:${HTTP_PORT}/","webSocketDebuggerUrl":"ws://127.0.0.1:${CDP_PORT}/devtools/page/e2epage"};` +
  `Bun.serve({hostname:"127.0.0.1",port:${CDP_PORT},reuseAddress:true,fetch(req,server){` +
  `const u=new URL(req.url).pathname;if(u==="/json/version"){return Response.json(ver)}` +
  `if(u.startsWith("/json")){return Response.json([target])}` +
  `if(u.startsWith("/devtools/")){if(server.upgrade(req,{data:0})){return}` +
  `return new Response("upgrade refused",{status:426})}return new Response("nope",{status:404})},` +
  `websocket:{open(){},message(){},close(){}},error(){return new Response("nope",{status:400})}});` +
  `Bun.serve({hostname:"127.0.0.1",port:${HTTP_PORT},reuseAddress:true,fetch(){` +
  `return new Response("ok",{headers:{"set-cookie":"t=1","content-type":"text/html"}})}});`;

/** Registry row fragment (GET /api/nodes). */
interface NodeRow {
  id: string;
  name: string;
  status: "online" | "offline";
  harnesses: { harnessId: string; installed: boolean }[];
  inventoryStale: boolean;
}

/** `GET /:id/views` response (views-info.route.ts). */
interface PreviewInfoBody {
  ports: { proto: "tcp" | "tcp6"; port: number; pid: number }[];
  cdpPort: number | null;
  screen: { display: string; viewer: { protocol: "vnc"; port: number } } | null;
  screenLost?: string;
  nodeEnabled: boolean;
  reason?: string;
}

/** One audit row from `GET /api/audit` (decoded metadata). */
interface AuditRow {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
}

/** Polls `check` to truth or throws `label` + the agent log tail. API-only checks: tight tick. */
async function pollUntil(
  label: string,
  agent: RunningNode | undefined,
  check: () => Promise<boolean>,
  tickMs = 500,
  deadlineMs = SPAWN_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}\n--- agent log tail ---\n${agent?.logTail() ?? "(agent never started)"}`);
    }
    await sleep(tickMs);
  }
}

/** Async tmux probe: exit code, -1 on spawn failure. NEVER spawnSync here (the starvation rule). */
function tmuxAsync(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("tmux", args, { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** Socket paths of every tmux server the agent daemonised under `tmuxBase`. */
function socketsUnder(tmuxBase: string): string[] {
  const uidDir = path.join(tmuxBase, `tmux-${process.getuid?.() ?? 0}`);
  try {
    return readdirSync(uidDir).map((s) => path.join(uidDir, s));
  } catch {
    return [];
  }
}

/** Best-effort: kill every tmux server under `tmuxBase`, awaited (async only). */
async function sweepTmuxServers(tmuxBase: string): Promise<void> {
  for (const sock of socketsUnder(tmuxBase)) {
    await tmuxAsync(["-S", sock, "kill-server"]);
  }
}

test("preview: real node + terminal pane serve the proxy round trip and the watch REST pair", async ({ request }) => {
  test.setTimeout(240_000);

  const nonce = test.info().retry;
  const nodeName = `e2e-preview-node-${nonce}`;
  const paneName = `e2e-preview-pane-${nonce}`;

  const home = mkdtempSync(path.join(tmpdir(), "subshell-e2e-preview-"));
  const dataDir = path.join(home, "data");
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true }); // tmux will not mkdir the TMUX_TMPDIR base itself (stack.ts)
  let agent: RunningNode | undefined;
  let nodeId: string | undefined;
  let paneId: string | undefined;
  let setupKeyId: string | undefined;

  try {
    // ── 1. A real node. `local` has no agent socket, so every preview RPC
    // against a local pane answers `offline` by design; the whole surface
    // under test lives on enrolled machines only. (Spec 12's enrollment
    // pattern: mint via REST, `subshell` from source, poll the registry.)
    const mint = await request.post("/api/nodes/setup-keys");
    expect(mint.ok(), await mint.text()).toBe(true);
    const setup = (await mint.json()) as { id: string; key: string };
    setupKeyId = setup.id;
    expect(setup.key).toMatch(/^nsk_/);

    agent = await startNode({ home, dataDir, tmuxBase, setupKey: setup.key, name: nodeName });
    await pollUntil(`node "${nodeName}" never came online`, agent, async () => {
      const res = await request.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.name === nodeName);
      if (row) nodeId = row.id;
      return row?.status === "online";
    });
    if (!nodeId) throw new Error("node row never appeared");

    // Detection on demand (spec 2026-09-10 §4): the terminal harness must read
    // installed here (the node's own bash answers its detect), or the launch
    // gate below refuses a stale/absent snapshot.
    const recheck = await request.post(`/api/nodes/${nodeId}/recheck`);
    expect(recheck.ok(), await recheck.text()).toBe(true);
    await pollUntil("the re-check never produced a fresh snapshot with terminal installed", agent, async () => {
      const res = await request.get("/api/nodes");
      if (!res.ok()) return false;
      const fresh = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
      return (
        fresh !== undefined &&
        !fresh.inventoryStale &&
        fresh.harnesses.some((h) => h.harnessId === "terminal" && h.installed)
      );
    });

    // ── 2. The switch (spec §2): preview is fail-closed OFF per node, and
    // `PUT /:id/views-enabled {on}` is the one act that arms it. The node
    // holds the mirror; the plane gate is what the info route reads.
    const arm = await request.put(`/api/nodes/${nodeId}/views-enabled`, { data: { on: true } });
    expect(arm.ok(), await arm.text()).toBe(true);

    // ── 3. The pane. A terminal harness so REST exec can type the servers
    // into its shell, on THIS node, in a real dir (the launch asks the node).
    const workingDir = mkdtempSync(path.join(home, "cwd"));
    const created = await request.post("/api/subshells", {
      data: { harnessId: "terminal", workingDir, nodeId, name: paneName },
    });
    expect(created.ok(), await created.text()).toBe(true);
    paneId = ((await created.json()) as { id: string }).id;
    await pollUntil(`pane "${paneName}" never reported alive`, agent, async () => {
      const res = await request.get(`/api/subshells/${paneId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as { status: string; alive: boolean }).alive === true;
    });

    // ── 4. Type the servers into the pane over the REST input seam (the
    // edit act, and a plain "the bytes were sent" success, no receipt
    // claimed). INPUT rather than exec on purpose: this box's interactive
    // bash carries a line editor that redraws BEFORE the exec sentinel line
    // (`[ble: EOF]` rides the line), so exec's anchored scan answers
    // timed_out even when the command ran and the rc printed; observed on
    // this spec's first run, sentinel bytes in the output, status timed_out.
    // The sentinel protocol's line-shape problem belongs to pane-exec, not
    // here; what proves this step is section 5's ports poll, the receipt
    // that matters. The backgrounded `&` keeps the pane at its prompt.
    await sleep(1_500); // let bash draw its prompt (the row already said alive)
    const typeServers = async (): Promise<void> => {
      const res = await request.post(`/api/subshells/${paneId}/input`, {
        data: { text: `bun -e '${PANE_SCRIPT}' &`, submit: true },
      });
      expect(res.ok(), await res.text()).toBe(true);
    };
    await typeServers();

    // ── 5. Discovery. One /proc pass per ask behind the plane's 5 s cache,
    // so the poll is throttle-respecting at a comfortable interval. The two
    // fakes show up on different fields now: the website is a `ports` row
    // (only a port the document probe accepts is listed), and devtools is the
    // `cdpPort` the watch fallback depends on, never a row of its own. A typed line that the
    // shell never read (bash still mid-rc when the bytes landed) gets ONE
    // retype at the halfway mark; the deadline is unchanged.
    const typedAt = Date.now();
    let retyped = false;
    let info: PreviewInfoBody | undefined;
    await pollUntil(
      "the pane's servers never showed up in the ports scan",
      agent,
      async () => {
        const res = await request.get(`/api/subshells/${paneId}/views`);
        if (!res.ok()) return false;
        info = (await res.json()) as PreviewInfoBody;
        const found =
          info.nodeEnabled === true &&
          info.ports.some((p) => p.port === HTTP_PORT) &&
          !info.ports.some((p) => p.port === CDP_PORT) &&
          info.cdpPort === CDP_PORT;
        if (!found && !retyped && Date.now() - typedAt > PORTS_DEADLINE_MS / 2) {
          retyped = true;
          await typeServers();
        }
        return found;
      },
      1_500,
      PORTS_DEADLINE_MS,
    );
    // The screen half of the shape: this pane has no display, and the answer
    // is a null, not a guess (and not `screenLost`: nothing died).
    expect(info?.screen).toBeNull();
    expect(info?.screenLost).toBeUndefined();

    // ── 6. Open a forward lane and fetch through the plane.
    const opened = await request.post(`/api/subshells/${paneId}/views/open`, { data: { port: HTTP_PORT } });
    expect(opened.ok(), await opened.text()).toBe(true);
    const { proxyBase } = (await opened.json()) as { proxyBase: string };
    expect(proxyBase).toMatch(/^\/pv\/[0-9a-f]{32}\/$/);

    const proxied = await request.get(proxyBase);
    expect(proxied.ok(), await proxied.text()).toBe(true);
    // The pane's server answers `text/html` (that is what makes discovery list
    // it), so the proxy returns the app's own bytes WITH the compat shim every
    // document gets: the tagless body keeps its shape at the tail, and the
    // shim's presence is the proof the rewrite ran on this lane.
    const proxiedBody = await proxied.text();
    expect(proxiedBody.endsWith("ok")).toBe(true);
    expect(proxiedBody).toContain("installPreviewCompat");
    // Upstream cookies stay in the server-side session jar. A preview must
    // never write into the dashboard browser's cookie store.
    expect(proxied.headers()["set-cookie"]).toBeUndefined();
    expect(proxied.headers()["content-security-policy"]).toContain("sandbox");

    // A saved destination crosses the signed node command without requiring a display.
    const saved = await request.post(`/api/subshells/${paneId}/services`, {
      data: { host: "127.0.0.1", port: HTTP_PORT, protocol: "http" },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const serviceId = (await saved.json()).id;
    const manual = await request.post(`/api/subshells/${paneId}/views/open`, { data: { serviceId } });
    expect(manual.ok(), await manual.text()).toBe(true);
    const manualPath = (await manual.json()).proxyBase;
    expect(await request.get(manualPath).then((response) => response.text())).toMatch(/ok$/);
    expect((await request.delete(`/api/subshells/${paneId}/services/${serviceId}`)).ok()).toBe(true);
    expect((await request.get(manualPath)).status()).toBe(404);

    // The session's audit pair lands with the lane, and the row says which
    // kind without ever naming the ref (refs never ride audit metadata).
    await pollUntil("the forward session never audited its open", agent, async () => {
      const res = await request.get("/api/audit?limit=100");
      if (!res.ok()) return false;
      return ((await res.json()) as AuditRow[]).some(
        (r) =>
          r.action === "node.preview_forward.open" &&
          r.metadata?.paneId === paneId &&
          r.metadata?.port === HTTP_PORT &&
          r.metadata?.kind === "forward",
      );
    });

    // ── 7. The watch REST pair. No port in the body: the route must fall
    // back to the cached cdpPort, and the node-side bridge must complete a
    // real CDP handshake against the pane's fake devtools port before the
    // 200 answers.
    const watching = await request.post(`/api/subshells/${paneId}/views/browser/watch`, { data: {} });
    expect(watching.ok(), await watching.text()).toBe(true);
    expect((await watching.json()) as { ok: boolean }).toEqual({ ok: true });

    await pollUntil("the watch bridge never audited its open", agent, async () => {
      const res = await request.get("/api/audit?limit=100");
      if (!res.ok()) return false;
      return ((await res.json()) as AuditRow[]).some(
        (r) =>
          r.action === "node.preview_watch.open" &&
          r.metadata?.paneId === paneId &&
          r.metadata?.port === CDP_PORT &&
          r.metadata?.kind === "screencast",
      );
    });

    // Stop is pane-keyed and idempotent: the first DELETE closes the bridge
    // (audited once, with its reason); the second changes nothing and still
    // answers ok. Frame delivery through `/ws/live` is deliberately NOT
    // asserted here: see the file header for who owns that half.
    const stopped = await request.delete(`/api/subshells/${paneId}/views/browser/watch`);
    expect(stopped.ok(), await stopped.text()).toBe(true);
    const stoppedAgain = await request.delete(`/api/subshells/${paneId}/views/browser/watch`);
    expect(stoppedAgain.ok(), await stoppedAgain.text()).toBe(true);

    await pollUntil("the watch bridge never audited its close", agent, async () => {
      const res = await request.get("/api/audit?limit=100");
      if (!res.ok()) return false;
      return ((await res.json()) as AuditRow[]).some(
        (r) =>
          r.action === "node.preview_watch.close" &&
          r.metadata?.paneId === paneId &&
          r.metadata?.reason === "viewer-left",
      );
    });
  } finally {
    const leaks: string[] = [];
    // Spec 12's order: the pane first while the daemon can still take the
    // terminate RPC (its forward session closes on the reported exit), the
    // daemon second, the rows only this API can remove last.
    if (paneId) {
      try {
        const gone = await request.delete(`/api/subshells/${paneId}`);
        if (!gone.ok() && gone.status() !== 404) leaks.push(`pane delete: HTTP ${gone.status()}`);
      } catch (err) {
        leaks.push(`pane delete: ${String(err)}`);
      }
    }
    try {
      await agent?.stop();
    } catch (err) {
      leaks.push(`agent stop: ${String(err)}`);
    }
    await sweepTmuxServers(tmuxBase);
    if (nodeId) {
      // The registry's offline flip rides the socket close: retry the delete
      // through a stale-409 window rather than racing it.
      for (let i = 0; i < 10; i++) {
        try {
          const del = await request.delete(`/api/nodes/${nodeId}?force=true`);
          if (del.ok() || del.status() === 404) break;
          if (i === 9) leaks.push(`node delete: HTTP ${del.status()} ${(await del.text()).slice(0, 200)}`);
        } catch (err) {
          leaks.push(`node delete: ${String(err)}`);
          break;
        }
        await sleep(500);
      }
    }
    if (setupKeyId) {
      try {
        const rev = await request.delete(`/api/nodes/setup-keys/${setupKeyId}`);
        if (!rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
      } catch (err) {
        leaks.push(`setup-key revoke: ${String(err)}`);
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(tmuxBase), { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[47-preview] cleanup problems: ${leaks.join("; ")}`);
  }
});
