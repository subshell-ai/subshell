import { afterEach, describe, expect, it } from "bun:test";
import type { NetworkPlugin, NetworkPluginEntry, SupervisedProcessSpec } from "@internal/pane-runtime";
import { buildNetworkRow } from "@/api/network/network-view.js";
import {
  armProcess,
  processState,
  type SupervisorDeps,
  type SupervisorState,
  setSupervisorDepsForTests,
} from "@/services/network/supervisor.js";

/**
 * The row builder, and the one merge it makes (spec 2026-09-15 § 4.5: for a
 * supervised plugin, "`published` ⇔ the supervisor reports running — the host
 * merges that in").
 *
 * The merge lives HERE rather than in any plugin because the plugin cannot
 * see the supervisor: `NetworkContext` carries the port, the settings and the
 * secret presence, and a plugin that answered `published` from settings alone
 * would claim a publish the moment a token was pasted, with no child running.
 * The host holds `processState` — it is the only side that can say `running`.
 */

const spec: SupervisedProcessSpec = { command: "/usr/bin/cloudflared", args: ["tunnel", "run"] };

/** A child that is simply alive, which is exactly what the merge asks. */
function aliveDeps(): SupervisorDeps {
  return {
    spawn: () => ({
      pid: 4242,
      // Never exits: the case ends by swapping the deps out, which
      // invalidates the entry, and nothing here awaits this promise.
      exited: new Promise<number | null>(() => {}),
      kill: () => {},
    }),
    secretFile: async () => null,
    secretValue: async () => "token-value",
    extraPath: async () => [],
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** A plugin row's subject: the entry a surface would build, and its unique id. */
function subject(plugin: Partial<NetworkPlugin> = {}): { id: string; entry: NetworkPluginEntry } {
  const id = `net-view-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    entry: {
      manifest: {
        id,
        name: "View Fixture",
        description: "a fixture",
        apiVersion: 2,
        type: "network",
        entry: "dist/index.js",
        network: { platforms: ["darwin", "linux"], exposure: "public-with-gate" },
      },
      plugin: {
        capabilities: () => [],
        status: async () => ({ state: "joined", addresses: [], hints: [] }),
        join: async () => ({ state: "joined" }),
        leave: async () => {},
        ...plugin,
      },
    },
  };
}

async function waitState(id: string, predicate: (state: SupervisorState) => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const s = processState(id);
    if (s && predicate(s)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for supervisor state on ${id}`);
}

afterEach(() => {
  // Invalidates every live entry and drops the fake spawn — the same teardown
  // the supervisor's own suite uses.
  setSupervisorDepsForTests(null);
});

describe("buildNetworkRow: the published merge", () => {
  it("promotes a supervised plugin reporting `joined` when its child is running", async () => {
    setSupervisorDepsForTests(aliveDeps());
    const { id, entry } = subject({ supervisedProcess: () => spec });
    armProcess(id, spec);
    // No readyPattern on the spec, so a live child is ready immediately.
    await waitState(id, (s) => s.running);

    const row = await buildNetworkRow(entry, { enabled: true, platform: "darwin" });
    expect(row.status?.state).toBe("published");
    expect(row.process?.running).toBe(true);
    // The plugin's own report survives the merge — only the rung moves. And
    // the merge reads the SUPERVISOR, not the record: this fixture was never
    // published through the route, and that flag is `false` while a running
    // child is the fact being reported.
    expect(row.published).toBe(false);
  });

  it("leaves `joined` alone when the child is armed but not up", async () => {
    // The refused spawn (a relative command the supervisor will not run) is a
    // real state: an admin needs to see `joined` with a process line saying
    // why, not a `published` the tunnel does not have.
    setSupervisorDepsForTests(aliveDeps());
    const { id, entry } = subject({ supervisedProcess: () => spec });
    armProcess(id, { command: "cloudflared", args: [] });
    await waitState(id, (s) => s.lastLines.length > 0);

    const row = await buildNetworkRow(entry, { enabled: true, platform: "darwin" });
    expect(row.status?.state).toBe("joined");
    expect(row.process?.running).toBe(false);
  });

  it("merges nothing for a plugin that describes no supervised process", async () => {
    // Tailscale-style: the plugin READS its daemon and answers its own
    // `published`, and the rung is its to decide. A stray armed child (this
    // class of plugin never has one in production) must not move the rung,
    // because for a plugin that CAN see its daemon, `status()` is the
    // authority; the merge is scoped to the class that cannot see itself.
    setSupervisorDepsForTests(aliveDeps());
    const { id, entry } = subject();
    armProcess(id, spec);
    await waitState(id, (s) => s.running);

    const row = await buildNetworkRow(entry, { enabled: true, platform: "darwin" });
    expect(row.status?.state).toBe("joined");
  });

  it("passes a plugin's own `published` through untouched", async () => {
    setSupervisorDepsForTests(aliveDeps());
    const { entry } = subject({
      supervisedProcess: () => spec,
      status: async () => ({ state: "published", addresses: [], hints: [] }),
    });
    // Deliberately NOT armed: whatever the plugin claimed stands on its own.
    const row = await buildNetworkRow(entry, { enabled: true, platform: "darwin" });
    expect(row.status?.state).toBe("published");
  });
});
