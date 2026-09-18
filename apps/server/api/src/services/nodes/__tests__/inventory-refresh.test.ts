import { afterEach, describe, expect, it } from "bun:test";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { INVENTORY_TTL_MS } from "@/services/nodes/inventory.js";
import {
  type InventoryRefreshDeps,
  NODE_INVENTORY_REFRESH_MS,
  refreshOnlineNodeInventories,
  setInventoryRefreshDepsForTests,
  startInventoryRefresh,
} from "@/services/nodes/inventory-refresh.js";

/**
 * The periodic half of harness freshness. A node's inventory used to go stale
 * the moment nobody was looking at its page, so a CLI installed on a machine
 * an hour ago was invisible to the launch gate until somebody opened that
 * page. Pinned here: the pass asks every ONLINE agent, skips `local` (whose
 * view probes live on every read), survives a node that throws, takes its
 * online set from the registry seam rather than the database, and runs on a
 * cadence that keeps an online node inside the gate's freshness window.
 */

interface Rec {
  /** Node ids the pass kicked, in order. */
  asked: string[];
  /** Tick callbacks the schedule seam was handed. */
  ticks: (() => void)[];
  /** Periods the schedule seam was handed. */
  every: number[];
  /** Times the stop handle was used. */
  stopped: number;
}

function rec(): Rec {
  return { asked: [], ticks: [], every: [], stopped: 0 };
}

function deps(r: Rec, online: string[], throwsFor: string[] = []): InventoryRefreshDeps {
  return {
    online: () => [...online],
    detect: (nodeId) => {
      if (throwsFor.includes(nodeId)) throw new Error(`detect seam blew up for ${nodeId}`);
      r.asked.push(nodeId);
    },
    schedule: (tick, everyMs) => {
      r.ticks.push(tick);
      r.every.push(everyMs);
      return {
        stop: () => {
          r.stopped++;
        },
      };
    },
  };
}

afterEach(() => {
  setInventoryRefreshDepsForTests(null);
});

describe("NODE_INVENTORY_REFRESH_MS", () => {
  it("is derived from the gate's freshness window, not a number chosen beside it", () => {
    // The launch gate (`api/harness-utils.ts`) counts an agent's cached answer
    // only while it is within INVENTORY_TTL_MS. A refresh period at or above
    // that window leaves an online, healthy node reading as unusable for the
    // remainder of every cycle — which is the one thing this refresh exists to
    // prevent. Half the window also means a single missed pass is survivable.
    expect(NODE_INVENTORY_REFRESH_MS).toBe(INVENTORY_TTL_MS / 2);
    expect(NODE_INVENTORY_REFRESH_MS).toBeLessThan(INVENTORY_TTL_MS);
  });
});

describe("refreshOnlineNodeInventories", () => {
  it("kicks detection once per online agent node", () => {
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, ["n1", "n2", "n3"]));
    expect(refreshOnlineNodeInventories()).toEqual(["n1", "n2", "n3"]);
    expect(r.asked).toEqual(["n1", "n2", "n3"]);
  });

  it("skips `local` — its harnesses are probed live on every read", () => {
    // Structurally `local` can never hold a live socket (the /ws/node upgrade
    // refuses it), so this is the belt to that brace: a registry that somehow
    // carried it must not make the plane send a `detect` that means nothing.
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, [LOCAL_NODE_ID, "n1"]));
    expect(refreshOnlineNodeInventories()).toEqual(["n1"]);
    expect(r.asked).toEqual(["n1"]);
  });

  it("asks nobody when nothing is online, and does not throw", () => {
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, []));
    expect(refreshOnlineNodeInventories()).toEqual([]);
  });

  it("an OFFLINE node is never asked: the pass reads the registry, not the database", () => {
    // `n2` is enrolled but has no live connection, so the registry seam never
    // names it. Taking the set from a `status='online'` query instead would
    // send a command to a socket that is not there on every tick.
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, ["n1"]));
    refreshOnlineNodeInventories();
    expect(r.asked).toEqual(["n1"]);
    expect(r.asked).not.toContain("n2");
  });

  it("one node that throws costs only its own kick", () => {
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, ["n1", "boom", "n3"], ["boom"]));
    expect(() => refreshOnlineNodeInventories()).not.toThrow();
    expect(r.asked).toEqual(["n1", "n3"]);
  });
});

describe("startInventoryRefresh", () => {
  it("arms one interval at the derived cadence and hands back its stop handle", () => {
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, ["n1"]));
    const handle = startInventoryRefresh();
    expect(r.every).toEqual([NODE_INVENTORY_REFRESH_MS]);
    // Nothing is asked at arming time: `setInterval` never fires immediately,
    // which is what keeps the first pass off the boot path. A node that
    // connects during boot is kicked by its own `ready` frame instead.
    expect(r.asked).toEqual([]);
    handle.stop();
    expect(r.stopped).toBe(1);
  });

  it("the tick IS the pass", () => {
    const r = rec();
    setInventoryRefreshDepsForTests(deps(r, ["n1", "n2"]));
    startInventoryRefresh();
    r.ticks[0]?.();
    expect(r.asked).toEqual(["n1", "n2"]);
    r.ticks[0]?.();
    expect(r.asked).toEqual(["n1", "n2", "n1", "n2"]);
  });

  it("a failing pass does not kill the timer — an uncaught throw here would exit the process", () => {
    // `index.ts` installs an uncaughtException handler that calls
    // process.exit(1), and a throw inside a timer callback reaches it. So the
    // tick swallows: a node whose kick blew up must cost a log line, never
    // the server.
    const r = rec();
    const broken: InventoryRefreshDeps = {
      ...deps(r, ["n1"]),
      online: () => {
        throw new Error("registry seam blew up");
      },
    };
    setInventoryRefreshDepsForTests(broken);
    startInventoryRefresh();
    expect(() => r.ticks[0]?.()).not.toThrow();
  });
});
