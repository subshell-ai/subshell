import { afterEach, describe, expect, it } from "bun:test";
import type { NetworkPlugin, NetworkPluginEntry, RequestGuardSpec } from "@internal/pane-runtime";
import { readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { setUnpublishDepsForTests, unpublishNetwork } from "@/services/network/unpublish.js";

/**
 * The ORDER is the subject: stop, tell the plugin, drop the guard, record. A
 * recording fake is what makes it assertable — every other way of checking
 * this observes the END state, which is identical whichever order produced it.
 */

const guard: RequestGuardSpec = {
  kind: "cloudflare-access",
  hostname: "subshell.example.com",
  teamDomain: "acme.cloudflareaccess.com",
  aud: "aud-tag",
};

/** One guard already installed, owned by the plugin a case will unpublish. */
function installed(pluginId: string): Recorder {
  return { calls: [], guards: [{ pluginId, spec: guard }] };
}

interface Recorder {
  calls: string[];
  /** Owned pairs, because ownership is what removal keys on now. */
  guards: { pluginId: string; spec: RequestGuardSpec }[];
}

function deps(recorder: Recorder, plugin: Partial<NetworkPlugin> = {}, failDisarm = false) {
  const entry: NetworkPluginEntry = {
    manifest: {} as NetworkPluginEntry["manifest"],
    plugin: {
      capabilities: () => ["publish", "guard"],
      status: async () => ({ state: "published", addresses: [], hints: [] }),
      join: async () => ({ state: "joined" }),
      leave: async () => {},
      publish: async () => ({ addresses: [] }),
      unpublish: async () => {
        recorder.calls.push("plugin.unpublish");
      },
      requestGuard: () => guard,
      ...plugin,
    },
  };
  return {
    getPlugin: () => entry,
    disarm: async () => {
      if (failDisarm) throw new Error("the child would not die");
      recorder.calls.push("disarm");
    },
    lastLines: () => ["tunnel: connection refused"],
    setPluginGuards: (pluginId: string, specs: RequestGuardSpec[]) => {
      recorder.calls.push("setGuards");
      recorder.guards = [
        ...recorder.guards.filter((owned) => owned.pluginId !== pluginId),
        ...specs.map((spec) => ({ pluginId, spec })),
      ];
    },
  };
}

afterEach(() => {
  setUnpublishDepsForTests(null);
});

describe("unpublishNetwork", () => {
  it("stops the process, tells the plugin, drops the guard, then records — in that order", async () => {
    const recorder = installed("tailscale");
    setUnpublishDepsForTests(deps(recorder));
    await writeNetworkState("tailscale", {
      published: true,
      port: 3080,
      addresses: [{ url: "https://box.ts.net", scheme: "https", label: "MagicDNS", secureContext: true }],
    });

    expect(await unpublishNetwork("tailscale")).toEqual({ ok: true });
    // Guard-off LAST: any other order leaves a window in which a live tunnel
    // reaches an unguarded server.
    expect(recorder.calls).toEqual(["disarm", "plugin.unpublish", "setGuards"]);
    expect(recorder.guards).toEqual([]);

    const state = await readNetworkState("tailscale");
    expect(state).toMatchObject({ published: false, port: null, addresses: [] });
  });

  it("refuses when the process will not stop, leaving the guard in place", async () => {
    const recorder = installed("tailscale-stuck");
    setUnpublishDepsForTests(deps(recorder, {}, true));
    await writeNetworkState("tailscale-stuck", { published: true, port: 3080 });

    const result = await unpublishNetwork("tailscale-stuck");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("guard is still in place");
    expect(result.lastLines).toEqual(["tunnel: connection refused"]);
    // A process that would not die is a publish that is still live: nothing
    // downstream may be unwound around it.
    expect(recorder.calls).toEqual([]);
    expect(recorder.guards).toEqual([{ pluginId: "tailscale-stuck", spec: guard }]);
    expect((await readNetworkState("tailscale-stuck")).published).toBe(true);
  });

  it("still drops the guard and records when the plugin's own unpublish throws", async () => {
    const recorder = installed("tailscale-vendor");
    setUnpublishDepsForTests(
      deps(recorder, {
        unpublish: async () => {
          throw new Error("the vendor API said no");
        },
      }),
    );
    await writeNetworkState("tailscale-vendor", { published: true, port: 3080 });

    expect(await unpublishNetwork("tailscale-vendor")).toEqual({ ok: true });
    // The vendor's side may have leftovers an operator can see; everything
    // local is already safe, and believing we are still published would be
    // worse than the leftover.
    expect(recorder.guards).toEqual([]);
    expect((await readNetworkState("tailscale-vendor")).published).toBe(false);
  });

  it("removes only its OWN guard, leaving another plugin's alone", async () => {
    const other: RequestGuardSpec = { ...guard, hostname: "other.example.com" };
    const recorder: Recorder = {
      calls: [],
      guards: [
        { pluginId: "someone-else", spec: other },
        { pluginId: "tailscale-two", spec: guard },
      ],
    };
    setUnpublishDepsForTests(deps(recorder));
    await writeNetworkState("tailscale-two", { published: true, port: 3080 });

    await unpublishNetwork("tailscale-two");
    expect(recorder.guards).toEqual([{ pluginId: "someone-else", spec: other }]);
  });

  it("removes the guard even when the plugin can no longer describe one", async () => {
    // This used to be the opposite assertion, and the change is the point.
    // Removal identified a guard by RECOMPUTING it and comparing values, so a
    // plugin that could no longer build one — or that now built a different
    // one, which a settings write while published is enough to cause — left
    // the installed guard standing with nothing able to take it down. Keyed by
    // the owner the host already knows, removal cannot miss.
    const recorder: Recorder = { calls: [], guards: [{ pluginId: "tailscale-broken", spec: guard }] };
    setUnpublishDepsForTests(
      deps(recorder, {
        requestGuard: () => {
          throw new Error("cannot build a guard");
        },
      }),
    );
    await writeNetworkState("tailscale-broken", { published: true, port: 3080 });

    expect(await unpublishNetwork("tailscale-broken")).toEqual({ ok: true });
    expect(recorder.guards).toEqual([]);
    expect((await readNetworkState("tailscale-broken")).published).toBe(false);
  });
});
