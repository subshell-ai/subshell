import { describe, expect, it } from "bun:test";
import type { NetworkContext, NetworkPlugin, PluginHost, RunOptions, RunResult } from "@subshell-ai/plugin-api";
import { createScriptedHost, createTestHost } from "@subshell-ai/plugin-api/testing";
import { peerIpv4 } from "../cli.js";
import createPlugin, { manifest } from "../index.js";

/** The port the host says this server listens on. Every address uses it. */
const PORT = 3080;

/** A context with no settings and no secrets — the plain hosted-NetBird case. */
const CTX: NetworkContext = { port: PORT, settings: {}, secrets: { has: () => false } };

/** The context a self-hosted operator gets once they have saved a management URL. */
const SELF_HOSTED: NetworkContext = {
  port: PORT,
  settings: { managementUrl: "https://master.netbird.example.com" },
  secrets: { has: () => false },
};

/**
 * A realistic `netbird status --json` for an enrolled machine.
 *
 * Kept whole rather than minimal because two fields only bite in their real
 * form: `fqdn` carries a trailing dot DNS requires and a URL must not have, and
 * the version lives under `netbirdVersion` here so the reader can be shown
 * trying that spelling.
 */
const CONNECTED = JSON.stringify({
  management: { connected: true, lastConnection: "2026-09-16T00:00:00Z" },
  signal: { connected: true },
  relay: { connected: true },
  peerIP: "100.64.0.5",
  fqdn: "workshop.netbird.cloud.",
  hostname: "workshop",
  netbirdVersion: "0.76.1",
  peersTotalNum: 2,
});

/** The same machine on the `netbirdIp` + plain `version` spellings, and no FQDN. */
const CONNECTED_IP_ONLY = JSON.stringify({
  management: { connected: true },
  netbirdIp: "100.64.0.9",
  hostname: "box",
  version: "0.80.0",
});

/** Installed and running, but this machine has not been enrolled yet. */
const NOT_CONNECTED = JSON.stringify({
  management: { connected: false },
  hostname: "workshop",
  netbirdVersion: "0.76.1",
});

/**
 * The shape a LIVE NetBird answers with — transcribed from a real
 * `netbird status --json` on 0.66.4 (measured 2026-09-16).
 *
 * Real in every spelling that matters, because each one is a defect the guessed
 * shapes did not catch: the IP is CIDR-suffixed (`netbirdIp` carries `/16`), the
 * version lives in `daemonVersion`/`cliVersion`, there is NO `hostname` key, and
 * this FQDN carries no trailing dot. Noise the readers ignore (`dnsServers`,
 * `peers`) rides along so nobody quietly shrinks this back to the minimal shape.
 */
const MEASURED_0_66_4 = JSON.stringify({
  cliVersion: "0.66.4",
  daemonVersion: "0.66.4",
  management: { url: "https://controller.example.com:443", connected: true, error: "" },
  signal: { url: "https://controller.example.com:443", connected: true, error: "" },
  netbirdIp: "100.71.129.37/16",
  publicKey: "6h475w1aTAm8+TLmPy1D7qWWdISYdlpffSKvEhzwOGw=",
  usesKernelInterface: false,
  fqdn: "studio.example.internal",
  dnsServers: [{ servers: ["8.8.8.8:53", "8.8.4.4:53"], domains: null, enabled: true, error: "" }],
  peers: { total: 14, connected: 7 },
});

/** Builds the plugin over a scripted host, and hands back both so calls can be asserted. */
function scripted(
  answers: Record<string, Partial<RunResult>>,
  over: Partial<PluginHost> = {},
): { plugin: NetworkPlugin; host: PluginHost & { calls: string[][] } } {
  const host = createScriptedHost(answers, over);
  return { plugin: createPlugin(host) as NetworkPlugin, host };
}

/** The argv lines the plugin issued, joined, so a test can assert order and shape. */
function lines(host: { calls: string[][] }): string[] {
  return host.calls.map((argv) => argv.join(" "));
}

/** A recording host that also captures each run's options. */
function recording(
  answers: Record<string, Partial<RunResult>>,
  over: Partial<PluginHost> = {},
): {
  plugin: NetworkPlugin;
  host: PluginHost & { calls: string[][] };
  runs: { argv: string[]; env?: RunOptions["env"] }[];
} {
  const host = createScriptedHost(answers, over);
  const runs: { argv: string[]; env?: RunOptions["env"] }[] = [];
  const inner = host.run;
  host.run = async (argv, opts) => {
    runs.push({ argv: [...argv], ...(opts?.env ? { env: opts.env } : {}) });
    return inner(argv, opts);
  };
  return { plugin: createPlugin(host) as NetworkPlugin, host, runs };
}

describe("peerIpv4", () => {
  it("drops the subnet suffix the daemon actually sends", () => {
    // Measured on 0.66.4: the top-level `netbirdIp` is "100.71.129.37/16". A
    // CIDR-suffixed value is not a URL host, so the prefix comes off before the
    // IPv4 test — and this is the spelling the live daemon uses, not a fallback.
    expect(peerIpv4({ netbirdIp: "100.71.129.37/16" })).toBe("100.71.129.37");
  });

  it("still takes a bare address", () => {
    expect(peerIpv4({ netbirdIp: "100.64.0.9" })).toBe("100.64.0.9");
  });

  it("refuses an IPv6 address, a missing prefix and a non-numeric one", () => {
    // Stripping the suffix must not turn garbage into an address. `::1/128` is
    // IPv6 (needs brackets in a URL, so it was never wanted here); a bare slash
    // or letters after it are not a prefix length.
    expect(peerIpv4({ netbirdIp: "::1/128" })).toBeNull();
    expect(peerIpv4({ netbirdIp: "100.71.129.37/" })).toBeNull();
    expect(peerIpv4({ netbirdIp: "100.71.129.37/x" })).toBeNull();
    expect(peerIpv4({ netbirdIp: "" })).toBeNull();
  });

  it("keeps the candidate order when the measured spelling is the second one", () => {
    expect(peerIpv4({ peerIP: "100.64.0.5", netbirdIp: "100.71.129.37/16" })).toBe("100.64.0.5");
  });
});

describe("netbird manifest", () => {
  it("declares its identity and network facts as DATA, not in code", () => {
    expect(manifest.id).toBe("netbird");
    expect(manifest.type).toBe("network");
    expect(manifest.name).toBe("NetBird");
    expect(manifest.icon).toBe("icon.png");
    expect(manifest.network?.platforms).toEqual(["darwin", "linux"]);
    expect(manifest.network?.exposure).toBe("private");
    expect(manifest.network?.interactiveLogin).toBe(true);
    // The publish leaves no daemon-side handle — its addresses come from the
    // join — so this flag is what tells the HOST to read its own record as
    // "publishing" instead of warning forever that `joined` is not serving.
    expect(manifest.network?.publishImplicit).toBe(true);
  });

  it("names the vendor's own words for the credential and the publish", () => {
    // NetBird takes a "setup key", not an "auth key", and publishing is "Use this
    // address", not a serve command it does not have. A generic label asks for a
    // thing NetBird does not offer.
    expect(manifest.network?.labels?.credential).toBe("Setup key");
    expect(manifest.network?.labels?.publish).toBe("Use this address");
  });

  it("has no server-runnable installer — the whole install is privileged", () => {
    // NetBird needs root on both platforms and the host runs no sudo, so the
    // manifest carries no `install.command` at all; every step is printed.
    expect(manifest.install).toBeUndefined();
  });

  it("lists the privileged install steps per platform, with the macOS routes as alternatives", () => {
    // Linux: the official script, nothing further (no operator grant — NetBird has
    // no needs-privilege state). macOS: the app route first (recommended) and the
    // command-line daemon as the alternative, mirroring the Tailscale decision.
    const linux = manifest.network?.privileged?.linux ?? [];
    expect(linux).toHaveLength(1);
    expect(linux[0]?.command).toBe("curl -fsSL https://get.netbird.io | sh");
    expect(linux[0]?.docsUrl).toBe("https://docs.netbird.io/how-to/installation");
    for (const step of linux) expect(step.group).toBeUndefined();

    const darwin = manifest.network?.privileged?.darwin ?? [];
    expect(darwin.map((s) => s.group)).toEqual(["The NetBird app (recommended)", "The command-line daemon"]);
    expect(darwin[0]?.command).toBe("brew install --cask netbird");
    expect(darwin[1]?.command).toBe(
      "brew install netbirdio/tap/netbird && sudo netbird service install && sudo netbird service start",
    );
  });

  it("detects the vendor CLI by name, with an env override", () => {
    expect(manifest.detect?.binaryName).toBe("netbird");
    expect(manifest.detect?.envOverride).toBe("NETBIRD_PATH");
  });

  it("names the install locations PATH does not reach, including the absolute Homebrew dirs", () => {
    // The `.local/bin` entry is HOME-relative; the two Homebrew entries start with
    // `/` and are used as-is — the rule that lets a launchd service find a Mac's
    // NetBird, whose PATH names neither directory.
    expect(manifest.detect?.knownPaths).toEqual([
      ".local/bin/netbird",
      "/usr/local/bin/netbird",
      "/opt/homebrew/bin/netbird",
    ]);
    expect(manifest.detect?.knownPaths.filter((p) => p.startsWith("/"))).toEqual([
      "/usr/local/bin/netbird",
      "/opt/homebrew/bin/netbird",
    ]);
  });

  it("publishes (the pair) and reads settings, and nothing else", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.capabilities()).toEqual(["publish", "settings"]);
    expect(typeof plugin.publish).toBe("function");
    expect(typeof plugin.unpublish).toBe("function");
    expect(typeof plugin.settingsFields).toBe("function");
    expect(plugin.supervisedProcess).toBeUndefined();
    expect(plugin.requestGuard).toBeUndefined();
  });
});

describe("NetBirdPlugin.status", () => {
  it("reports not-installed and says so when there is no binary", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("not-installed");
    expect(status.addresses).toEqual([]);
    // One sentence naming the state; the install steps are the manifest's, and a
    // status that repeats them prints the card twice.
    expect(status.hints).toHaveLength(1);
    expect(status.hints[0]?.text).toBe("NetBird is not installed on this machine.");
    expect(status.hints[0]?.command).toBeUndefined();
    expect(host.calls).toEqual([]);
  });

  it("maps a socket error to a generic daemon-down, naming the service", async () => {
    // NetBird has no needs-privilege state and its peer-credential authorisation
    // is UNMEASURED (§ 10.4), so a permission denial is reported as daemon-down
    // with the SAME generic sentence — the plugin refuses to guess which it saw.
    const { plugin } = scripted({
      "/usr/bin/netbird status --json": { code: 1, stderr: "Failed to connect to the daemon: permission denied" },
    });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("daemon-down");
    expect(status.hints[0]?.text).toBe(
      "The NetBird daemon is not running or not reachable. If it is installed, start its service, then re-check.",
    );
    expect(status.hints[0]?.command).toBe("sudo netbird service install && sudo netbird service start");
    expect(status.hints[0]?.privileged).toBe(true);
    // The daemon's own words come last, naming the actual failure.
    expect(status.hints[1]?.text).toBe("Failed to connect to the daemon: permission denied");
  });

  it("reports daemon-down, not a throw, when the body will not parse", async () => {
    for (const body of ["not json at all", "[1,2,3]", '"a bare string"']) {
      const { plugin } = scripted({ "/usr/bin/netbird status --json": { code: 0, stdout: body } });
      const status = await plugin.status(CTX);
      expect(status.state).toBe("daemon-down");
      // A hint always rides, carrying the offending body rather than a crash.
      expect(status.hints.length).toBeGreaterThan(0);
    }
  });

  it("reports needs-login when the management connection is down", async () => {
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: NOT_CONNECTED } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.addresses).toEqual([]);
    expect(status.hints[0]?.text).toContain("not on your NetBird network yet");
    expect(status.identity).toEqual({ hostname: "workshop", version: "0.76.1" });
  });

  it("treats an empty-but-valid document as not enrolled, not a crash", async () => {
    // `{}` parses and simply has no management connection — the honest answer is
    // needs-login, which is the ladder step before join, not daemon-down.
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: "{}" } });
    expect((await plugin.status(CTX)).state).toBe("needs-login");
  });

  it("reports joined with the FQDN first and the peer IP after, both plain http", async () => {
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: CONNECTED } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      // The trailing dot of `workshop.netbird.cloud.` is stripped.
      { url: `http://workshop.netbird.cloud:${PORT}`, scheme: "http", label: "NetBird FQDN", secureContext: false },
      { url: `http://100.64.0.5:${PORT}`, scheme: "http", label: "NetBird IP", secureContext: false },
    ]);
    expect(status.identity).toEqual({ hostname: "workshop", version: "0.76.1" });
  });

  it("explains the FQDN caveat alongside the address list, linked to the DNS docs", async () => {
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: CONNECTED } });
    const status = await plugin.status(CTX);
    const hint = status.hints.find((h) => h.text.includes("nameserver group"));
    // The sentence names the address the card now actually lists — the measured
    // daemon sends one — and the link is where a nameserver group is configured.
    expect(hint?.text).toBe(
      "Peer names resolve only if your NetBird account has a nameserver group — otherwise use the NetBird IP address.",
    );
    expect(hint?.docsUrl).toBe("https://docs.netbird.io/how-to/manage-dns-in-your-network");
  });

  it("lists both addresses for a live 0.66.4 read, the CIDR IP among them", async () => {
    // The defect this closes: the daemon reports `netbirdIp` as
    // "100.71.129.37/16", the IPv4 test rejected the whole value, and the card
    // showed no IP while its own hint told the operator to use the IP address.
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: MEASURED_0_66_4 } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      { url: `http://studio.example.internal:${PORT}`, scheme: "http", label: "NetBird FQDN", secureContext: false },
      { url: `http://100.71.129.37:${PORT}`, scheme: "http", label: "NetBird IP", secureContext: false },
    ]);
    // No `hostname` key exists on this shape, so the identity carries the
    // version — from `daemonVersion`, the process that is actually running.
    expect(status.identity).toEqual({ version: "0.66.4" });
    expect(status.hints.some((h) => h.text.includes("nameserver group"))).toBe(true);
  });

  it("reads the version from `daemonVersion`, and from `cliVersion` when the daemon does not answer", async () => {
    // Both spellings are measured on 0.66.4, and the daemon leads: the version
    // line describes the running process, not the CLI that asked it. The guessed
    // `netbirdVersion`/`version` spellings stay behind them.
    const cases = [
      [{ cliVersion: "0.66.4", daemonVersion: "0.66.3" }, "0.66.3"],
      [{ cliVersion: "0.66.4" }, "0.66.4"],
      [{ netbirdVersion: "0.76.1" }, "0.76.1"],
    ] as const;
    for (const [fields, version] of cases) {
      const { plugin } = scripted({
        "/usr/bin/netbird status --json": { stdout: JSON.stringify({ management: { connected: false }, ...fields }) },
      });
      const status = await plugin.status(CTX);
      expect(status.identity).toEqual({ version });
    }
  });

  it("reads the peer IP from the netbirdIp spelling and the version from `version`", async () => {
    // The two specs name the field differently and the shape is UNMEASURED
    // (§ 10.4), so both spellings are tried; this fixture uses the other one and
    // carries no FQDN, which also removes the nameserver hint.
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: CONNECTED_IP_ONLY } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      { url: `http://100.64.0.9:${PORT}`, scheme: "http", label: "NetBird IP", secureContext: false },
    ]);
    expect(status.identity).toEqual({ hostname: "box", version: "0.80.0" });
    expect(status.hints.some((h) => h.text.includes("nameserver group"))).toBe(false);
  });

  it("never reports published from a status read — a join is all it can observe", async () => {
    // The joined/published distinction lives in the host's trusted-origins config,
    // which a plugin may not read, so the highest state the daemon can evidence
    // is `joined`. Asserting it is never `published` here is the visible marker of
    // the reported contract gap.
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: CONNECTED } });
    expect((await plugin.status(CTX)).state).not.toBe("published");
  });
});

describe("NetBirdPlugin.join", () => {
  it("brings the machine up with a pasted setup key", async () => {
    const { plugin, host } = scripted({ "/usr/bin/netbird up": { code: 0 } });
    const outcome = await plugin.join({ credential: "8c9f-2a1b-uuid-ish" }, CTX);
    expect(outcome).toEqual({ state: "joined" });
    expect(lines(host)).toEqual(["/usr/bin/netbird up --setup-key=8c9f-2a1b-uuid-ish"]);
  });

  it("adds the management URL to a credential join when the operator set one", async () => {
    const { plugin, host } = scripted({ "/usr/bin/netbird up": { code: 0 } });
    await plugin.join({ credential: "setup-key-1" }, SELF_HOSTED);
    expect(lines(host)).toEqual([
      "/usr/bin/netbird up --setup-key=setup-key-1 --management-url=https://master.netbird.example.com",
    ]);
  });

  it("throws the CLI's own first line when the setup key is refused", async () => {
    const { plugin } = scripted({
      "/usr/bin/netbird up": { code: 1, stderr: "invalid setup key: not found\nusage: netbird up" },
    });
    await expect(plugin.join({ credential: "wrong" }, CTX)).rejects.toThrow("invalid setup key: not found");
  });

  it("captures the login URL and device code off the stream and stops the run", async () => {
    const seen: string[][] = [];
    const host = createTestHost({
      findBinary: async (name) => `/usr/bin/${name}`,
      run: async (argv, opts) => {
        seen.push([...argv]);
        opts?.onLine?.("Please open the following URL in your browser to authenticate:");
        opts?.onLine?.("\thttps://login.netbird.io/realms/netbird/protocol/openid-connect/auth?x=1&y=2");
        opts?.onLine?.("and enter this code: ABCD-1234");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    const plugin = createPlugin(host) as NetworkPlugin;
    const outcome = await plugin.join({}, CTX);
    expect(outcome).toEqual({
      state: "needs-login",
      loginUrl: "https://login.netbird.io/realms/netbird/protocol/openid-connect/auth?x=1&y=2",
      loginCode: "ABCD-1234",
    });
    // `--no-browser` is the whole point: the flow yields a URL rather than opening one.
    expect(seen).toEqual([["/usr/bin/netbird", "up", "--no-browser"]]);
  });

  it("captures a login URL printed on a bare line with no keywords", async () => {
    // A self-hosted NetBird's SSO URL may carry none of the words the prose
    // matcher looks for. NetBird prints progress lines during `up`, not stray
    // doc links, so a line that is just an https URL IS the login URL.
    const host = createTestHost({
      findBinary: async (name) => `/usr/bin/${name}`,
      run: async (_argv, opts) => {
        opts?.onLine?.("NetBird is starting…");
        opts?.onLine?.("https://sso.example.org/realms/netbird/protocol?state=zz");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    const outcome = await (createPlugin(host) as NetworkPlugin).join({}, CTX);
    expect(outcome).toEqual({
      state: "needs-login",
      loginUrl: "https://sso.example.org/realms/netbird/protocol?state=zz",
    });
  });

  it("aborts the interactive run rather than waiting out its deadline", async () => {
    const seen: { aborted: boolean } = { aborted: false };
    const host = createTestHost({
      findBinary: async (name) => `/usr/bin/${name}`,
      run: async (_argv, opts) => {
        opts?.signal?.addEventListener("abort", () => {
          seen.aborted = true;
        });
        opts?.onLine?.("Open this URL to sign in: https://login.netbird.io/a/xyz");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    await (createPlugin(host) as NetworkPlugin).join({}, CTX);
    expect(seen.aborted).toBe(true);
  });

  it("does not hand back a login URL a browser would execute", async () => {
    const host = createTestHost({
      findBinary: async (name) => `/usr/bin/${name}`,
      run: async (_argv, opts) => {
        opts?.onLine?.("Open this URL to authenticate: javascript:alert(1)");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    // The javascript: value is dropped by the scheme check, so no URL was usable and
    // the fallback re-read finds no connection — the CLI's failure is the answer.
    await expect((createPlugin(host) as NetworkPlugin).join({}, CTX)).rejects.toThrow(/javascript:|no login URL/);
  });

  it("reports joined when the run printed nothing but the daemon says it is up", async () => {
    // `netbird up` on an already-enrolled machine exits 0 immediately and prints no
    // URL. Throwing there would report a failure for a machine that is fine.
    const { plugin } = scripted({
      "/usr/bin/netbird up": { code: 0 },
      "/usr/bin/netbird status --json": { stdout: CONNECTED },
    });
    expect(await plugin.join({}, CTX)).toEqual({ state: "joined" });
  });

  it("adds the management URL to an interactive join too", async () => {
    const seen: string[][] = [];
    const host = createTestHost({
      findBinary: async (name) => `/usr/bin/${name}`,
      run: async (argv, opts) => {
        seen.push([...argv]);
        opts?.onLine?.("Open the URL to authenticate: https://login.netbird.io/a/1");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    await (createPlugin(host) as NetworkPlugin).join({}, SELF_HOSTED);
    expect(seen[0]).toEqual([
      "/usr/bin/netbird",
      "up",
      "--no-browser",
      "--management-url=https://master.netbird.example.com",
    ]);
  });

  it("throws, naming what happened, when there is no URL and no network", async () => {
    const { plugin } = scripted({
      "/usr/bin/netbird up": { code: 1, stderr: "management peer is not connected" },
      "/usr/bin/netbird status --json": { stdout: NOT_CONNECTED },
    });
    await expect(plugin.join({}, CTX)).rejects.toThrow("management peer is not connected");
  });
});

describe("NetBirdPlugin.publish", () => {
  it("runs no command at all and returns the addresses the join already made reachable", async () => {
    const { plugin, host } = scripted({ "/usr/bin/netbird status --json": { stdout: CONNECTED } });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toEqual({
      addresses: [
        { url: `http://workshop.netbird.cloud:${PORT}`, scheme: "http", label: "NetBird FQDN", secureContext: false },
        { url: `http://100.64.0.5:${PORT}`, scheme: "http", label: "NetBird IP", secureContext: false },
      ],
    });
    // A publish is a read only: the single call is the status the refusal check
    // needed, and NOTHING that changes the machine.
    expect(lines(host)).toEqual(["/usr/bin/netbird status --json"]);
  });

  it("refuses, with the state's own sentence, when NetBird is not installed", async () => {
    const { plugin } = scripted({}, { findBinary: async () => null });
    expect(await plugin.publish?.(CTX)).toMatchObject({ refused: { text: expect.stringContaining("not installed") } });
  });

  it("refuses, naming the next step, when this machine is not enrolled", async () => {
    const { plugin } = scripted({ "/usr/bin/netbird status --json": { stdout: NOT_CONNECTED } });
    expect(await plugin.publish?.(CTX)).toMatchObject({
      refused: { text: expect.stringContaining("not on your NetBird network") },
    });
  });

  it("refuses rather than fabricating a publish for a connected machine with no address", async () => {
    // Connected but a document that yields neither an FQDN nor a usable IPv4 — the
    // UNMEASURED-shape case. Nothing was handable out, so nothing was published.
    const { plugin } = scripted({
      "/usr/bin/netbird status --json": { stdout: JSON.stringify({ management: { connected: true } }) },
    });
    expect(await plugin.publish?.(CTX)).toMatchObject({ refused: { text: expect.stringContaining("no address") } });
  });
});

describe("NetBirdPlugin.unpublish and leave", () => {
  it("unpublish is a no-op that resolves cleanly", async () => {
    const { plugin, host } = scripted({});
    await expect(plugin.unpublish?.(CTX)).resolves.toBeUndefined();
    expect(host.calls).toEqual([]);
  });

  it("brings the interface down with one `netbird down`", async () => {
    const { plugin, host } = scripted({ "/usr/bin/netbird down": { code: 0 } });
    await plugin.leave(CTX);
    expect(lines(host)).toEqual(["/usr/bin/netbird down"]);
  });

  it("does nothing at all when there is no binary to bring down", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    await plugin.leave(CTX);
    expect(host.calls).toEqual([]);
  });
});

describe("NetBirdPlugin.settings", () => {
  it("declares one optional managementUrl field", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const fields = plugin.settingsFields?.() ?? [];
    expect(fields.map((f) => f.key)).toEqual(["managementUrl"]);
    expect(fields[0]?.type).toBe("string");
    expect(fields[0]?.required).toBe(false);
  });

  it("refuses a management URL that is not an http(s) URL", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const issues = plugin.validateSettings?.({ managementUrl: "master.netbird.example.com" }) ?? [];
    expect(issues.map((i) => i.field)).toContain("managementUrl");
  });

  it("accepts a blank or a well-formed management URL", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.validateSettings?.({})).toEqual([]);
    expect(plugin.validateSettings?.({ managementUrl: "" })).toEqual([]);
    expect(plugin.validateSettings?.({ managementUrl: "https://master.netbird.example.com" })).toEqual([]);
  });
});

/**
 * The plugin never sets the Tailscale CLI marker.
 *
 * The headscale/tailscale binaries need `TAILSCALE_BE_CLI=1`; NetBird's binary is
 * a plain CLI on every install route and setting an unrelated variable on it would
 * be copying the wrong plugin's workaround. Pinned across every verb so a future
 * refactor that reuses a tailscale helper does not leak it in.
 */
describe("every run leaves the environment clean", () => {
  it("never sets TAILSCALE_BE_CLI", async () => {
    const { plugin, runs } = recording({
      "/usr/bin/netbird status --json": { stdout: CONNECTED },
      "/usr/bin/netbird up": { code: 0 },
      "/usr/bin/netbird down": { code: 0 },
    });
    await plugin.status(CTX);
    await plugin.join({ credential: "k" }, CTX);
    await plugin.publish?.(CTX);
    await plugin.leave(CTX);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const run of runs) expect(run.env?.TAILSCALE_BE_CLI).toBeUndefined();
  });
});
