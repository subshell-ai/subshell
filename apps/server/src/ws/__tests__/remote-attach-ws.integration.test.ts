import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { tmuxSocketFor } from "@internal/harnesses";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { getDefaultLocalLauncher } from "@/services/nodes/local-launcher.js";

const defaultLocalLauncher = getDefaultLocalLauncher();

import { dispatchOutput, resetNodeEventsForTests } from "@/services/nodes/node-events.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { attachScriptedNode, ok, probeAllAlive, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { cleanupSubshellWs, handleSubshellMessage, handleSubshellWs, type WsSocket } from "@/ws/subshell-ws.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * Task 14 (sibling of `subshells-remote.integration.test.ts`) — the live-attach
 * relay through the REAL dispatch entry: `handleSubshellWs` consumes a real
 * single-use WS token, loads the row from the shared temp DB, routes it by
 * `nodeId` to `attachRemoteSubshellWs`, and the relay speaks to a scripted node
 * over the REAL registry + signed-RPC loop (Task 11's fixtures, now proving
 * the wiring ABOVE the relay — which unit suites bypassed by calling the relay
 * directly). Also lands the T11 carry: double-cleanup teardown is idempotent
 * on BOTH attach paths.
 */

const NODE_ID = "node-it-ws-1";
const LOG = "ab\ncd\n"; // 7 bytes — small enough that the whole window replays

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Poll `cond` until true (signing/RPC settle on real async paths). */
async function until(cond: () => boolean, what = "condition", budgetMs = 4000): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    if (cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Give a late second send a bounded chance to land (then it never should). */
async function sawWithin(cond: () => boolean, budgetMs: number): Promise<boolean> {
  return await until(cond, "late second send", budgetMs).then(
    () => true,
    () => false,
  );
}

interface FakeBrowser {
  ws: WsSocket;
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

/** A fake browser socket; `ws.data` separate, exactly as Elysia's is. */
function fakeBrowser(): FakeBrowser {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {},
    send: (d: string) => {
      sent.push(d);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    raw: {},
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

/** Runs the real handler with a real single-use WS token. */
async function attach(userId: string, subshellId: string): Promise<FakeBrowser> {
  const url = new URL(`ws://localhost/ws?subshell=${subshellId}&token=${issueWsToken(userId)}`);
  const fake = fakeBrowser();
  await handleSubshellWs(fake.ws, url);
  return fake;
}

/** The healthy agent answers for a small-log attach. */
const ATTACH_HANDLERS = {
  probe: probeAllAlive,
  capture: () => "SCREEN",
  input: ok,
  resize: ok,
  tail_start: ok,
  tail_stop: ok,
  log_read: (cmd: NodeCommandBody) =>
    cmd.type === "log_read" && cmd.maxBytes === 1
      ? { bytes_b64: b64(LOG.slice(0, 1)), next: 1, size: LOG.length }
      : { bytes_b64: b64(LOG), next: LOG.length, size: LOG.length },
};

function outputFrame(subshellId: string, subId: string, fromByte: number, text: string) {
  return {
    type: "output" as const,
    subshellId,
    subId,
    fromByte,
    toByte: fromByte + text.length,
    data_b64: b64(text),
  };
}

function subIdOf(sim: ScriptedNode): string {
  return (sim.cmdsOf("tail_start")[0] as Extract<NodeCommandBody, { type: "tail_start" }>).subId;
}

let rowSeq = 0;
/** Seeds a running agent-node row (synthetic owner — access resolves by row.userId). */
async function seedAgentRow() {
  rowSeq += 1;
  const id = crypto.randomUUID();
  const { repos } = getRequestlessContext();
  await repos.subshells.create({
    id,
    userId: `u-it-ws-${rowSeq}`,
    profileId: "p-it",
    harnessId: "claude-code",
    name: "it-ws-remote",
    workingDir: "/srv/work/remote",
    tmuxSocket: tmuxSocketFor(id),
    nodeId: NODE_ID,
    status: "running",
  });
  return { id, userId: `u-it-ws-${rowSeq}` };
}

beforeAll(async () => {
  await runMigrations(); // rows + persistOutput's lastOutputAt write hit the shared temp DB
  await new NodesRepository(db).create({ id: NODE_ID, ownerUserId: "u-it-ws-owner", name: NODE_ID, kind: "agent" });
});

afterEach(() => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
});

describe("remote attach through the real handleSubshellWs dispatch", () => {
  it("token + row route to the relay: byte-exact browser contract over the real RPC loop", async () => {
    const { id, userId } = await seedAgentRow();
    const sim = attachScriptedNode(NODE_ID, ATTACH_HANDLERS);
    const { ws, sent, closed } = await attach(userId, id);
    try {
      expect(closed).toEqual([]); // the dispatch ran to completion, not a refusal

      // The §6.5 flow fired THROUGH the delegation: liveness, the join size
      // probe, the tail, then the capture — the same command list the relay's
      // own suite pins. Historical log bytes are never re-played, so there is
      // exactly ONE log_read.
      //
      // The tail precedes the capture because this path joins the SHARED pump
      // (subscribe → capture → open), which is what lets several browsers
      // watch one node pane without two overlapping tails. `fromByte` is
      // still the pre-capture EOF, so the join stays gap-free either way.
      expect(sim.cmdTypes()).toEqual(["probe", "log_read", "tail_start", "capture"]);
      expect(sim.cmdsOf("capture")).toEqual([{ type: "capture", subshellId: id, lines: 100 }]);
      expect(sim.cmdsOf("tail_start")).toEqual([
        { type: "tail_start", subshellId: id, subId: expect.any(String), fromByte: LOG.length },
      ]);

      // Frame 1: the replay, exactly the local path's shape.
      // Terminal frames only: the socket also carries `viewers` presence now.
      const term = () => sent.filter((f) => !f.includes('"type":"viewers"'));
      // No geometry frame: this attach carries no size (there is no `resize`
      // on the wire above), so there is nothing the pane was asked for to
      // announce. An attach that DOES carry one announces it before the
      // replay — see the relay's own suite.
      expect(term()[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));

      // Owner access ⇒ keystrokes and geometry ride the signed RPC (the
      // geometry passthrough: launch carries no cols today, the attach's
      // resize IS the live sizing path — the pane obeys the client).
      handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
      await until(() => sim.countOf("input") === 1, "input on the wire");
      expect(sim.cmdsOf("input")).toEqual([{ type: "input", subshellId: id, data: "ls\r" }]);
      handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
      await until(() => sim.countOf("resize") === 1, "resize on the wire");
      expect(sim.cmdsOf("resize")).toEqual([{ type: "resize", subshellId: id, cols: 132, rows: 43 }]);

      // Live output: an agent `output` frame through the REAL bus becomes the
      // browser's `output` frame.
      // fromByte sits at the armed EOF offset — the launcher's dup-clamp
      // would (correctly) discard anything below it.
      // The resize above went through the geometry queue, and a node pane
      // cannot be read back — so the queue announces the size it APPLIED
      // rather than staying silent. That is what keeps several viewers of one
      // node pane rendering the same grid as each other and as the pane.
      expect(term()[1]).toBe(JSON.stringify({ type: "geometry", cols: 132, rows: 43 }));

      dispatchOutput(outputFrame(id, subIdOf(sim), LOG.length, "echo hi\r\n"));
      await until(() => term().length === 3, "output frame");
      expect(term()[2]).toBe(JSON.stringify({ type: "output", data: "echo hi\r\n" }));
    } finally {
      sim.detach();
    }
  });

  it("double cleanup closes the relay with EXACTLY ONE tail_stop (T11 parity carry, remote half)", async () => {
    const { id, userId } = await seedAgentRow();
    const sim = attachScriptedNode(NODE_ID, ATTACH_HANDLERS);
    const { ws } = await attach(userId, id);
    try {
      await until(() => sim.countOf("tail_start") === 1, "tail armed");
      const sub = subIdOf(sim);

      cleanupSubshellWs(ws);
      cleanupSubshellWs(ws); // belt-and-braces second cleanup (close after error-path teardown)
      await until(() => sim.countOf("tail_stop") === 1, "tail_stop on the wire");
      expect(await sawWithin(() => sim.countOf("tail_stop") > 1, 100)).toBe(false);
      expect(sim.cmdsOf("tail_stop")).toEqual([{ type: "tail_stop", subId: sub }]);
      // Deaf after disposal: a late event must not ship.
      expect(dispatchOutput(outputFrame(id, sub, 0, "late"))).toBe(false);
    } finally {
      sim.detach();
    }
  });
});

describe("double cleanup parity — the local path absorbs it identically (T11 parity carry, local half)", () => {
  // The local branch reaches the real tmux CLI; stub the two pane-touching
  // members of the SHARED defaultLocalLauncher (the local-attach suite's
  // technique) and let fs.watch / the tail pump / the DB run for real.
  const originals = { hasSubshell: defaultLocalLauncher.hasSubshell, capture: defaultLocalLauncher.capture };
  afterEach(() => {
    defaultLocalLauncher.hasSubshell = originals.hasSubshell;
    defaultLocalLauncher.capture = originals.capture;
  });

  it("two cleanupSubshellWs calls on a local attach: no throw, and the stream stays dead", async () => {
    rowSeq += 1;
    const id = crypto.randomUUID();
    const userId = `u-it-ws-${rowSeq}`;
    const { repos } = getRequestlessContext();
    await repos.subshells.create({
      id,
      userId,
      profileId: "p-it",
      harnessId: "shell",
      name: "it-ws-local",
      workingDir: "/tmp",
      tmuxSocket: tmuxSocketFor(id), // nodeId defaults to `local`
    });
    defaultLocalLauncher.hasSubshell = async () => true;
    defaultLocalLauncher.capture = async () => "SCREEN";
    const logFile = subshellLogPath(id);
    await Bun.write(logFile, "old\n"); // log exists ⇒ startLogTail branch (fs.watch path)

    const { ws, sent } = await attach(userId, id);
    try {
      // Terminal frames only: the socket also carries `viewers` presence now.
      const term = () => sent.filter((f) => !f.includes('"type":"viewers"'));
      expect(term()[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
      await new Promise((r) => setTimeout(r, 60)); // let the initial catch-up pump land
      cleanupSubshellWs(ws);
      expect(() => cleanupSubshellWs(ws)).not.toThrow(); // the parity claim: second is a no-op
      const framesAtDisconnect = sent.length;

      appendFileSync(logFile, "after disconnect\n");
      await new Promise((r) => setTimeout(r, 1300)); // watcher fires ~instantly; backstop covers twice
      expect(sent.slice(framesAtDisconnect)).toEqual([]);
    } finally {
      cleanupSubshellWs(ws);
    }
  });
});
