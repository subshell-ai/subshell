import type {
  JoinInput,
  JoinOutcome,
  NetworkContext,
  NetworkPlugin,
  NetworkPluginEntry,
  NetworkStatus,
  PublishOutcome,
  PublishRefusal,
  RequestGuardSpec,
  SettingsField,
  SubshellManifest,
} from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import type { NetworkDeps } from "@/api/network/network-gate.js";
import type { AgentInstallResult } from "@/services/agent-install.service.js";

/**
 * A network plugin the suites drive, and the deps that make it the only one
 * this process can see.
 *
 * A fake rather than the built-in tailscale plugin, for the reason every
 * installer suite uses one: the real plugin's every answer is a live probe of
 * whatever is on the developer's machine, so a test written against it would
 * pass or fail on whether tailscale happens to be installed. What is under
 * test here is the ROUTE — its gate, its refusal order and its frame order —
 * and those are properties of the route whatever the plugin says.
 */

/** The id every suite here acts on. */
export const FAKE_ID = "test-network";

/** What the fake recorded, so a test can assert what the route asked of it. */
export interface FakeCalls {
  status: number;
  join: JoinInput[];
  publish: number;
  unpublish: number;
  leave: number;
  validate: Record<string, string>[];
}

/** How one fake behaves. Everything has a working default. */
export interface FakeOptions {
  /** What `status()` answers, or a function of the call count. */
  status?: NetworkStatus | (() => NetworkStatus);
  /** Makes `status()` throw, to prove a broken plugin becomes a row and not a 500. */
  statusThrows?: string;
  /** What `join()` answers, or a thrown message. */
  join?: JoinOutcome | { throws: string } | (() => Promise<JoinOutcome>);
  /** What `publish()` answers, or a thrown message. Absent `publish` support: pass `noPublish`. */
  publish?: PublishOutcome | PublishRefusal | { throws: string };
  /**
   * What `requestGuard()` answers, or a thrown message.
   *
   * The guard's ONE source since the outcome stopped carrying one: the route
   * and the boot pass both ask this, so a fixture that set it on the publish
   * outcome was testing a path that no longer exists.
   */
  guard?: RequestGuardSpec | { throws: string };
  /** Drops the `publish` member entirely, as a plugin without the capability would. */
  noPublish?: boolean;
  /** The settings schema the plugin declares. */
  fields?: SettingsField[];
  /** Field problems `validateSettings` reports. */
  issues?: { field: string; message: string }[];
  /** Platforms the manifest claims. Defaults to both. */
  platforms?: ("darwin" | "linux")[];
  /** Exposure the manifest declares. */
  exposure?: "private" | "public-with-gate";
  /** Drops the `install` block, as a plugin whose install needs root must. */
  noInstall?: boolean;
  /** The install command the manifest declares. */
  installCommand?: string;
  /**
   * Set `subshell.network.publishImplicit` on the fake's manifest, as NetBird
   * does. Pairs with `status: { state: "joined" }` + a publish record to
   * exercise the host's publish-state merge.
   */
  publishImplicit?: boolean;
  /**
   * Set `subshell.network.labels` on the fake's manifest, as every built-in
   * does. The row is the SPA's only source for the credential box's name and
   * its Docs link, so a suite asserts the WHOLE block survives the wire —
   * Elysia strips fields a response schema does not declare.
   */
  labels?: { credential?: string; publish?: string; credentialDocsUrl?: string };
}

const DEFAULT_STATUS: NetworkStatus = {
  state: "joined",
  addresses: [{ url: "https://host.example.ts.net", scheme: "https", label: "MagicDNS", secureContext: true }],
  hints: [],
  identity: { network: "example.ts.net", hostname: "host" },
};

/** Builds one fake plugin plus the recorder its calls land in. */
export function makeFakePlugin(options: FakeOptions = {}): { entry: NetworkPluginEntry; calls: FakeCalls } {
  const calls: FakeCalls = { status: 0, join: [], publish: 0, unpublish: 0, leave: 0, validate: [] };

  const plugin: NetworkPlugin = {
    capabilities: () => ["publish", "settings", ...(options.guard ? (["guard"] as const) : [])],
    status: async () => {
      calls.status += 1;
      if (options.statusThrows) throw new Error(options.statusThrows);
      const next = options.status ?? DEFAULT_STATUS;
      return typeof next === "function" ? next() : next;
    },
    join: async (input: JoinInput) => {
      calls.join.push(input);
      const answer = options.join ?? { state: "joined" as const };
      if (typeof answer === "function") return await answer();
      if ("throws" in answer) throw new Error(answer.throws);
      return answer;
    },
    leave: async () => {
      calls.leave += 1;
    },
    unpublish: async () => {
      calls.unpublish += 1;
    },
    settingsFields: () => options.fields ?? [],
    validateSettings: (values) => {
      calls.validate.push(values);
      return options.issues ?? [];
    },
  };

  if (options.guard) {
    const guard = options.guard;
    plugin.requestGuard = (): RequestGuardSpec | null => {
      if ("throws" in guard) throw new Error(guard.throws);
      return guard;
    };
  }

  if (!options.noPublish) {
    plugin.publish = async (_ctx: NetworkContext) => {
      calls.publish += 1;
      const answer = options.publish ?? { addresses: DEFAULT_STATUS.addresses };
      if ("throws" in answer) throw new Error(answer.throws);
      return answer;
    };
  }

  const manifest: SubshellManifest = {
    apiVersion: 2,
    id: FAKE_ID,
    type: "network",
    name: "Test Network",
    description: "A network plugin that exists only in this suite",
    entry: "index.js",
    ...(options.noInstall
      ? {}
      : {
          install: {
            command: options.installCommand ?? "brew install test-network",
            docsUrl: "https://example.invalid/install",
          },
        }),
    network: {
      platforms: options.platforms ?? ["darwin", "linux"],
      interactiveLogin: true,
      exposure: options.exposure ?? "public-with-gate",
      ...(options.publishImplicit ? { publishImplicit: true } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
      privileged: {
        darwin: [{ label: "Install the daemon", command: "sudo test-network install", group: "The daemon" }],
        linux: [{ label: "Enable the service", command: "sudo systemctl enable test-network" }],
      },
    },
  };

  return { entry: { manifest, plugin }, calls };
}

/** The installed-store report the deps report for a fake. */
export function fakeReport(id: string = FAKE_ID): PluginReportWire {
  return {
    id,
    name: "Test Network",
    type: "network",
    version: "1.0.0",
    description: "A network plugin that exists only in this suite",
    capabilities: ["publish", "settings"],
  };
}

/** Every installer the routes asked for, and what the fake runner answered. */
export interface InstallRecorder {
  /** Each argv, in order. The suite asserts the command came from the manifest. */
  calls: string[][];
  /** Lines the fake runner emits before it reports. */
  lines: string[];
  /** What it reports. */
  result: AgentInstallResult;
}

/** An install recorder whose runner succeeds, printing one line. */
export function installRecorder(): InstallRecorder {
  return {
    calls: [],
    lines: ["==> Downloading"],
    result: { ok: true, exitCode: 0, output: "==> Downloading", durationMs: 12 },
  };
}

/**
 * Deps that show the routes exactly one plugin, on darwin, with an installer
 * that records instead of running a package manager.
 */
export function fakeDeps(
  entry: NetworkPluginEntry,
  overrides: Partial<NetworkDeps> & { install?: InstallRecorder } = {},
): NetworkDeps {
  const install = overrides.install;
  const report = fakeReport(entry.manifest.id);
  return {
    plugins: () => [entry],
    installed: async () => [report],
    enabled: async () => [report],
    platform: () => "darwin",
    port: () => 3080,
    // Nothing here spawns: a suite that ran a real package manager would be
    // installing software on whoever ran `bun test`.
    runInstall: async (argv, onLine) => {
      install?.calls.push([...argv]);
      for (const line of install?.lines ?? []) onLine(line);
      return install?.result ?? { ok: true, exitCode: 0, output: "", durationMs: 0 };
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "install")),
  };
}
