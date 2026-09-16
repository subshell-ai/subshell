import { afterEach, describe, expect, it } from "bun:test";
import type {
  NetworkAddress,
  NetworkHint,
  NetworkPlugin,
  NetworkPluginEntry,
  NetworkState,
  PluginPlatform,
  RequestGuardSpec,
  SupervisedProcessSpec,
} from "@internal/pane-runtime";
import { SERVER_PORT } from "@/constants.js";
import type { OwnedGuard } from "@/plugins/access-guard.plugin.js";
import type { AuditEventInput } from "@/services/audit.js";
import {
  type NetworkPrepareDeps,
  prepareNetworkGuards,
  prepareNetworkProcesses,
  setNetworkPrepareDepsForTests,
} from "@/services/network/prepare.js";
import { readNetworkState, writeNetworkState } from "@/services/network/state.js";

/**
 * Boot, without a database, a plugin registry, or a config.env this suite
 * could damage. Every gate is a REFUSAL to act on someone's machine, so each
 * one is asserted as "nothing was armed" rather than as an error.
 */

const guard: RequestGuardSpec = {
  kind: "cloudflare-access",
  hostname: "subshell.example.com",
  teamDomain: "acme.cloudflareaccess.com",
  aud: "aud-tag",
};

const address: NetworkAddress = {
  url: "https://box.tail.ts.net",
  scheme: "https",
  label: "MagicDNS",
  secureContext: true,
};

const processSpec: SupervisedProcessSpec = { command: "/usr/local/bin/tailscaled", args: ["serve"] };

function entry(
  plugin: Partial<NetworkPlugin>,
  platforms: PluginPlatform[] = ["darwin", "linux"],
  exposure: "private" | "public-with-gate" = "private",
): NetworkPluginEntry {
  return {
    manifest: { network: { platforms, exposure } } as NetworkPluginEntry["manifest"],
    plugin: {
      capabilities: () => [],
      status: async () => ({ state: "published", addresses: [], hints: [] }),
      join: async () => ({ state: "joined" }),
      leave: async () => {},
      ...plugin,
    },
  };
}

interface Recorder {
  warnings: string[];
  armed: { id: string; spec: SupervisedProcessSpec }[];
  guards: OwnedGuard[][];
  audits: AuditEventInput[];
  origins: { id: string; addresses: NetworkAddress[] }[];
}

function recorderDeps(
  recorder: Recorder,
  plugins: Record<string, NetworkPluginEntry | undefined>,
  platform: PluginPlatform = "darwin",
): NetworkPrepareDeps {
  return {
    listPlugins: async () => Object.keys(plugins).map((id) => ({ id })),
    getPlugin: (id) => plugins[id],
    platform: () => platform,
    arm: (id, spec) => recorder.armed.push({ id, spec }),
    setGuards: (specs) => recorder.guards.push(specs),
    audit: async (event) => {
      recorder.audits.push(event);
    },
    trustOrigins: (id, addresses) => recorder.origins.push({ id, addresses }),
    warn: (message) => recorder.warnings.push(message),
  };
}

function recorder(): Recorder {
  return { warnings: [], armed: [], guards: [], audits: [], origins: [] };
}

/** A fresh plugin id per case: `bun test` shares one process and one data dir. */
function id(): string {
  return `net-prepare-${crypto.randomUUID().slice(0, 8)}`;
}

afterEach(() => {
  setNetworkPrepareDepsForTests(null);
});

describe("prepareNetworkGuards", () => {
  it("installs every published plugin's guard in one call", async () => {
    const plugin = id();
    const rec = recorder();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(recorderDeps(rec, { [plugin]: entry({ requestGuard: () => guard }) }));

    await prepareNetworkGuards();
    // One call with the complete set: appending would leave a moment in which
    // one network's traffic was checked and another's was not.
    expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[guard]]);
  });

  it("installs nothing for a plugin that is not published", async () => {
    const plugin = id();
    const rec = recorder();
    setNetworkPrepareDepsForTests(recorderDeps(rec, { [plugin]: entry({ requestGuard: () => guard }) }));

    await prepareNetworkGuards();
    expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[]]);
  });

  it("skips a published plugin whose manifest does not name this platform", async () => {
    const plugin = id();
    const rec = recorder();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(rec, { [plugin]: entry({ requestGuard: () => guard }, ["linux"]) }, "darwin"),
    );

    await prepareNetworkGuards();
    // Manifest DATA, read without loading plugin code: a data directory
    // carried between machines holds publishes for plugins that cannot run.
    expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[]]);
  });

  it("skips a published plugin that will not load", async () => {
    const plugin = id();
    const rec = recorder();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(recorderDeps(rec, { [plugin]: undefined }));

    await prepareNetworkGuards();
    expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[]]);
  });

  it("keeps the other guards when one plugin's requestGuard throws", async () => {
    const good = id();
    const bad = id();
    const rec = recorder();
    await writeNetworkState(good, { published: true, port: SERVER_PORT });
    await writeNetworkState(bad, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(rec, {
        [good]: entry({ requestGuard: () => guard }),
        [bad]: entry({
          requestGuard: () => {
            throw new Error("cannot build a guard");
          },
        }),
      }),
    );

    await prepareNetworkGuards();
    expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[guard]]);
  });
});

describe("prepareNetworkProcesses", () => {
  it("arms the child a published plugin asks for", async () => {
    const plugin = id();
    const rec = recorder();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(recorderDeps(rec, { [plugin]: entry({ supervisedProcess: () => processSpec }) }));

    await prepareNetworkProcesses();
    expect(rec.armed).toEqual([{ id: plugin, spec: processSpec }]);
  });

  it("arms nothing for a plugin that is unpublished, unloadable, or on the wrong platform", async () => {
    const unpublished = id();
    const unloadable = id();
    const wrongPlatform = id();
    const rec = recorder();
    await writeNetworkState(unloadable, { published: true, port: SERVER_PORT });
    await writeNetworkState(wrongPlatform, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(
        rec,
        {
          [unpublished]: entry({ supervisedProcess: () => processSpec }),
          [unloadable]: undefined,
          [wrongPlatform]: entry({ supervisedProcess: () => processSpec }, ["linux"]),
        },
        "darwin",
      ),
    );

    await prepareNetworkProcesses();
    expect(rec.armed).toEqual([]);
  });

  it("does not throw when a plugin's supervisedProcess throws", async () => {
    const plugin = id();
    const rec = recorder();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(rec, {
        [plugin]: entry({
          supervisedProcess: () => {
            throw new Error("the plugin is broken");
          },
        }),
      }),
    );

    // A network plugin is third-party code and must never be why a boot fails.
    await prepareNetworkProcesses();
    expect(rec.armed).toEqual([]);
  });

  describe("the port reconcile", () => {
    it("re-publishes on the running port, arms the new spec, trusts the origin and audits it", async () => {
      const plugin = id();
      const rec = recorder();
      const newSpec: SupervisedProcessSpec = { command: "/usr/local/bin/tailscaled", args: ["serve", "--new"] };
      await writeNetworkState(plugin, { published: true, port: 1234, addresses: [] });
      setNetworkPrepareDepsForTests(
        recorderDeps(rec, {
          [plugin]: entry({
            publish: async (ctx) => {
              // A plugin is given no memory of the port it published on; the
              // context is where it learns the new one.
              expect(ctx.port).toBe(SERVER_PORT);
              return { addresses: [address], process: newSpec };
            },
            unpublish: async () => {},
            supervisedProcess: () => processSpec,
          }),
        }),
      );

      await prepareNetworkProcesses();

      const state = await readNetworkState(plugin);
      expect(state.port).toBe(SERVER_PORT);
      expect(state.addresses).toEqual([address]);
      expect(state.publishedAt).toBeDefined();
      // The outcome's own process wins, and is the ONLY one armed. Arming
      // again from `supervisedProcess` a moment later would stop the child the
      // republish just started and spawn a replacement — so the outcome's
      // process never actually ran, which is the only reason `PublishOutcome`
      // carries a process at all. This assertion previously expected both and
      // said the opposite in its comment.
      expect(rec.armed.map((row) => row.spec)).toEqual([newSpec]);
      expect(rec.origins).toEqual([{ id: plugin, addresses: [address] }]);
      expect(rec.audits).toHaveLength(1);
      expect(rec.audits[0]).toMatchObject({ actorUserId: null, action: "network.publish", targetId: plugin });
      expect(JSON.parse(rec.audits[0].metadataJson ?? "{}")).toMatchObject({
        reason: "port-change",
        from: 1234,
        to: SERVER_PORT,
      });
    });

    it("does not re-publish when the recorded port is the running one", async () => {
      const plugin = id();
      const rec = recorder();
      let published = false;
      await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
      setNetworkPrepareDepsForTests(
        recorderDeps(rec, {
          [plugin]: entry({
            publish: async () => {
              published = true;
              return { addresses: [address] };
            },
            unpublish: async () => {},
          }),
        }),
      );

      await prepareNetworkProcesses();
      expect(published).toBe(false);
      expect(rec.audits).toEqual([]);
    });

    it("leaves the publish standing when the plugin refuses, and audits nothing", async () => {
      const plugin = id();
      const rec = recorder();
      await writeNetworkState(plugin, { published: true, port: 1234 });
      setNetworkPrepareDepsForTests(
        recorderDeps(rec, {
          [plugin]: entry({
            publish: async () => ({ refused: { text: "log in to Tailscale first" } }),
            unpublish: async () => {},
          }),
        }),
      );

      await prepareNetworkProcesses();
      const state = await readNetworkState(plugin);
      // Still the admin's standing decision; what failed is this host's
      // attempt to honour it, and the plugin's own status() says so.
      expect(state.published).toBe(true);
      expect(state.port).toBe(1234);
      expect(rec.audits).toEqual([]);
    });

    it("does not throw when the plugin throws while re-publishing", async () => {
      const plugin = id();
      const rec = recorder();
      await writeNetworkState(plugin, { published: true, port: 1234 });
      setNetworkPrepareDepsForTests(
        recorderDeps(rec, {
          [plugin]: entry({
            publish: async () => {
              throw new Error("the vendor API is down");
            },
            unpublish: async () => {},
            supervisedProcess: () => processSpec,
          }),
        }),
      );

      await prepareNetworkProcesses();
      expect((await readNetworkState(plugin)).published).toBe(true);
      // The process is still armed: a failed republish is not a reason to also
      // have no tunnel process at all.
      expect(rec.armed).toEqual([{ id: plugin, spec: processSpec }]);
      expect(rec.audits).toEqual([]);
    });

    it("re-installs the guard set after a republish", async () => {
      const plugin = id();
      const rec = recorder();
      await writeNetworkState(plugin, { published: true, port: 1234 });
      setNetworkPrepareDepsForTests(
        recorderDeps(rec, {
          [plugin]: entry({
            publish: async () => ({ addresses: [address], guard }),
            unpublish: async () => {},
            requestGuard: () => guard,
          }),
        }),
      );

      await prepareNetworkProcesses();
      // A republish can produce a different hostname or Access application, so
      // everyone is re-asked rather than reasoning about whose changed.
      expect(rec.guards.map((set) => set.map((g) => g.spec))).toEqual([[guard]]);
    });
  });
});

describe("a public exposure may not run unguarded", () => {
  /** A published plugin wired through the recorder deps, ready to prepare. */
  async function publish(rec: Recorder, e: NetworkPluginEntry): Promise<void> {
    const plugin = id();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(recorderDeps(rec, { [plugin]: e }));
  }

  it("does not arm the tunnel of a public-with-gate plugin whose guard threw", async () => {
    // These are different methods over different data: a Cloudflare-shaped
    // plugin needs a hostname and an audience for its guard but only a token
    // for its process, so an admin clearing one settings field produces
    // exactly this. Starting the tunnel anyway is worse than the network being
    // down — the server is reachable from the internet and unchecked.
    const rec = recorder();
    await publish(
      rec,
      entry(
        {
          requestGuard: () => {
            throw new Error("hostname is not configured");
          },
          supervisedProcess: () => processSpec,
        },
        ["darwin", "linux"],
        "public-with-gate",
      ),
    );
    await prepareNetworkGuards();
    await prepareNetworkProcesses();
    expect(rec.guards.at(-1)).toEqual([]);
    expect(rec.armed).toEqual([]);
  });

  it("does not arm it when the guard is merely absent either", async () => {
    // The same hole by omission rather than by throw.
    const rec = recorder();
    await publish(
      rec,
      entry(
        { requestGuard: () => null, supervisedProcess: () => processSpec },
        ["darwin", "linux"],
        "public-with-gate",
      ),
    );
    await prepareNetworkGuards();
    await prepareNetworkProcesses();
    expect(rec.armed).toEqual([]);
  });

  it("still arms a PRIVATE network that describes no guard", async () => {
    // The refusal is scoped to the exposure that makes a guard the perimeter.
    // Tailscale describes no guard and must still start.
    const rec = recorder();
    await publish(rec, entry({ supervisedProcess: () => processSpec }));
    await prepareNetworkGuards();
    await prepareNetworkProcesses();
    expect(rec.armed.map((a) => a.spec)).toEqual([processSpec]);
  });
});

describe("a published network that is not actually up", () => {
  /** A published plugin whose status is whatever the case needs. */
  async function published(rec: Recorder, state: NetworkState, hints: NetworkHint[] = []): Promise<void> {
    const plugin = id();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(rec, {
        [plugin]: entry({ status: async () => ({ state, addresses: [], hints }) }),
      }),
    );
  }

  it("says so when the vendor's daemon did not come back", async () => {
    // The realistic failure and the one nothing else catches: the machine
    // rebooted, this server came back, the daemon did not. The published
    // addresses still resolve and nothing answers at them.
    const rec = recorder();
    await published(rec, "daemon-down", [{ text: "Tailscale is installed but its daemon is not running." }]);
    await prepareNetworkProcesses();
    expect(rec.warnings.some((w) => w.includes("not reachable") && w.includes("daemon is not running"))).toBe(true);
  });

  it("distinguishes on-the-network-but-not-serving from not-up-at-all", async () => {
    // `joined` is a different sentence and a different remedy: the machine is
    // fine and the serve was reset, so re-publishing fixes it.
    const rec = recorder();
    await published(rec, "joined");
    await prepareNetworkProcesses();
    expect(rec.warnings.some((w) => w.includes("NOT publishing"))).toBe(true);
  });

  it("says nothing about a network that is up", async () => {
    // A boot that reports a problem every time is a boot nobody reads.
    const rec = recorder();
    await published(rec, "published");
    await prepareNetworkProcesses();
    expect(rec.warnings).toEqual([]);
  });

  it("does not let a throwing status stop the boot", async () => {
    const rec = recorder();
    const plugin = id();
    await writeNetworkState(plugin, { published: true, port: SERVER_PORT });
    setNetworkPrepareDepsForTests(
      recorderDeps(rec, {
        [plugin]: entry({
          status: async () => {
            throw new Error("the CLI is gone");
          },
        }),
      }),
    );
    await expect(prepareNetworkProcesses()).resolves.toBeUndefined();
  });
});
