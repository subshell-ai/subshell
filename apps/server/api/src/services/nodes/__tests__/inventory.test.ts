import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { allHarnesses } from "@internal/pane-runtime";
import { harnessUsable, usableHarnessIds } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
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

  /**
   * A node row. For an agent, the inventory's harness ids are ALSO recorded as
   * its declaration: since phase 2 a plugin is offered only when the node says
   * it has it installed, so an inventory alone means "offers nothing".
   */
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
    if (kind === "agent" && inv) {
      const ids = inv.json
        .map((e) => (e as { harnessId?: string }).harnessId)
        .filter((h): h is string => typeof h === "string");
      await nodes.recordPluginReport(
        id,
        ids.map((h) => ({
          id: h,
          name: h,
          type: "agent-harness",
          version: "1.0.0",
          description: "",
          capabilities: [],
        })),
      );
    }
    return (await nodes.findById(id)) as NodeTable;
  }

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    for (const id of createdNodeIds) await nodes.deleteById(id);
  });

  describe("effectiveHarnessStates (agent)", () => {
    it("lists what the NODE declared, crossed with its inventory; junk JSON reads empty", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });

      const report = await effectiveHarnessStates(node);
      expect(report.stale).toBe(false);
      // One row per DECLARED plugin, not one per plugin this server was built
      // with: a node can have a plugin this build has never heard of.
      expect(report.harnesses.length).toBe(2);

      // `enabled` is true for every row that exists: the node declaring a
      // plugin IS it being offered there. The only false-ish state left is a
      // plugin the node did not declare, which has no row at all.
      const e0 = report.harnesses.find((h) => h.harnessId === H0);
      expect(e0).toMatchObject({ enabled: true, installed: true, version: "9.9.9" });
      const e1 = report.harnesses.find((h) => h.harnessId === H1);
      expect(e1).toMatchObject({ enabled: true, installed: false });
      expect(e1?.version).toBeUndefined();
      // Undeclared: absent, not a row saying "off".
      expect(report.harnesses.find((h) => h.harnessId === H2)).toBeUndefined();
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
    it("harness_plugins state × live probe, with the version, reason and stamp an agent reports", async () => {
      const node = await mkNode("local");
      // The local branch probes through `scanOne`, so `detect` is what has to
      // be stubbed. It used to stub `isInstalled`, which `scanOne` no longer
      // calls at all — a stub on it would silently probe the real machine.
      const stubs = allHarnesses().map((h) => ({
        h,
        detect: h.detect.bind(h),
        getVersion: h.getVersion.bind(h),
        versionAt: h.versionAt.bind(h),
      }));
      const prior = (await new HarnessPluginsRepository(db).getEnabledStates([H0])).get(H0);
      const found: Record<string, boolean> = { [H0]: true, [H1]: false };
      for (const s of stubs) {
        s.h.detect = async () =>
          found[s.h.id] ? { path: `/usr/bin/${s.h.id}` } : { path: null, reason: "override-invalid" as const };
        s.h.getVersion = async () => "7.7.7";
        s.h.versionAt = async () => "7.7.7";
      }
      await new HarnessPluginsRepository(db).setEnabled(H0, false);
      try {
        const report = await effectiveHarnessStates(node);
        expect(report.stale).toBe(false);

        const e0 = report.harnesses.find((h) => h.harnessId === H0);
        // Local now carries a version too. It used not to, which meant the
        // node page showed one for an agent and nothing for the host.
        expect(e0).toMatchObject({ enabled: false, installed: true, version: "7.7.7" });
        expect(e0?.reason).toBeUndefined();
        expect(typeof e0?.checkedAt).toBe("string");

        const e1 = report.harnesses.find((h) => h.harnessId === H1);
        expect(e1).toMatchObject({ enabled: true, installed: false, reason: "override-invalid" });
        expect(e1?.version).toBeUndefined();
      } finally {
        for (const s of stubs) {
          s.h.detect = s.detect;
          s.h.getVersion = s.getVersion;
          s.h.versionAt = s.versionAt;
        }
        if (prior === undefined) await db.deleteFrom("harnessPlugins").where("id", "=", H0).execute();
        else await new HarnessPluginsRepository(db).setEnabled(H0, prior);
      }
    });

    it("gives every local entry one shared stamp", async () => {
      const node = await mkNode("local");
      const report = await effectiveHarnessStates(node);
      const stamps = new Set(report.harnesses.map((h) => h.checkedAt));
      expect(stamps.size).toBe(1);
    });
  });

  describe("effectiveHarnessStates carries detection facts from an agent inventory", () => {
    it("passes reason and checkedAt straight through", async () => {
      const node = await mkNode("agent", {
        json: [{ harnessId: H0, installed: false, reason: "override-invalid", checkedAt: "2026-09-09T12:00:00.000Z" }],
        at: freshAt(),
      });
      const e0 = (await effectiveHarnessStates(node)).harnesses.find((h) => h.harnessId === H0);
      expect(e0?.reason).toBe("override-invalid");
      expect(e0?.checkedAt).toBe("2026-09-09T12:00:00.000Z");
    });

    it("reports neither for an agent too old to send them", async () => {
      const node = await mkNode("agent", { json: [entry(H0, true, "1.0")], at: freshAt() });
      const e0 = (await effectiveHarnessStates(node)).harnesses.find((h) => h.harnessId === H0);
      // Absent is unknown, never a default that asserts something false.
      expect(e0?.reason).toBeUndefined();
      expect(e0?.checkedAt).toBeUndefined();
    });
  });

  describe("harnessUsable / usableHarnessIds with a nodeId", () => {
    it("zero-arg and explicit 'local' agree, verbatim", async () => {
      for (const h of allHarnesses()) {
        expect(await harnessUsable(h.id, "local")).toBe(await harnessUsable(h.id));
      }
      expect(await usableHarnessIds("local")).toEqual(await usableHarnessIds());
    });

    it("agent gate is STRICT: declared ∧ installed ∧ FRESH snapshot", async () => {
      // The enable table is gone. A plugin is offered because the NODE has it
      // installed, so the gate's first condition is the node's declaration
      // rather than a row this server owned.
      const node = await mkNode("agent", { json: [entry(H0, true), entry(H1, false)], at: freshAt() });

      expect(await harnessUsable(H0, node.id)).toBe(true);
      expect(await harnessUsable(H1, node.id)).toBe(false); // declared, binary absent
      expect(await harnessUsable(H2, node.id)).toBe(false); // not declared at all

      // Undeclaring it is what "disable" became: the node no longer says it
      // has the plugin, so the gate refuses even a fresh installed report.
      await nodes.recordPluginReport(node.id, []);
      const undeclared = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable(H0, undeclared.id)).toBe(false);
      await nodes.recordPluginReport(node.id, [
        { id: H0, name: H0, type: "agent-harness", version: "1.0.0", description: "", capabilities: [] },
      ]);

      // Aged snapshot: the gate flips to false even though the view still
      // reports installed=true — the two paths are deliberately separate.
      await db.updateTable("nodes").set({ inventoryAt: staleAt() }).where("id", "=", node.id).execute();
      const aged = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable(H0, aged.id)).toBe(false);
      const report = await effectiveHarnessStates(aged);
      expect(report.harnesses.find((h) => h.harnessId === H0)?.installed).toBe(true);
      expect(report.stale).toBe(true);
    });

    it("the two gates AGREE on a plugin this build has never heard of", async () => {
      // The point of the phase: a node may offer a plugin the control plane
      // does not carry. `harnessUsable` used to short-circuit on the compiled
      // registry, so the picker (usableHarnessIds) offered such a plugin and
      // the launch then refused it with nothing on screen explaining why.
      const node = await mkNode("agent", { json: [entry("third-party-tool", true)], at: freshAt() });
      await nodes.recordPluginReport(node.id, [
        {
          id: "third-party-tool",
          name: "Third Party Tool",
          type: "agent-harness",
          version: "1.0.0",
          description: "",
          capabilities: [],
        },
      ]);
      const fresh = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable("third-party-tool", fresh.id)).toBe(true);
      expect(await usableHarnessIds(fresh.id)).toEqual(new Set(["third-party-tool"]));
    });

    it("both gates refuse a declared plugin the node reported BROKEN", async () => {
      const node = await mkNode("agent", { json: [entry("broken-tool", true)], at: freshAt() });
      await nodes.recordPluginReport(node.id, [
        {
          id: "broken-tool",
          name: "Broken Tool",
          type: "agent-harness",
          version: "1.0.0",
          description: "",
          capabilities: [],
          broken: "boom at import",
        },
      ]);
      const fresh = (await nodes.findById(node.id)) as NodeTable;
      expect(await harnessUsable("broken-tool", fresh.id)).toBe(false);
      expect(await usableHarnessIds(fresh.id)).toEqual(new Set());
    });

    it("agent gate: a node that has never reported is NOT usable", async () => {
      // Never-reported is not "offers everything" and not "offers nothing
      // deliberately": it is a node that has not been asked, and launching
      // there would be a guess.
      const node = await mkNode("agent");
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
      // Declared: H0 and H3. H1's binary is installed but the node does not
      // say it has the plugin, which is what "disabled" became.
      await nodes.recordPluginReport(node.id, [
        { id: H0, name: H0, type: "agent-harness", version: "1.0.0", description: "", capabilities: [] },
        { id: H3, name: H3, type: "agent-harness", version: "1.0.0", description: "", capabilities: [] },
      ]);
      const declared = (await nodes.findById(node.id)) as NodeTable;
      expect(await usableHarnessIds(declared.id)).toEqual(new Set([H0, H3]));
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
