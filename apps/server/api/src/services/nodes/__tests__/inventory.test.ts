import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "@internal/harnesses";
import { harnessUsable, usableHarnessIds } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { effectiveHarnessStates, INVENTORY_TTL_MS, readAgentInventory } from "../inventory.js";

/**
 * Task 10 (spec 2026-08-31 §6.2) resolution rules:
 * - the VIEW (effectiveHarnessStates) is informational: stale inventory still
 *   reports its installed values, flagged per-node via `stale`;
 * - the GATE (harnessUsable with an agent nodeId) is strict: only a FRESH
 *   (≤ 10-min TTL) snapshot that says installed makes a harness usable.
 */

const H0 = "claude-code";
const H1 = "opencode";
const H2 = "hermes";
const H3 = "pi";

const nodes = new NodesRepository(db);
const nodeHarnesses = new NodeHarnessesRepository(db);
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

  async function mkNode(kind: "local" | "agent", inv?: { json: unknown[]; at: string | null }): Promise<NodeTable> {
    const id = kind === "local" ? `local-${crypto.randomUUID().slice(0, 8)}` : crypto.randomUUID();
    await nodes.create({
      id,
      ownerUserId: OWNER,
      name: `inv-${id.slice(0, 8)}`,
      kind,
      status: "offline",
      ...(inv ? { inventoryJson: JSON.stringify(inv.json), inventoryAt: inv.at } : {}),
    });
    createdNodeIds.push(id);
    return (await nodes.findById(id)) as NodeTable;
  }

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    for (const id of createdNodeIds) await nodes.deleteById(id);
  });

  describe("effectiveHarnessStates (agent)", () => {
    it("merges inventory × per-node rows; defaults where no row/entry; junk JSON reads empty", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });
      await nodeHarnesses.setEnabled(node.id, H0, false);

      const report = await effectiveHarnessStates(node);
      expect(report.stale).toBe(false);
      expect(report.harnesses.length).toBe(ALL_HARNESSES.length);

      const e0 = report.harnesses.find((h) => h.harnessId === H0);
      expect(e0).toMatchObject({ enabled: false, installed: true, version: "9.9.9" });
      const e1 = report.harnesses.find((h) => h.harnessId === H1);
      expect(e1).toMatchObject({ enabled: true, installed: false });
      expect(e1?.version).toBeUndefined();
      const e2 = report.harnesses.find((h) => h.harnessId === H2);
      expect(e2).toMatchObject({ enabled: true, installed: false }); // no row → plugin default; no entry → false
    });

    it("stale rule: fresh=false, aged=true (values still reported), absent=true", async () => {
      const fresh = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      expect((await effectiveHarnessStates(fresh)).stale).toBe(false);

      const aged = await mkNode("agent", { json: [entry(H0, true, "2.0")], at: staleAt() });
      const agedReport = await effectiveHarnessStates(aged);
      expect(agedReport.stale).toBe(true);
      expect(agedReport.harnesses.find((h) => h.harnessId === H0)).toMatchObject({ installed: true, version: "2.0" });

      const never = await mkNode("agent");
      const neverReport = await effectiveHarnessStates(never);
      expect(neverReport.stale).toBe(true);
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
  });

  describe("effectiveHarnessStates (local)", () => {
    it("harness_plugins state × live probe; never stale; no version", async () => {
      const node = await mkNode("local");
      const stubs = ALL_HARNESSES.map((h) => ({ h, orig: h.isInstalled.bind(h) }));
      const prior = (await new HarnessPluginsRepository(db).getEnabledStates([H0])).get(H0);
      // The local branch probes via the plugin registry — force two states:
      const probeTargets: Record<string, boolean> = { [H0]: true, [H1]: false };
      for (const s of stubs) s.h.isInstalled = async () => probeTargets[s.h.id] ?? false;
      await new HarnessPluginsRepository(db).setEnabled(H0, false);
      try {
        const report = await effectiveHarnessStates(node);
        expect(report.stale).toBe(false);
        const e0 = report.harnesses.find((h) => h.harnessId === H0);
        expect(e0).toMatchObject({ enabled: false, installed: true });
        expect(e0?.version).toBeUndefined(); // local entries carry no version (setup GET owns that probe)
        const e1 = report.harnesses.find((h) => h.harnessId === H1);
        expect(e1).toMatchObject({ enabled: true, installed: false });
      } finally {
        for (const s of stubs) s.h.isInstalled = s.orig;
        if (prior === undefined) await db.deleteFrom("harnessPlugins").where("id", "=", H0).execute();
        else await new HarnessPluginsRepository(db).setEnabled(H0, prior);
      }
    });
  });

  describe("harnessUsable / usableHarnessIds with a nodeId", () => {
    it("zero-arg and explicit 'local' agree, verbatim", async () => {
      for (const h of ALL_HARNESSES) {
        expect(await harnessUsable(h.id, "local")).toBe(await harnessUsable(h.id));
      }
      expect(await usableHarnessIds("local")).toEqual(await usableHarnessIds());
    });

    it("agent gate is STRICT: installed ∧ enabled ∧ FRESH snapshot", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true), entry(H1, false)], at: freshAt() });
      await nodeHarnesses.setEnabled(node.id, H0, true);
      await nodeHarnesses.setEnabled(node.id, H1, true);

      expect(await harnessUsable(H0, node.id)).toBe(true);
      expect(await harnessUsable(H1, node.id)).toBe(false); // explicit not-installed
      expect(await harnessUsable(H2, node.id)).toBe(false); // no entry → unknown → not usable

      // Disable overrides an installed+fresh report.
      await nodeHarnesses.setEnabled(node.id, H0, false);
      expect(await harnessUsable(H0, node.id)).toBe(false);
      await nodeHarnesses.setEnabled(node.id, H0, true);

      // Aged snapshot: the gate flips to false even though the view still
      // reports installed=true — the two paths are deliberately separate.
      await db.updateTable("nodes").set({ inventoryAt: staleAt() }).where("id", "=", node.id).execute();
      const aged = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable(H0, aged.id)).toBe(false);
      const report = await effectiveHarnessStates(aged);
      expect(report.harnesses.find((h) => h.harnessId === H0)?.installed).toBe(true);
      expect(report.stale).toBe(true);
    });

    it("agent gate: never-reported inventory is NOT usable (leniency is only on the enable WRITE)", async () => {
      const node = await mkNode("agent");
      await nodeHarnesses.setEnabled(node.id, H0, true);
      expect(await harnessUsable(H0, node.id)).toBe(false);
    });

    it("unknown node / non-plugin id / local-kind row → gate answers without a crash", async () => {
      expect(await harnessUsable(H0, crypto.randomUUID())).toBe(false);
      const node = await mkNode("agent", { json: [entry(H0, true)], at: freshAt() });
      expect(await harnessUsable("no-such-harness", node.id)).toBe(false);
    });

    it("usableHarnessIds(nodeId) computes the whole agent gate in one pass", async () => {
      const node = await mkNode("agent", {
        json: [entry(H0, true), entry(H1, true), entry(H3, true)],
        at: freshAt(),
      });
      await nodeHarnesses.setEnabled(node.id, H0, true);
      await nodeHarnesses.setEnabled(node.id, H1, false); // disabled despite installed
      await nodeHarnesses.setEnabled(node.id, H3, true); // enabled + installed
      // H2: enabled by default, NO inventory entry → excluded (strict).
      expect(await usableHarnessIds(node.id)).toEqual(new Set([H0, H3]));
      expect(await usableHarnessIds(crypto.randomUUID())).toEqual(new Set());
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
