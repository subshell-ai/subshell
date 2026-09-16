import { describe, expect, it } from "bun:test";
import type { NetworkContext, NetworkPlugin, PluginHost, RunOptions, RunResult } from "@subshell-ai/plugin-api";
import { createScriptedHost, createTestHost } from "@subshell-ai/plugin-api/testing";
import { daemonDownHints } from "../hints.js";
import createPlugin, { manifest } from "../index.js";

/** The port the host says this server listens on. Every address and the serve target use it. */
const PORT = 3080;

/** The context a host passes on every call. A network plugin holds none of this itself. */
const CTX: NetworkContext = { port: PORT, settings: {}, secrets: { has: () => false } };

/**
 * A realistic `tailscale status --json` for a machine that is on a tailnet
 * with HTTPS certificates enabled.
 *
 * Kept whole rather than minimal, because two of the fields only bite in their
 * real form: `DNSName` carries the trailing dot that DNS requires and a URL
 * must not have, and `TailscaleIPs` interleaves an IPv6 address the address
 * list has to drop.
 */
const RUNNING_STATUS = JSON.stringify({
  Version: "1.76.1-t2c0a1b3f4",
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0:ab12::1"],
  Self: {
    ID: "n1234CNTRL",
    HostName: "workshop",
    DNSName: "workshop.tailnet-abc.ts.net.",
    OS: "linux",
    Online: true,
  },
  Health: [],
  MagicDNSSuffix: "tailnet-abc.ts.net",
  CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "tailnet-abc.ts.net", MagicDNSEnabled: true },
  CertDomains: ["workshop.tailnet-abc.ts.net"],
  Peer: {},
});

/** The same tailnet with certificates NOT enabled: the field is present and empty. */
const RUNNING_NO_CERTS = JSON.stringify({
  ...JSON.parse(RUNNING_STATUS),
  CertDomains: [],
});

/** What the daemon reports before anyone has signed in on this machine. */
const NEEDS_LOGIN_STATUS = JSON.stringify({
  BackendState: "NeedsLogin",
  AuthURL: "https://login.tailscale.com/a/1a2b3c4d5e6f",
  TailscaleIPs: [],
  Self: { HostName: "workshop" },
  CertDomains: [],
});

/** `tailscale serve status --json` on a machine already proxying this server. */
const SERVE_PUBLISHED = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { "workshop.tailnet-abc.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } },
  AllowFunnel: {},
});

/** The same command on a machine serving nothing. */
const SERVE_EMPTY = "{}";

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

/**
 * A scripted host that also records each run's OPTIONS.
 *
 * `createScriptedHost` records argv only, which is all a parser test needs —
 * but `TAILSCALE_BE_CLI` lives in the options, and the app-bundle binary tries
 * to start a GUI and fails without it. So the one thing that has to be true of
 * every single run is invisible to the argv recorder.
 */
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

describe("tailscale manifest", () => {
  it("declares its identity and network facts as DATA, not in code", () => {
    // A page renders "not available on this platform" and prints the sudo
    // steps from these bytes without importing the plugin, so they are the
    // part that must not move into the module.
    expect(manifest.id).toBe("tailscale");
    expect(manifest.type).toBe("network");
    expect(manifest.name).toBe("Tailscale");
    expect(manifest.icon).toBe("icon.svg");
    expect(manifest.network?.platforms).toEqual(["darwin", "linux"]);
    expect(manifest.network?.exposure).toBe("private");
    expect(manifest.network?.interactiveLogin).toBe(true);
    expect(manifest.network?.privileged?.linux?.length).toBe(2);
    expect(manifest.network?.privileged?.darwin?.length).toBe(3);
  });

  it("says what the operator grant DOES, wherever a platform asks for it", () => {
    // These labels are the only words a person reads beside a `sudo` command,
    // and they used to read "Let this server drive it" — spec vocabulary for
    // Tailscale's `--operator` grant that nobody reads that way. Pinned on
    // both platforms so a rewording is a decision made here and in the
    // manifest together. It is the LAST step on each, because on macOS the
    // daemon route now sits behind the app route.
    for (const platform of ["darwin", "linux"] as const) {
      const steps = manifest.network?.privileged?.[platform] ?? [];
      const last = steps[steps.length - 1];
      expect(last?.label).toBe("Allow this server to control Tailscale");
      expect(last?.command).toBe("sudo tailscale set --operator=$USER");
    }
  });

  it("offers the macOS app and the command-line daemon as two ALTERNATIVES", () => {
    // Measured 2026-09-16: the app's CLI drives `status`, `up`, `serve` and
    // `set --operator` with no root and no operator grant, because the app
    // runs as the local user and so does the server. Most people have the app
    // or will install it, and the card used to name only the open-source
    // daemon — which Tailscale itself recommends "only for unattended
    // installs managed by experienced macOS system administrators".
    const steps = manifest.network?.privileged?.darwin ?? [];
    expect(steps.map((s) => s.group)).toEqual([
      "The Tailscale app (recommended)",
      "The command-line daemon",
      "The command-line daemon",
    ]);
    expect(steps[0]?.label).toBe(
      "Install the Tailscale app, or get it from the Mac App Store, then open it and sign in",
    );
    // The CASK, not the formula: the formula is the daemon, and the cask was
    // renamed to `tailscale-app` when the formula took the plain name.
    expect(steps[0]?.command).toBe("brew install --cask tailscale-app");
    expect(steps[1]?.label).toBe("Install the Tailscale daemon");
    expect(steps[1]?.command).toBe("brew install --formula tailscale && sudo tailscaled install-system-daemon");
    // Linux has one route, so it keeps one plain sequence.
    for (const step of manifest.network?.privileged?.linux ?? []) {
      expect(step.group).toBeUndefined();
    }
  });

  it("detects the vendor CLI by name, with an env override", () => {
    expect(manifest.detect?.binaryName).toBe("tailscale");
    expect(manifest.detect?.envOverride).toBe("TAILSCALE_PATH");
  });

  it("names the places Tailscale installs itself that PATH does not reach", () => {
    // A launchd-run server's PATH holds neither Homebrew directory, and the
    // login-shell rung depends on whatever the user's profile does — so these
    // are the rung that answers on a real Mac. The app bundle is LAST, so a
    // person who deliberately installed the formula beside the app keeps
    // driving the formula.
    expect(manifest.detect?.knownPaths).toEqual([
      ".local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
  });

  it("publishes, and nothing else", () => {
    // The pair is validated at load: a publish nothing can undo is refused.
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.capabilities()).toEqual(["publish"]);
    expect(typeof plugin.publish).toBe("function");
    expect(typeof plugin.unpublish).toBe("function");
    expect(plugin.supervisedProcess).toBeUndefined();
    expect(plugin.requestGuard).toBeUndefined();
    expect(plugin.settingsFields).toBeUndefined();
  });
});

describe("TailscalePlugin.status", () => {
  it("reports not-installed and says so, leaving the steps to the manifest, when there is no binary", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null, platform: "linux" });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("not-installed");
    expect(status.addresses).toEqual([]);
    // The steps come from the manifest and are rendered from there. Repeating
    // them here printed the whole sequence twice on the card — see
    // `notInstalledHints`. What the status owes is the sentence naming the
    // state, which the manifest cannot know.
    expect(status.hints.every((h) => h.text.trim() !== "")).toBe(true);
    expect(status.hints.some((h) => h.command?.includes("tailscale.com/install.sh"))).toBe(false);
    // Nothing was run: there was nothing to run it with.
    expect(host.calls).toEqual([]);
  });

  it("reports daemon-down when the CLI cannot reach the socket", async () => {
    const { plugin } = scripted(
      {
        "/usr/bin/tailscale status --json": {
          code: 1,
          stderr: "failed to connect to local tailscaled; it doesn't appear to be running",
        },
      },
      { platform: "linux" },
    );
    const status = await plugin.status(CTX);
    expect(status.state).toBe("daemon-down");
    expect(status.hints[0]?.command).toBe("sudo systemctl start tailscaled");
    expect(status.hints[0]?.privileged).toBe(true);
  });

  it("names BOTH macOS routes when the socket is unreachable there", async () => {
    // The plugin cannot cheaply tell the app from the daemon — the app's CLI
    // integration installs a two-line shell wrapper at /usr/local/bin/tailscale,
    // which hides the bundle path it execs — and the two sentences cost less
    // than a wrong guess about which one a person installed.
    const { plugin } = scripted(
      { "/usr/bin/tailscale status --json": { code: 1, stderr: "failed to connect to local tailscaled" } },
      { platform: "darwin" },
    );
    const status = await plugin.status(CTX);
    expect(status.hints[0]?.text).toBe(
      "Tailscale is not running on this machine. If you use the Tailscale app, open it and sign in, then re-check.",
    );
    // The app route needs no command: opening an app is not a sudo line.
    expect(status.hints[0]?.command).toBeUndefined();
    expect(status.hints[1]?.command).toBe("sudo tailscaled install-system-daemon");
    expect(status.hints[1]?.privileged).toBe(true);
    // The daemon's own words still come last, naming the actual socket.
    expect(status.hints[2]?.text).toBe("failed to connect to local tailscaled");
  });

  it("reports daemon-down, not a throw, when the body will not parse", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { code: 0, stdout: "not json at all" } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("daemon-down");
    expect(status.hints.some((h) => h.text.includes("not json at all"))).toBe(true);
  });

  it("reports needs-privilege when the daemon refuses this user", async () => {
    // Tailscale's access-denied text routinely also mentions a server that is
    // not running, which is exactly why the permission test runs first: the
    // fix here is the operator grant, not restarting a live daemon.
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": {
        code: 1,
        stderr: "Access denied: watch IPN bus access denied, no server running?",
      },
    });
    const status = await plugin.status({ ...CTX });
    expect(status.state).toBe("needs-privilege");
    // Says what is not allowed, in the same words as the manifest's step two.
    expect(status.hints[0]?.text).toBe(
      "This server is not allowed to control Tailscale yet. Grant its user access to the daemon, then re-check.",
    );
    expect(status.hints[0]?.command).toBe("sudo tailscale set --operator=test");
  });

  it("asks the daemon to leave out the peer map", async () => {
    // Not an optimization. `status --json` embeds the whole peer map, a real
    // tailnet's runs to tens of kilobytes, and the host caps captured output
    // at 64 KiB — so the document stopped parsing and a healthy daemon
    // reported itself down. Pinned because the scripted host matches argv by
    // PREFIX, so dropping this flag would otherwise keep every test green.
    const { plugin, host } = scripted({ "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS } });
    await plugin.status(CTX);
    const statusCall = host.calls.find((c) => c[1] === "status");
    expect(statusCall).toEqual(["/usr/bin/tailscale", "status", "--json", "--peers=false"]);
  });

  it("says what publishing discloses, before anyone presses publish", async () => {
    // A public certificate is recorded in Certificate Transparency logs, which
    // are public and indexed, so publishing makes this machine's NAME public
    // permanently. Nobody would guess that from a button labelled Publish, and
    // the security documents already claimed it was said — this is what makes
    // that true.
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS } });
    const status = await plugin.status(CTX);
    expect(status.hints.some((h) => h.text.includes("Certificate Transparency"))).toBe(true);
  });

  it("does not mention certificates on a tailnet that cannot issue them", async () => {
    // There the honest next step is enabling HTTPS, and advice about a
    // disclosure that cannot happen yet is noise in front of it.
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: RUNNING_NO_CERTS } });
    const status = await plugin.status(CTX);
    expect(status.hints.some((h) => h.text.includes("Certificate Transparency"))).toBe(false);
    expect(status.hints.some((h) => h.text.includes("enable HTTPS certificates"))).toBe(true);
  });

  it("does not read a HEALTHY tailnet's own document as a permission failure", async () => {
    // The matchers are substring tests over loose vendor prose — the
    // permission one matches the bare word "operator" — and a successful
    // `status --json` prints the whole tailnet: ACL tags (`tag:operator` is a
    // common name), peer names, health strings. Diagnosing a SUCCESSFUL run
    // from its stdout turned a perfectly healthy machine into
    // `needs-privilege` with no addresses, publishing blocked, and a copyable
    // grant command that changes nothing because the grant already exists.
    const healthy = JSON.parse(RUNNING_STATUS);
    healthy.Self.Tags = ["tag:operator"];
    healthy.Health = ["socket permission denied on some unrelated peer"];
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { code: 0, stdout: JSON.stringify(healthy) } });
    const status = await plugin.status(CTX);
    expect(status.state).not.toBe("needs-privilege");
    expect(status.state).not.toBe("daemon-down");
    expect(status.addresses.length).toBeGreaterThan(0);
  });

  it("reports needs-login and carries the AuthURL a human must open", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.loginUrl).toBe("https://login.tailscale.com/a/1a2b3c4d5e6f");
    expect(status.addresses).toEqual([]);
  });

  it("reports no login URL at all when the daemon hands back one a browser would execute", async () => {
    // `AuthURL` is the one value here Tailscale does not choose: the daemon
    // reports whatever its control server sent, and `--login-server` makes
    // that a host the operator picked. It reaches a page as a link to open and
    // a value to copy, so the scheme is the plugin's business.
    const hostile = JSON.stringify({
      BackendState: "NeedsLogin",
      AuthURL: "javascript:fetch('/api/plugins',{method:'POST'})",
      Self: { HostName: "workshop" },
    });
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: hostile } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.loginUrl).toBeUndefined();
    // And the hint falls back to the one that needs no link, rather than
    // carrying the URL in an anchor.
    expect(status.hints.some((hint) => hint.docsUrl !== undefined)).toBe(false);
    expect(JSON.stringify(status)).not.toContain("javascript:");
  });

  it("says so distinctly when Tailscale is merely switched off", async () => {
    const stopped = JSON.stringify({ BackendState: "Stopped", AuthURL: "", Self: { HostName: "workshop" } });
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: stopped } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.hints[0]?.command).toBe("tailscale up");
  });

  it("reports joined, with the https name first and the tailnet IP after it", async () => {
    const { plugin } = scripted(
      {
        "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
        "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      },
      { probeVersion: async () => "1.76.1\n  tailscale commit: abc123" },
    );
    const status = await plugin.status(CTX);
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      // The trailing dot of `workshop.tailnet-abc.ts.net.` is stripped: it is
      // correct in DNS and a different origin string in a URL.
      { url: "https://workshop.tailnet-abc.ts.net", scheme: "https", label: "MagicDNS", secureContext: true },
      // The IPv6 address in the fixture is dropped; a browser needs brackets
      // for it and nothing here needs it at all.
      { url: `http://100.101.102.103:${PORT}`, scheme: "http", label: "Tailscale IP", secureContext: false },
    ]);
    expect(status.identity).toEqual({ network: "example.com", hostname: "workshop", version: "1.76.1" });
  });

  it("reports published once serve is proxying this server's port", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_PUBLISHED },
    });
    expect((await plugin.status(CTX)).state).toBe("published");
  });

  it("stays joined when serve names a different port", async () => {
    const other = SERVE_PUBLISHED.replace(`http://127.0.0.1:${PORT}`, "http://127.0.0.1:9999");
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: other },
    });
    expect((await plugin.status(CTX)).state).toBe("joined");
  });

  it("explains the missing https address when the tailnet issues no certificates", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_NO_CERTS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
    });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("joined");
    // Only the IP address survives, and the hint says why.
    expect(status.addresses.map((a) => a.scheme)).toEqual(["http"]);
    expect(status.hints[0]?.docsUrl).toBe("https://tailscale.com/kb/1153/enabling-https");
  });
});

describe("TailscalePlugin.join", () => {
  it("refuses a credential that is not an auth key before running anything", async () => {
    const { plugin, host } = scripted({});
    await expect(plugin.join({ credential: "hunter2" }, CTX)).rejects.toThrow(/tskey-/);
    expect(host.calls).toEqual([]);
  });

  it("brings the machine up with a pasted key and the requested hostname", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale up": { code: 0 } });
    const outcome = await plugin.join({ credential: "tskey-auth-k123-abc", hostname: "workshop" }, CTX);
    expect(outcome).toEqual({ state: "joined" });
    expect(lines(host)).toEqual(["/usr/bin/tailscale up --auth-key=tskey-auth-k123-abc --hostname=workshop"]);
  });

  it("throws the CLI's own first line when the key is refused", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 1, stderr: "backend error: invalid key: unauthorized\nusage: tailscale up" },
    });
    await expect(plugin.join({ credential: "tskey-auth-bad" }, CTX)).rejects.toThrow(
      "backend error: invalid key: unauthorized",
    );
  });

  it("captures the login URL off the output stream and stops the run there", async () => {
    // The abort IS the success path: `tailscale up` prints the URL and then
    // blocks until a human finishes in a browser.
    const seen: string[][] = [];
    const host = createTestHost({
      findBinary: async (name: string) => `/usr/bin/${name}`,
      run: async (argv: string[], opts?: RunOptions): Promise<RunResult> => {
        seen.push([...argv]);
        opts?.onLine?.("");
        opts?.onLine?.("To authenticate, visit:");
        opts?.onLine?.("");
        opts?.onLine?.("\thttps://login.tailscale.com/a/9f8e7d6c5b4a");
        opts?.onLine?.("");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    const plugin = createPlugin(host) as NetworkPlugin;
    const outcome = await plugin.join({}, CTX);
    expect(outcome).toEqual({ state: "needs-login", loginUrl: "https://login.tailscale.com/a/9f8e7d6c5b4a" });
    // One call: the URL arrived on the stream, so nothing had to ask the
    // daemon afterwards.
    expect(seen).toEqual([["/usr/bin/tailscale", "up"]]);
  });

  it("aborts the interactive run, rather than waiting out its deadline", async () => {
    const seen: { aborted: boolean } = { aborted: false };
    const host = createTestHost({
      findBinary: async (name: string) => `/usr/bin/${name}`,
      run: async (_argv: string[], opts?: RunOptions): Promise<RunResult> => {
        opts?.signal?.addEventListener("abort", () => {
          seen.aborted = true;
        });
        opts?.onLine?.("To authenticate, visit: https://login.tailscale.com/a/abc");
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    await (createPlugin(host) as NetworkPlugin).join({}, CTX);
    expect(seen.aborted).toBe(true);
  });

  it("falls back to the daemon's own AuthURL when the run printed none", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: null, aborted: false },
      "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS },
    });
    const outcome = await plugin.join({}, CTX);
    expect(outcome).toEqual({ state: "needs-login", loginUrl: "https://login.tailscale.com/a/1a2b3c4d5e6f" });
  });

  it("does not fall back to an AuthURL a browser would execute", async () => {
    // Same untrusted value on the join path, where the result is handed
    // straight back as `loginUrl`. With none usable the daemon's own words
    // are the honest answer.
    const hostile = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "javascript:alert(1)" });
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 1, stderr: "tailscale up: could not reach the control server" },
      "/usr/bin/tailscale status --json": { stdout: hostile },
    });
    await expect(plugin.join({}, CTX)).rejects.toThrow(/control server/);
  });

  it("reports joined when `up` returned on a machine that was already up", async () => {
    // `tailscale up` on a running machine exits 0 immediately and prints no
    // URL. Throwing there would report a failure for a machine that is fine.
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 0 },
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
    });
    expect(await plugin.join({}, CTX)).toEqual({ state: "joined" });
  });

  it("throws, naming what happened, when there is no URL and no tailnet", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 1, stderr: "control server unreachable" },
      "/usr/bin/tailscale status --json": { stdout: JSON.stringify({ BackendState: "NoState", AuthURL: "" }) },
    });
    await expect(plugin.join({}, CTX)).rejects.toThrow("control server unreachable");
  });
});

describe("TailscalePlugin.publish", () => {
  it("resets, then serves this server's port over https, in that order", async () => {
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale serve reset": { code: 0 },
      "/usr/bin/tailscale serve --bg": { code: 0 },
    });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toEqual({
      addresses: [
        { url: "https://workshop.tailnet-abc.ts.net", scheme: "https", label: "MagicDNS", secureContext: true },
      ],
    });
    // The two serve calls, exactly, and reset first: publishing twice must
    // replace the handler rather than layer a second one.
    expect(lines(host).slice(-2)).toEqual([
      "/usr/bin/tailscale serve reset",
      `/usr/bin/tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`,
    ]);
  });

  it("refuses, with the admin-console docs, when the tailnet issues no certificates", async () => {
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_NO_CERTS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
    });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({
      refused: { docsUrl: "https://tailscale.com/kb/1153/enabling-https" },
    });
    // A refusal is an answer, so nothing was attempted.
    expect(lines(host).some((l) => l.includes("serve --bg"))).toBe(false);
  });

  it("refuses, naming the next step, when this machine is not on a tailnet", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS } });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("not on a tailnet") } });
  });

  it("refuses with the state's own sentence when Tailscale is not installed", async () => {
    // State is checked BEFORE certificates: `CertDomains` is empty here too,
    // and answering "enable certificates" would be nonsense.
    const { plugin } = scripted({}, { findBinary: async () => null });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("not installed") } });
  });

  it("turns a refused serve into a refusal rather than a throw", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale serve --bg": { code: 1, stderr: "cannot serve: HTTPS is not enabled\nsee docs" },
    });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({ refused: { text: "cannot serve: HTTPS is not enabled" } });
  });
});

describe("TailscalePlugin.unpublish and leave", () => {
  it("takes the serve configuration down with one reset", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale serve reset": { code: 0 } });
    await plugin.unpublish?.(CTX);
    expect(lines(host)).toEqual(["/usr/bin/tailscale serve reset"]);
  });

  it("ignores a reset that a machine serving nothing refused", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale serve reset": { code: 1, stderr: "nothing to reset" } });
    await expect(plugin.unpublish?.(CTX)).resolves.toBeUndefined();
  });

  it("logs out, best-effort", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale logout": { code: 0 } });
    await plugin.leave(CTX);
    expect(lines(host)).toEqual(["/usr/bin/tailscale logout"]);
  });

  it("does nothing at all when there is no binary to log out of", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    await plugin.leave(CTX);
    await plugin.unpublish?.(CTX);
    expect(host.calls).toEqual([]);
  });
});

describe("TailscalePlugin: a machine without the CLI", () => {
  it("points at the INSTALL page for each platform, not the CLI reference", async () => {
    // The reader of a "not installed" row has not installed anything yet, so
    // the CLI reference is a page that assumes the answer. Linux got that
    // page while the manifest's own step two lines below pointed at the right
    // one.
    for (const [platform, expected] of [
      ["darwin", "install-mac"],
      ["linux", "install-linux"],
    ] as const) {
      const { plugin } = scripted({}, { platform, findBinary: async () => null });
      const status = await plugin.status(CTX);
      expect(status.state).toBe("not-installed");
      expect(status.hints[0]?.docsUrl).toContain(expected);
    }
  });

  it("says what is wrong and leaves the install steps to the manifest, which is rendered once", async () => {
    // Detection alone is not help — but the help is already on screen. The
    // `network.privileged` block in package.json IS the install sequence, and
    // a page renders it from those bytes before any of this code is imported.
    // Re-emitting the same steps as hints therefore did not prevent drift (the
    // reason first given for it); it made the card render every step TWICE, as
    // "1. Install … 2. Allow this server to control Tailscale" followed by the
    // sentence and then "3. Install … 4. Allow this server to control Tailscale".
    //
    // So the status contributes the one thing the manifest cannot: the
    // sentence saying which state this machine is in.
    for (const platform of ["linux", "darwin"] as const) {
      const { plugin } = scripted({}, { platform, findBinary: async () => null });
      const status = await plugin.status(CTX);
      expect(status.hints).toHaveLength(1);
      // ONE sentence, naming the state and nothing else: the numbered steps
      // render directly beneath it, so a clause previewing them is the
      // duplication this hint exists to have removed.
      expect(status.hints[0]?.text).toBe("Tailscale is not installed on this machine.");
      expect(status.hints[0]?.command).toBeUndefined();
      expect(status.hints[0]?.docsUrl).toBeTruthy();

      // Nothing the manifest already carries is repeated here.
      const manifestCommands = (manifest.network?.privileged?.[platform] ?? []).map((step) => step.command);
      expect(manifestCommands.length).toBeGreaterThan(0);
      for (const hint of status.hints) {
        expect(manifestCommands).not.toContain(hint.command as string);
      }
    }
  });
});

/**
 * The one environment variable every run needs.
 *
 * Its own block rather than one test per verb, because the requirement is a
 * property of the BINARY the host's ladder happened to land on and not of any
 * call site: `status`, `up`, `serve` and `logout` all need it, and a verb added
 * later needs it too.
 */
describe("every run asks for CLI mode", () => {
  it("sets TAILSCALE_BE_CLI=1 on all of them, including the two `up` paths", async () => {
    // Measured 2026-09-16 on the standalone Mac app, 1.102.4: run with a bare
    // environment its binary tries to start the GUI and dies with `The
    // Tailscale GUI failed to start: … (Tailscale.CLIError error 3.)`.
    // `TAILSCALE_BE_CLI=1` (tailscale.com/kb/1080/cli) makes it behave as a CLI.
    // The Homebrew formula and the app's `/usr/local/bin` wrapper need nothing,
    // so the variable is inert for them and load-bearing for the bundle — and
    // which of the three the ladder found is not known until runtime.
    const { plugin, runs } = recording({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_PUBLISHED },
    });
    await plugin.status(CTX);
    await plugin.join({ credential: "tskey-auth-k123-abc" }, CTX);
    await plugin.join({}, CTX);
    await plugin.publish?.(CTX);
    await plugin.unpublish?.(CTX);
    await plugin.leave(CTX);

    // Every verb the plugin has is exercised above, so the loop below cannot
    // be vacuous on a plugin that stopped running anything.
    const verbs = new Set(runs.map((run) => run.argv[1]));
    expect([...verbs].sort()).toEqual(["logout", "serve", "status", "up"]);
    expect(runs.length).toBeGreaterThanOrEqual(8);
    for (const run of runs) {
      expect(run.env?.TAILSCALE_BE_CLI).toBe("1");
    }
  });
});

/**
 * The dead-daemon message, per platform, spoken by the function rather than
 * through a status read.
 *
 * The status test above pins what a page receives; this pins the two platforms
 * side by side, because the difference between them is structural: Linux has
 * one daemon that is already installed and merely stopped, while macOS has two
 * routes to a running Tailscale and the plugin cannot tell which one a machine
 * took.
 */
describe("daemonDownHints", () => {
  it("offers the app first and the daemon second on macOS, then the daemon's own words", () => {
    expect(daemonDownHints("darwin", "socket /tmp/tailscaled.sock: no such file")).toEqual([
      {
        text: "Tailscale is not running on this machine. If you use the Tailscale app, open it and sign in, then re-check.",
      },
      {
        text: "If you installed the command-line daemon instead, install and start it, then re-check.",
        command: "sudo tailscaled install-system-daemon",
        docsUrl: "https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
        privileged: true,
      },
      { text: "socket /tmp/tailscaled.sock: no such file" },
    ]);
  });

  it("still says START on Linux, where the unit exists already", () => {
    // Not a cosmetic difference. `tailscaled` is a systemd unit that the
    // install step already put there, so the useful line starts it; re-running
    // an install for a stopped service is advice that changes nothing.
    expect(daemonDownHints("linux", "boom")).toEqual([
      {
        text: "The Tailscale daemon is not running. Start it, then re-check.",
        command: "sudo systemctl start tailscaled",
        docsUrl: "https://tailscale.com/kb/1080/cli",
        privileged: true,
      },
      { text: "boom" },
    ]);
  });

  it("omits the daemon's own line when it said nothing", () => {
    expect(daemonDownHints("darwin", "")).toHaveLength(2);
  });
});
