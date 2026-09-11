import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allHarnesses } from "@internal/pane-runtime";
import { harnessUsable, usableHarnessIds } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { localPluginsDir, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { seedLocalPluginsForTests, setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";
import { effectiveHarnessStates, INVENTORY_TTL_MS, readAgentInventory } from "../inventory.js";

/**
 * The one usability rule (spec 2026-09-10, Task 9): the INSTANCE has the
 * plugin installed and enabled, AND THAT NODE's detection found its binary.
 *
 * There is no per-node plugin set any more and no `node.kind` branch: the
 * instance store is the catalog for every node, and the only thing that
 * differs between `local` and an agent is where the detection half comes from
 * — a live probe this process runs, or the cached answer the `detect` driver
 * stored. The two strictnesses survive: the VIEW (effectiveHarnessStates) is
 * informational and reports a stale snapshot's values flagged via `stale`;
 * the LAUNCH GATE is strict — only a fresh (≤ INVENTORY_TTL_MS) detection that
 * says installed counts.
 */

const H0 = "claude-code";
const H1 = "opencode";
const H2 = "hermes";

const nodes = new NodesRepository(db);
const OWNER = `inv-owner-${crypto.randomUUID().slice(0, 8)}`;

function freshAt(): string {
  return new Date().toISOString();
}
function staleAt(): string {
  return new Date(Date.now() - INVENTORY_TTL_MS - 60_000).toISOString();
}

function entry(harnessId: string, installed: boolean, version?: string): Record<string, unknown> {
  return version ? { harnessId, installed, version } : { harnessId, installed };
}

describe("services/nodes/inventory", () => {
  const createdNodeIds: string[] = [];

  /** A node row. It DECLARES nothing — after the inversion it has no plugin concept. */
  async function mkNode(kind: "local" | "agent", inv?: { json: unknown[]; at: string | null }): Promise<NodeTable> {
    const id = kind === "local" ? `local-${crypto.randomUUID().slice(0, 8)}` : crypto.randomUUID();
    await nodes.create({
      id,
      ownerUserId: OWNER,
      // The WHOLE id, never a slice of it. `nodes` carries a UNIQUE index on
      // (owner_user_id, name) and every node here shares OWNER, so the name
      // has to be as unique as the id is. `id.slice(0, 8)` was not: a local
      // id is `local-` plus 8 hex, so its first 8 characters are `local-`
      // plus TWO hex digits — 256 possible names for the five local nodes
      // this file creates, which is a ~4% chance per run of an insert that
      // dies on the unique index. Measured at 1 failure in 30 local runs,
      // and it is what CI kept hitting (run 34586285401 and before).
      name: `inv-${id}`,
      kind,
      status: "offline",
      ...(inv ? { inventoryJson: JSON.stringify(inv.json), inventoryAt: inv.at } : {}),
    });
    createdNodeIds.push(id);
    return (await nodes.findById(id)) as NodeTable;
  }

  /** Run `fn` with every built-in's binary probe stubbed to `found`-ness. */
  async function withStubs<T>(found: Record<string, boolean>, fn: () => Promise<T>): Promise<T> {
    const stubs = allHarnesses().map((h) => ({
      h,
      detect: h.detect.bind(h),
      getVersion: h.getVersion.bind(h),
      versionAt: h.versionAt.bind(h),
    }));
    for (const s of stubs) {
      s.h.detect = async () =>
        found[s.h.id] ? { path: `/usr/bin/${s.h.id}` } : { path: null, reason: "override-invalid" as const };
      s.h.getVersion = async () => "7.7.7";
      s.h.versionAt = async () => "7.7.7";
    }
    try {
      return await fn();
    } finally {
      for (const s of stubs) {
        s.h.detect = s.detect;
        s.h.getVersion = s.getVersion;
        s.h.versionAt = s.versionAt;
      }
    }
  }

  beforeAll(async () => {
    // The auth helper runs the real migrations AND seeds this process's
    // plugin directory — since Task 9 the directory is the catalog the gate
    // and the view both read.
    await setupAuthTables();
  });

  afterAll(async () => {
    for (const id of createdNodeIds) await nodes.deleteById(id);
    await new PluginStateRepository(db).clear(H0).catch(() => {});
  });

  describe("effectiveHarnessStates (agent): instance catalog × cached detection", () => {
    it("every instance plugin gets a row; the inventory only colors it", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });

      const report = await effectiveHarnessStates(node);
      expect(report.stale).toBe(false);
      // One row per plugin the INSTANCE has installed — NOT per plugin the
      // node mentions. A node cannot offer what the instance does not carry,
      // and a plugin the instance has but the node was never asked about
      // still gets a row (installed=false): it is this machine's answer to
      // "can it run here", and this machine has not said yes.
      const ids = report.harnesses.map((h) => h.harnessId);
      expect(ids).toContain(H0);
      expect(ids).toContain(H1);
      expect(ids).toContain(H2);

      const e0 = report.harnesses.find((h) => h.harnessId === H0);
      expect(e0).toMatchObject({ installed: true, version: "9.9.9" });
      const e1 = report.harnesses.find((h) => h.harnessId === H1);
      expect(e1).toMatchObject({ installed: false });
      expect(e1?.version).toBeUndefined();
      // Never detected: a row, but nothing asserted about the binary.
      const e2 = report.harnesses.find((h) => h.harnessId === H2);
      expect(e2).toMatchObject({ installed: false });
      expect(e2?.reason).toBeUndefined();
      // An inventory row for a plugin the instance does NOT have is inert.
      expect(ids).not.toContain("ghost-tool");
    });

    it("stale rule: aged snapshot still reports its values, flagged", async () => {
      const fresh = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      expect((await effectiveHarnessStates(fresh)).stale).toBe(false);

      const aged = await mkNode("agent", { json: [entry(H0, true, "2.0")], at: staleAt() });
      const agedReport = await effectiveHarnessStates(aged);
      expect(agedReport.stale).toBe(true);
      expect(agedReport.harnesses.find((h) => h.harnessId === H0)).toMatchObject({ installed: true, version: "2.0" });

      const never = await mkNode("agent");
      const neverReport = await effectiveHarnessStates(never);
      expect(neverReport.stale).toBe(true);
      // Rows EXIST (the instance has the plugins) but every installed flag is
      // false: this node has never been asked, which the stale flag says out
      // loud rather than the rows inventing an answer.
      expect(neverReport.harnesses.length).toBeGreaterThan(0);
      expect(neverReport.harnesses.every((h) => h.installed === false)).toBe(true);

      // Junk inventory reads as empty, never as a crash.
      const junk = await mkNode("agent", { json: [], at: null });
      await db
        .updateTable("nodes")
        .set({ inventoryJson: "{not json", inventoryAt: freshAt() })
        .where("id", "=", junk.id)
        .execute();
      const junkReport = await effectiveHarnessStates((await nodes.findById(junk.id)) as NodeTable);
      expect(junkReport.stale).toBe(false); // snapshot timestamp is fresh…
      expect(junkReport.harnesses.every((h) => h.installed === false)).toBe(true); // …the payload just parses empty
    });

    it("passes reason and checkedAt straight through, and neither for entries that have none", async () => {
      const node = await mkNode("agent", {
        json: [{ harnessId: H0, installed: false, reason: "override-invalid", checkedAt: "2026-09-09T12:00:00.000Z" }],
        at: freshAt(),
      });
      const e0 = (await effectiveHarnessStates(node)).harnesses.find((h) => h.harnessId === H0);
      expect(e0?.reason).toBe("override-invalid");
      expect(e0?.checkedAt).toBe("2026-09-09T12:00:00.000Z");

      const bare = await mkNode("agent", { json: [entry(H0, true, "1.0")], at: freshAt() });
      const b0 = (await effectiveHarnessStates(bare)).harnesses.find((h) => h.harnessId === H0);
      expect(b0?.reason).toBeUndefined();
      expect(b0?.checkedAt).toBeUndefined();
    });
  });

  describe("effectiveHarnessStates (local): instance catalog × live probe", () => {
    it("installed rows carry the probe's version, reason and stamp", async () => {
      const node = await mkNode("local");
      await withStubs({ [H0]: true, [H1]: false }, async () => {
        const report = await effectiveHarnessStates(node);
        expect(report.stale).toBe(false);

        const e0 = report.harnesses.find((h) => h.harnessId === H0);
        expect(e0).toMatchObject({ installed: true, version: "7.7.7" });
        expect(e0?.reason).toBeUndefined();
        expect(typeof e0?.checkedAt).toBe("string");

        const e1 = report.harnesses.find((h) => h.harnessId === H1);
        expect(e1).toMatchObject({ installed: false, reason: "override-invalid" });
        expect(e1?.version).toBeUndefined();
      });
    });

    it("gives a local row and an agent row the same shape", async () => {
      const local = await mkNode("local");
      const agent = await mkNode("agent", {
        json: [{ harnessId: H0, installed: true, version: "9.9.9", checkedAt: new Date().toISOString() }],
        at: new Date().toISOString(),
      });
      await withStubs({ [H0]: true }, async () => {
        const l = (await effectiveHarnessStates(local)).harnesses.find((h) => h.harnessId === H0);
        const a = (await effectiveHarnessStates(agent)).harnesses.find((h) => h.harnessId === H0);
        expect(Object.keys(l ?? {}).sort()).toEqual(Object.keys(a ?? {}).sort());
      });
    });

    it("gives every local entry one shared stamp", async () => {
      const node = await mkNode("local");
      await withStubs({}, async () => {
        const report = await effectiveHarnessStates(node);
        const stamps = new Set(report.harnesses.map((h) => h.checkedAt));
        expect(stamps.size).toBe(1);
      });
    });

    it("a disabled plugin has no row at all — anywhere, for any node", async () => {
      const state = new PluginStateRepository(db);
      const node = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      try {
        await state.setEnabled(H0, false);
        expect((await effectiveHarnessStates(node)).harnesses.find((h) => h.harnessId === H0)).toBeUndefined();
        const local = await mkNode("local");
        expect((await effectiveHarnessStates(local)).harnesses.find((h) => h.harnessId === H0)).toBeUndefined();
      } finally {
        await state.clear(H0);
      }
      expect((await effectiveHarnessStates(node)).harnesses.find((h) => h.harnessId === H0)).toBeDefined();
    });

    it("an empty plugins directory means the catalog is empty, not 'everything built-in'", async () => {
      // The property survives the inversion with the store moved: the
      // instance directory IS the catalog now, so wiping it wipes every
      // node's rows, not just the host's.
      rmSync(localPluginsDir(), { recursive: true, force: true });
      try {
        const node = await mkNode("local");
        const report = await effectiveHarnessStates(node);
        expect(report.harnesses).toEqual([]);
        expect(await usableHarnessIds()).toEqual(new Set());
      } finally {
        await seedLocalPluginsForTests();
      }
    });
  });

  describe("the ONE usability rule, for every node", () => {
    it("usableHarnessIds(nodeId) is the intersection: instance catalog ∧ that node's fresh detection", async () => {
      // Instance has ALL five built-ins; this node's inventory saw two, and
      // one of those was found absent.
      const node = await mkNode("agent", {
        json: [entry(H0, true), entry(H1, false), entry("ghost-tool", true)],
        at: freshAt(),
      });
      expect(await usableHarnessIds(node.id)).toEqual(new Set([H0]));

      // A second node whose cache says the opposite: the sets differ per node
      // even though the catalog is one.
      const other = await mkNode("agent", { json: [entry(H1, true)], at: freshAt() });
      expect(await usableHarnessIds(other.id)).toEqual(new Set([H1]));
    });

    it("a plugin the instance does not carry is NOT usable on a node that reports it installed", async () => {
      // The inversion's other half: the node no longer decides what exists.
      // A detection cache row for an id the instance never installed is inert
      // (it still renders in the view? no — the view iterates the instance
      // catalog too), so neither gate can be talked into admitting it.
      const node = await mkNode("agent", { json: [entry("ghost-tool", true)], at: freshAt() });
      expect(await harnessUsable("ghost-tool", node.id)).toBe(false);
      expect(await usableHarnessIds(node.id)).toEqual(new Set());
      const report = await effectiveHarnessStates(node);
      expect(report.harnesses.find((h) => h.harnessId === "ghost-tool")).toBeUndefined();
    });

    it("agent gate is STRICT: a FRESH snapshot only — the view still reports the aged one", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      expect(await harnessUsable(H0, node.id)).toBe(true);

      await db.updateTable("nodes").set({ inventoryAt: staleAt() }).where("id", "=", node.id).execute();
      const aged = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable(H0, aged.id)).toBe(false);
      // …and the two strictnesses are deliberately different:
      const report = await effectiveHarnessStates(aged);
      expect(report.harnesses.find((h) => h.harnessId === H0)?.installed).toBe(true);
      expect(report.stale).toBe(true);
    });

    it("a disabled instance plugin is unusable EVERYWHERE, and re-enabling restores it with nothing per-profile stored", async () => {
      const state = new PluginStateRepository(db);
      const agent = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      try {
        expect(await harnessUsable(H0, agent.id)).toBe(true);
        await state.setEnabled(H0, false);
        expect(await harnessUsable(H0, agent.id)).toBe(false); // per-node gate
        expect((await usableHarnessIds(agent.id)).has(H0)).toBe(false); // per-node batch
        await withStubs({ [H0]: true }, async () => {
          expect(await harnessUsable(H0)).toBe(false); // local gate
          expect((await usableHarnessIds()).has(H0)).toBe(false); // local batch
        });
        await state.setEnabled(H0, true);
        expect(await harnessUsable(H0, agent.id)).toBe(true);
      } finally {
        await state.clear(H0);
      }
    });

    it("a broken instance plugin keeps its view row but is never usable", async () => {
      // Write a broken plugin straight into the instance directory (past the
      // installer, whose load-check-before-swap makes this un-installable):
      // the report carries `broken`, the page can name the failure, and the
      // gate refuses regardless of detection.
      const dir = join(localPluginsDir(), "broken-tool");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "broken-tool",
          version: "1.0.0",
          type: "module",
          subshell: {
            apiVersion: 1,
            id: "broken-tool",
            type: "agent-harness",
            name: "Broken Tool",
            description: "throws on load",
            entry: "index.js",
          },
        }),
      );
      writeFileSync(join(dir, "index.js"), "throw new Error('boom at import');\n");
      try {
        const agent = await mkNode("agent", { json: [entry("broken-tool", true)], at: freshAt() });
        expect(await harnessUsable("broken-tool", agent.id)).toBe(false);
        expect((await usableHarnessIds(agent.id)).has("broken-tool")).toBe(false);
        const report = await effectiveHarnessStates(agent);
        const row = report.harnesses.find((h) => h.harnessId === "broken-tool");
        expect(row).toBeDefined(); // keeps a row…
        expect(row?.broken).toContain("boom at import"); // …saying exactly why
      } finally {
        await uninstallLocalPlugin("broken-tool");
      }
    });

    it("zero-arg and explicit 'local' agree, verbatim", async () => {
      await withStubs({ [H0]: true }, async () => {
        expect(await harnessUsable(H0, "local")).toBe(await harnessUsable(H0));
      });
      expect(await usableHarnessIds("local")).toEqual(await usableHarnessIds());
    });

    it("unknown node / never-reported node → gate answers without a crash", async () => {
      expect(await harnessUsable(H0, crypto.randomUUID())).toBe(false);
      expect(await usableHarnessIds(crypto.randomUUID())).toEqual(new Set());
      const never = await mkNode("agent");
      expect(await harnessUsable(H0, never.id)).toBe(false); // never asked ≠ installed
    });

    it("local gate: installed instance plugin with the binary present is usable, absent is not", async () => {
      await withStubs({ [H0]: true }, async () => {
        expect(await harnessUsable(H0)).toBe(true);
      });
      await withStubs({ [H0]: false }, async () => {
        expect(await harnessUsable(H0)).toBe(false);
        expect((await usableHarnessIds()).has(H0)).toBe(false);
      });
    });
  });

  describe("readAgentInventory", () => {
    it("parses entries and applies the TTL clock", () => {
      const base = { inventoryJson: null, inventoryAt: null } as Pick<NodeTable, "inventoryJson" | "inventoryAt">;
      const mk = (over: Partial<NodeTable>): NodeTable => ({ ...base, ...over }) as NodeTable;

      let inv = readAgentInventory(
        mk({ inventoryJson: JSON.stringify([entry(H0, true, "v")]), inventoryAt: freshAt() }),
      );
      expect(inv.fresh).toBe(true);
      expect(inv.stale).toBe(false);
      expect(inv.entries.get(H0)).toMatchObject({ installed: true, version: "v" });

      inv = readAgentInventory(mk({ inventoryJson: JSON.stringify([entry(H0, true)]), inventoryAt: staleAt() }));
      expect(inv.fresh).toBe(false);
      expect(inv.stale).toBe(true);

      inv = readAgentInventory(mk({}));
      expect(inv.entries.size).toBe(0);
      expect(inv.fresh).toBe(false);

      inv = readAgentInventory(mk({ inventoryJson: JSON.stringify({ nope: true }), inventoryAt: freshAt() }));
      expect(inv.entries.size).toBe(0); // object-not-array junk → empty, never a throw

      inv = readAgentInventory(mk({ inventoryJson: JSON.stringify([{ installed: true }]), inventoryAt: "not-a-date" }));
      expect(inv.entries.size).toBe(0); // entry without harnessId dropped
      expect(inv.fresh).toBe(false); // unparseable timestamp → treat as aged
    });
  });
});
