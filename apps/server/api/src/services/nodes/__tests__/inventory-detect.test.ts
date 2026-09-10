import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { allHarnesses } from "@internal/pane-runtime";
import type { DetectSpecWire, NodeCommandBody } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import type { sendCommand } from "@/services/nodes/node-rpc.js";
import { detectOnNode, detectSpecs, INVENTORY_TTL_MS, readAgentInventory } from "../inventory.js";

/**
 * The `detect` driver (spec 2026-09-10 §4): the control plane ships the
 * detection rules, the node answers RAW text, and the raw text is parsed HERE
 * by the plugin's `parseVersion` — plugin code now runs only on the control
 * plane — before being cached through the ordinary `applyInventory` path.
 *
 * The wire is faked exactly as the launcher suite does it: an injected `send`
 * seam, never a socket.
 */

const nodes = new NodesRepository(db);
const OWNER = `det-owner-${crypto.randomUUID().slice(0, 8)}`;
const createdNodeIds: string[] = [];

async function mkAgent(inv?: { json: unknown[]; at: string | null }): Promise<NodeTable> {
  const id = crypto.randomUUID();
  await nodes.create({
    id,
    ownerUserId: OWNER,
    name: `det-${id.slice(0, 8)}`,
    kind: "agent",
    status: "offline",
    ...(inv ? { inventoryJson: JSON.stringify(inv.json), inventoryAt: inv.at } : {}),
  });
  createdNodeIds.push(id);
  return (await nodes.findById(id)) as NodeTable;
}

interface Sent {
  nodeId: string;
  cmd: NodeCommandBody;
}

/** A `send` seam that records commands and answers with a fixed payload. */
function fakeSend(answer: unknown, sent: Sent[]): typeof sendCommand {
  return ((nodeId: string, cmd: NodeCommandBody) => {
    sent.push({ nodeId, cmd });
    return Promise.resolve(answer);
  }) as unknown as typeof sendCommand;
}

function _specsOf(sent: Sent[]): DetectSpecWire[] {
  const cmd = sent[0]?.cmd;
  if (cmd?.type !== "detect") throw new Error(`expected a detect command, got ${cmd?.type}`);
  return cmd.specs;
}

describe("detectSpecs: built from the plugins this build holds", () => {
  it("one spec per built-in, carrying the manifest's detect block verbatim", () => {
    const specs = detectSpecs();
    expect(specs.map((s) => s.id).sort()).toEqual(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    );
    const hermes = specs.find((s) => s.id === "hermes");
    expect(hermes).toEqual({
      id: "hermes",
      binaryName: "hermes",
      envOverride: "HERMES_PATH",
      knownPaths: [".local/bin/hermes"],
    });
  });

  it("a plugin with no detectSpec travels as the EMPTY spec, not absent keys", () => {
    const ghost = { ...allHarnesses()[0] };
    delete ghost.detectSpec;
    const specs = detectSpecs([ghost]);
    expect(specs).toEqual([{ id: ghost.id, binaryName: "", envOverride: "", knownPaths: [] }]);
  });
});

describe("detectOnNode", () => {
  beforeAll(async () => {
    await runMigrations(); // no-op when already applied (inventory suite idiom)
  });

  afterAll(async () => {
    for (const id of createdNodeIds) await nodes.deleteById(id);
  });

  it("the driver parses the raw version with the plugin and caches it like an inventory", async () => {
    // hermes prints a banner, not a bare version, and is the only built-in
    // with parseVersion. The RAW text can only become "1.2.3" by running the
    // plugin's parser on THIS side of the wire.
    const node = await mkAgent();
    const sent: Sent[] = [];
    await detectOnNode(node.id, {
      send: fakeSend(
        {
          results: [
            { harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "Hermes v1.2.3 (build 9)" },
          ],
        },
        sent,
      ),
    });
    expect(sent[0]?.nodeId).toBe(node.id);
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("hermes")?.version).toBe("1.2.3");
    expect(cached.entries.get("hermes")?.installed).toBe(true);
    expect(cached.entries.get("hermes")?.binaryPath).toBe("/x/hermes");
    expect(cached.entries.get("hermes")?.checkedAt).toBeTruthy();
    expect(cached.fresh).toBe(true); // stored via applyInventory: inventoryAt stamped, TTL intact
    // The raw text never reaches the cache.
    expect(JSON.parse(((await nodes.findById(node.id)) as NodeTable).inventoryJson ?? "")).not.toContain("build 9");
  });

  it("a plugin without parseVersion stores the raw text as the version", async () => {
    const node = await mkAgent();
    await detectOnNode(node.id, {
      send: fakeSend(
        { results: [{ harnessId: "claude-code", installed: true, binaryPath: "/x/claude", rawVersion: "9.9.9" }] },
        [],
      ),
    });
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("claude-code")?.version).toBe("9.9.9");
  });

  it("a miss caches installed:false with its reason and no version", async () => {
    const node = await mkAgent();
    await detectOnNode(node.id, {
      send: fakeSend({ results: [{ harnessId: "pi", installed: false, reason: "not-on-path" }] }, []),
    });
    const entry = readAgentInventory((await nodes.findById(node.id)) as NodeTable).entries.get("pi");
    expect(entry).toEqual({ harnessId: "pi", installed: false, reason: "not-on-path", checkedAt: entry?.checkedAt });
  });

  it("merges over the cached snapshot: rows the answer omits keep their values", async () => {
    // A third-party plugin only the node's own inventory reports must survive
    // a detect built from this server's registry — and the rows the detect
    // DOES answer are replaced, not aged alongside.
    const node = await mkAgent({
      json: [
        { harnessId: "third-party-tool", installed: true, version: "0.1", checkedAt: "2026-09-01T00:00:00.000Z" },
        { harnessId: "hermes", installed: true, version: "stale", checkedAt: "2026-09-01T00:00:00.000Z" },
      ],
      at: new Date(Date.now() - INVENTORY_TTL_MS - 60_000).toISOString(),
    });
    await detectOnNode(node.id, {
      send: fakeSend(
        { results: [{ harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "1.2.3" }] },
        [],
      ),
    });
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("third-party-tool")?.version).toBe("0.1"); // preserved verbatim
    expect(cached.entries.get("hermes")?.version).toBe("1.2.3"); // replaced
    expect(cached.fresh).toBe(true); // the whole snapshot re-stamped, as applyInventory does
  });

  it("a node answered with garbage: rejects, and the cache is untouched", async () => {
    const node = await mkAgent({
      json: [{ harnessId: "hermes", installed: true, version: "kept" }],
      at: new Date().toISOString(),
    });
    await expect(detectOnNode(node.id, { send: fakeSend({ results: [{ installed: true }] }, []) })).rejects.toThrow(
      /malformed/,
    );
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("hermes")?.version).toBe("kept");
  });

  it("the row for a plugin this build has never heard of keeps its raw text", async () => {
    // No parser to apply — a banner still beats dropping the only version fact.
    const node = await mkAgent();
    await detectOnNode(node.id, {
      send: fakeSend(
        { results: [{ harnessId: "third-party-tool", installed: true, rawVersion: "Tool v3 (weird)" }] },
        [],
      ),
    });
    expect(
      readAgentInventory((await nodes.findById(node.id)) as NodeTable).entries.get("third-party-tool")?.version,
    ).toBe("Tool v3 (weird)");
  });

  it("local is never sent a detect: its view probes live", async () => {
    const id = `local-${crypto.randomUUID().slice(0, 8)}`;
    await nodes.create({ id, ownerUserId: OWNER, name: "det-local", kind: "local", status: "online" });
    createdNodeIds.push(id);
    const sent: Sent[] = [];
    await detectOnNode(id, { send: fakeSend({ results: [] }, sent) });
    expect(sent).toHaveLength(0);
  });

  it("an unknown node id answers without a send (and without a throw)", async () => {
    const sent: Sent[] = [];
    await detectOnNode(crypto.randomUUID(), { send: fakeSend({ results: [] }, sent) });
    expect(sent).toHaveLength(0);
  });

  it("no detect happens without a request (the §4 no-sweep property pin)", async () => {
    // Nothing in this module arms a timer: detection runs when someone asks
    // (page load, Re-check), and NOTHING else. The 30-min clock advance crosses
    // INVENTORY_TTL_MS; if a future change re-adds a periodic refresh, THIS is
    // the test that says why it may not.
    const node = await mkAgent();
    const sent: Sent[] = [];
    const send = fakeSend({ results: [] }, sent);
    try {
      setSystemTime(Date.now() + 30 * 60_000);
      await new Promise((r) => setTimeout(r, 20));
      expect(sent).toHaveLength(0);
      // (and a real request DOES send — the seam is live, the absence is the point)
      await detectOnNode(node.id, { send });
      expect(sent).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });
});
