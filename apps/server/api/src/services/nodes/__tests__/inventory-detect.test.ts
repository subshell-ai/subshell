import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { allHarnesses, getHarness, type HarnessPlugin } from "@internal/pane-runtime";
import type { DetectSpecWire, NodeCommandBody } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { enabledInstalledPlugins } from "@/services/nodes/local-plugins.js";
import type { sendCommand } from "@/services/nodes/node-rpc.js";
import {
  detectEnvNames,
  detectOnNode,
  detectSpecs,
  enabledEnvHarnesses,
  INVENTORY_TTL_MS,
  readAgentInventory,
} from "../inventory.js";
import { attachConnection, getLive, type NodeSocket, resetNodeRegistryForTests } from "../node-registry.js";
import { handleNodeMessage, type NodeWsDeps, type NodeWsSocket } from "../node-ws-handler.js";
import { RemoteLauncher } from "../remote-launcher.js";

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

/** The env names the driver asked about on its single recorded command. */
function envNamesOf(sent: Sent[]): string[] {
  const cmd = sent[0]?.cmd;
  if (cmd?.type !== "detect") throw new Error(`expected a detect command, got ${cmd?.type}`);
  return cmd.envNames;
}

/** A seam that records every command (multiple round trips in one test). */
function recordingSend(answer: unknown, sent: Sent[]): typeof sendCommand {
  return ((nodeId: string, cmd: NodeCommandBody) => {
    sent.push({ nodeId, cmd });
    return Promise.resolve(answer);
  }) as unknown as typeof sendCommand;
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

describe("detectEnvNames: the plane names what it asks for (spec §5 as amended)", () => {
  it("unions the declared names and dedupes across harnesses", () => {
    const a = { id: "a", hostEnv: ["X_A", "X_SHARED"] } as unknown as HarnessPlugin;
    const b = { id: "b", hostEnv: ["X_SHARED", "X_B"] } as unknown as HarnessPlugin;
    const c = { id: "c" } as unknown as HarnessPlugin; // no declaration: contributes nothing
    expect(detectEnvNames([a, b, c]).sort()).toEqual(["X_A", "X_B", "X_SHARED"]);
  });

  it("the empty set is the empty list — a plane whose manifests declare nothing asks for nothing", () => {
    expect(detectEnvNames([])).toEqual([]);
  });

  it("the driver sends the union on the wire (seam catalog; claude-code's real declaration pinned below)", async () => {
    await runMigrations(); // this describe sits outside the detectOnNode one (suite idiom)
    const node = await mkAgent();
    const sent: Sent[] = [];
    await detectOnNode(node.id, {
      send: fakeSend({ results: [], env: {} }, sent),
      envHarnesses: async () => [
        { id: "a", hostEnv: ["CLAUDE_CONFIG_DIR"] } as unknown as HarnessPlugin,
        { id: "b", hostEnv: ["CLAUDE_CONFIG_DIR", "X_OTHER"] } as unknown as HarnessPlugin,
      ],
    });
    expect(envNamesOf(sent).sort()).toEqual(["CLAUDE_CONFIG_DIR", "X_OTHER"]);
  });

  it("the DEFAULT env source is the enabled instance catalog, never a hardcoded list", async () => {
    // What is pinned is the WIRING, not the store's contents (a lone-file
    // test run may hold an empty instance store): the seam-less source is
    // the enabled catalog (§6.1 `plugin_state` filter) restricted to ids the
    // registry resolves — a disabled plugin's declarations never go on the
    // wire, and a broken install contributes nothing.
    const [harnesses, catalog] = await Promise.all([enabledEnvHarnesses(), enabledInstalledPlugins()]);
    expect(harnesses.map((h) => h.id)).toEqual(catalog.map((r) => r.id).filter((id) => getHarness(id) !== undefined));
  });

  it("claude-code's REAL manifest reaches detectEnvNames: the resume landmine depends on it", () => {
    // Declaration (claude-code's package.json) → adapter passthrough →
    // union. If any link breaks, resume silently stops offering itself on
    // nodes that set the variable, with nothing anywhere saying why.
    const claudeCode = getHarness("claude-code");
    if (!claudeCode) throw new Error("claude-code plugin is not in the registry");
    expect(detectEnvNames([claudeCode])).toContain("CLAUDE_CONFIG_DIR");
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
          env: {},
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
        {
          results: [{ harnessId: "claude-code", installed: true, binaryPath: "/x/claude", rawVersion: "9.9.9" }],
          env: {},
        },
        [],
      ),
    });
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("claude-code")?.version).toBe("9.9.9");
  });

  it("a miss caches installed:false with its reason and no version", async () => {
    const node = await mkAgent();
    await detectOnNode(node.id, {
      send: fakeSend({ results: [{ harnessId: "pi", installed: false, reason: "not-on-path" }], env: {} }, []),
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
        { results: [{ harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "1.2.3" }], env: {} },
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
        { results: [{ harnessId: "third-party-tool", installed: true, rawVersion: "Tool v3 (weird)" }], env: {} },
        [],
      ),
    });
    expect(
      readAgentInventory((await nodes.findById(node.id)) as NodeTable).entries.get("third-party-tool")?.version,
    ).toBe("Tool v3 (weird)");
  });

  /**
   * H2 (Task 7, inversion §4/§6): the detection rows are the plane's cache,
   * and a plugin-less agent's periodic `inventory` EVENT must not wipe them.
   * After the demolition the agent fills the v2-required `harnesses` array
   * with `[]` on the connect push and every 5-min beat; the handler treats
   * an empty claim as "don't touch". This goes through the REAL repository,
   * because the property under test is precisely that the column survives.
   */
  it("a plugin-less agent's periodic inventory push (harnesses: []) does NOT wipe the detect cache", async () => {
    const node = await mkAgent();
    await detectOnNode(node.id, {
      send: fakeSend(
        {
          results: [{ harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "Hermes v1.2.3" }],
          env: {},
        },
        [],
      ),
    });
    const before = (await nodes.findById(node.id)) as NodeTable;
    expect(before.inventoryJson).toContain("hermes");

    const ws = {
      data: { nodeId: node.id },
      send: () => 0,
      close: () => {},
    } as unknown as NodeWsSocket;
    const deps = {
      verifyApiKey: async () => null,
      nodes: new NodesRepository(db),
      resolveResult: () => false,
    } as unknown as NodeWsDeps;

    await handleNodeMessage(
      deps,
      ws,
      JSON.stringify({ type: "inventory", harnesses: [], ts: new Date().toISOString() }),
    );
    const after = (await nodes.findById(node.id)) as NodeTable;
    expect(after.inventoryJson).toBe(before.inventoryJson); // the cached rows survive VERBATIM
    expect(after.inventoryAt).toBe(before.inventoryAt); // ...and so does the stamp: no write happened at all
    const cached = readAgentInventory(after);
    expect(cached.entries.get("hermes")?.version).toBe("1.2.3"); // parsed by the plugin, still there
    expect(cached.fresh).toBe(true); // the cache is still a claim the launch gate can trust
  });

  it("a NON-empty harness list (a paired pre-inversion agent's real scan) still applies wholesale", async () => {
    // The guard is a no-claim rule, not a freeze: an agent from before the
    // demolition reports an honest scan, and that scan is still the snapshot.
    const node = await mkAgent();
    const ws = {
      data: { nodeId: node.id },
      send: () => 0,
      close: () => {},
    } as unknown as NodeWsSocket;
    const deps = {
      verifyApiKey: async () => null,
      nodes: new NodesRepository(db),
      resolveResult: () => false,
    } as unknown as NodeWsDeps;
    const harnesses = [{ harnessId: "claude-code", installed: true, version: "9.9.9" }];
    await handleNodeMessage(deps, ws, JSON.stringify({ type: "inventory", harnesses, ts: new Date().toISOString() }));
    const cached = readAgentInventory((await nodes.findById(node.id)) as NodeTable);
    expect(cached.entries.get("claude-code")?.version).toBe("9.9.9");
    expect(cached.fresh).toBe(true);
  });

  it("local is never sent a detect: its view probes live", async () => {
    const id = `local-${crypto.randomUUID().slice(0, 8)}`;
    await nodes.create({ id, ownerUserId: OWNER, name: "det-local", kind: "local", status: "online" });
    createdNodeIds.push(id);
    const sent: Sent[] = [];
    await detectOnNode(id, { send: fakeSend({ results: [], env: {} }, sent) });
    expect(sent).toHaveLength(0);
  });

  it("an unknown node id answers without a send (and without a throw)", async () => {
    const sent: Sent[] = [];
    await detectOnNode(crypto.randomUUID(), { send: fakeSend({ results: [], env: {} }, sent) });
    expect(sent).toHaveLength(0);
  });

  /**
   * THE landmine of spec §11, pinned end to end through the real stash seam
   * (final review R14b). A node whose user sets CLAUDE_CONFIG_DIR must offer
   * resume from THAT directory. Before the amendment this could not be
   * tested at all on a fresh node: the ready-time report read the node's own
   * plugins directory, which post-inversion a node never has, so every fresh
   * node answered `env: {}` and the resume quietly died. A FRESH node here —
   * no residue, no ready-reported env — and the values arrive ONLY via the
   * detect answer.
   */
  it("a detect answer carrying CLAUDE_CONFIG_DIR moves the resume path the launcher probes", async () => {
    const node = await mkAgent(); // fresh: no inventory, and the connection below has no env
    const socket = { send: () => {}, close: () => {} } as unknown as NodeSocket;
    const conn = attachConnection(node.id, socket);
    // Exactly what `ready` stashes on a real connection: home, no env.
    conn.agent = {
      dataDir: "/home/n/.subshell",
      capabilities: ["uploads", "mcp"],
      hostname: "landmine",
      agentVersion: "0.3.0",
      homeDir: "/home/n",
    };
    try {
      // 1) The plane's detect round trip carries the values back…
      await detectOnNode(node.id, {
        send: fakeSend(
          {
            results: [{ harnessId: "claude-code", installed: true, binaryPath: "/x/claude", rawVersion: "9.9.9" }],
            env: { CLAUDE_CONFIG_DIR: "/vault/claude" },
          },
          [],
        ),
      });
      expect(getLive(node.id)?.agent?.env).toEqual({ CLAUDE_CONFIG_DIR: "/vault/claude" });
      // 2) …and the launcher composes the resume path from them: the probe
      // goes to the vault, NOT to /home/n/.claude.
      const asked: Sent[] = [];
      const launcher = new RemoteLauncher(node.id, {
        send: recordingSend({ exists: true }, asked),
        nodes: { findById: async () => undefined },
      });
      const claudeCode = getHarness("claude-code");
      if (!claudeCode) throw new Error("claude-code plugin is not in the registry");
      expect(await launcher.canResume(claudeCode, "sess-1", "/work/proj")).toBe(true);
      const cmd = asked[0]?.cmd;
      expect(cmd?.type).toBe("path_exists");
      expect((cmd as { path: string }).path).toBe("/vault/claude/projects/-work-proj/sess-1.jsonl");
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("a later detect replaces the stashed env wholesale (fresh answer, not an append)", async () => {
    // The plane re-asks on every detect; a variable the node no longer has
    // must stop moving the path, exactly as `hostEnvAnswers` omits it.
    const node = await mkAgent();
    const socket = { send: () => {}, close: () => {} } as unknown as NodeSocket;
    const conn = attachConnection(node.id, socket);
    conn.agent = {
      dataDir: "/home/n/.subshell",
      capabilities: ["mcp"],
      hostname: "h",
      agentVersion: "0.3.0",
      homeDir: "/home/n",
      env: { CLAUDE_CONFIG_DIR: "/first" },
    };
    try {
      await detectOnNode(node.id, { send: fakeSend({ results: [], env: {} }, []) });
      expect(getLive(node.id)?.agent?.env).toEqual({});
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("no detect happens without a request (the §4 no-sweep property pin)", async () => {
    // Nothing in this module arms a timer: detection runs when someone asks
    // (page load, Re-check), and NOTHING else. The 30-min clock advance crosses
    // INVENTORY_TTL_MS; if a future change re-adds a periodic refresh, THIS is
    // the test that says why it may not.
    const node = await mkAgent();
    const sent: Sent[] = [];
    const send = fakeSend({ results: [], env: {} }, sent);
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
