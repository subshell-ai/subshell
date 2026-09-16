import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capabilityMismatches,
  type NetworkContext,
  type NetworkPlugin,
  type PluginHost,
  parseManifest,
  type RunOptions,
  type RunResult,
} from "@subshell-ai/plugin-api";
import { createScriptedHost, createTestHost } from "@subshell-ai/plugin-api/testing";
import pkg from "../../package.json";
import { httpOnlyHint } from "../hints.js";
import createPlugin, { manifest } from "../index.js";

/**
 * The Headscale plugin, tested as a contract implementation.
 *
 * Same style as `@subshell-ai/plugin-tailscale`'s suite (spec 2026-09-16 § 8):
 * a fake `PluginHost` recording argv, and assertions on states, argv and
 * refusals. What differs from tailscale is exactly what the spec pins:
 * the `--login-server` join, the required `controlUrl`, `CertDomains` treated
 * as always empty, the honest § 10.3 serve refusal, and the admin hint.
 */

/** The port the host says this server listens on. Every address and the serve target use it. */
const PORT = 3080;

/** The control server an operator configured. Any https URL — headscale users pick their own host. */
const CONTROL_URL = "https://hs.example.net";

/** A context with no settings yet — the state a fresh install answers with. */
const CTX: NetworkContext = { port: PORT, settings: {}, secrets: { has: () => false } };

/** The context once the admin has saved the control server URL. */
const CTX_CFG: NetworkContext = { port: PORT, settings: { controlUrl: CONTROL_URL }, secrets: { has: () => false } };

/**
 * A realistic `tailscale status --json` from a client pointed at a Headscale.
 *
 * `CertDomains` is deliberately POPULATED here even though a Headscale tailnet
 * issues no certificates (headscale#2527): this plugin treats the field as
 * always empty, and a fixture with the field absent would pass that rule
 * vacuously. `CurrentTailnet.Name` is present, so the happy path can also pin
 * the identity.
 */
const RUNNING_STATUS = JSON.stringify({
  Version: "1.76.1-t2c0a1b3f4",
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0:ab12::1"],
  Self: {
    ID: "n1234CNTRL",
    HostName: "workshop",
    DNSName: "workshop.example.net.",
    OS: "linux",
    Online: true,
  },
  Health: [],
  MagicDNSSuffix: "example.net",
  CurrentTailnet: { Name: "example.net", MagicDNSSuffix: "example.net", MagicDNSEnabled: true },
  CertDomains: ["workshop.example.net"],
  Peer: {},
});

/** `Running`, but the daemon reports no tailnet NAME — the plugin must not guess one. */
const RUNNING_NO_TAILNET_NAME = JSON.stringify({
  ...JSON.parse(RUNNING_STATUS),
  CurrentTailnet: undefined,
});

/** What the daemon reports before anyone has signed in. The AuthURL is the CONTROL SERVER's. */
const NEEDS_LOGIN_STATUS = JSON.stringify({
  BackendState: "NeedsLogin",
  AuthURL: "https://hs.example.net/a/1a2b3c4d5e6f",
  TailscaleIPs: [],
  Self: { HostName: "workshop" },
  CertDomains: [],
});

/** `tailscale serve status --json` on a machine already proxying this server. */
const SERVE_PUBLISHED = JSON.stringify({
  TCP: { "80": { HTTP: true } },
  Web: { "workshop.example.net:80": { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } },
  AllowFunnel: {},
});

/** The same command on a machine serving nothing. */
const SERVE_EMPTY = "{}";

/**
 * `tailscale debug prefs` answers — the daemon's own word for the control
 * server it serves (the ownership read of the 2026-09-16 amendment). Every
 * test whose status reaches `Running` scripts one, so its happy path runs on
 * positive evidence of belonging rather than on the fail-open default.
 */
const PREFS_MINE = JSON.stringify({ ControlURL: CONTROL_URL });

/** The same command on a machine enrolled the ordinary way, into Tailscale's SaaS. */
const PREFS_SERVICE = JSON.stringify({ ControlURL: "https://controlplane.tailscale.com" });

/** The same command on a machine enrolled against SOME OTHER self-hosted server. */
const PREFS_OTHER = JSON.stringify({ ControlURL: "https://hs.internal.example" });

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
 * `createScriptedHost` records argv only — but `TAILSCALE_BE_CLI` lives in the
 * options, and it is a property of the BINARY (which this plugin drives, same
 * as tailscale) that every single run must carry. Copied from the tailscale
 * suite for that reason.
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

describe("headscale manifest", () => {
  it("parses this package's real package.json", () => {
    // The manifest module imports the SAME bytes a runtime installer reads off
    // disk; parsing pkg directly is the proof the block is valid, not just that
    // the module-side parse did not throw at import.
    const parsed = parseManifest(pkg);
    expect("error" in parsed).toBe(false);
  });

  it("declares its OWN identity — headscale's name, not tailscale's", () => {
    // § 4: "It reads its OWN manifest … never tailscale's: its id, name,
    // labels and docs URLs differ." The binary is shared; the identity is not.
    expect(manifest.id).toBe("headscale");
    expect(manifest.type).toBe("network");
    expect(manifest.name).toBe("Headscale");
    expect(manifest.description).toBe("Reach this server over your own self-hosted tailnet.");
    expect(manifest.icon).toBe("icon.svg");
    expect(manifest.network?.platforms).toEqual(["darwin", "linux"]);
    expect(manifest.network?.exposure).toBe("private");
    expect(manifest.network?.interactiveLogin).toBe(true);
  });

  it("copies the daemon steps from the Tailscale plugin, two per platform", () => {
    // § 4: "the daemon steps are tailscale's (same two per platform, copied
    // into THIS manifest)". The client IS the tailscale binary, so the steps
    // name Tailscale; the macOS app route is absent on purpose — an app the
    // admin cannot point at the control server from a launchd service is the
    // wrong recommendation for a self-hosted tailnet (spec 2026-09-15 § 8).
    const linux = manifest.network?.privileged?.linux ?? [];
    expect(linux.map((s) => s.label)).toEqual(["Install Tailscale", "Allow this server to control Tailscale"]);
    expect(linux[0]?.command).toBe("curl -fsSL https://tailscale.com/install.sh | sh");
    const darwin = manifest.network?.privileged?.darwin ?? [];
    expect(darwin.map((s) => s.label)).toEqual([
      "Install the Tailscale daemon",
      "Allow this server to control Tailscale",
    ]);
    for (const steps of [linux, darwin]) {
      expect(steps[steps.length - 1]?.command).toBe("sudo tailscale set --operator=$USER");
    }
  });

  it("detects the SAME tailscale binary as the tailscale plugin", () => {
    // § 4: same binaryName, same envOverride (a HEADSCALE_PATH would mislead —
    // the variable names the binary, and the binary is `tailscale`), same
    // knownPaths including the absolute app-bundle and Homebrew entries.
    expect(manifest.detect?.binaryName).toBe("tailscale");
    expect(manifest.detect?.envOverride).toBe("TAILSCALE_PATH");
    expect(manifest.detect?.knownPaths).toEqual([
      ".local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
  });

  it("publishes, takes settings, and nothing else", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.capabilities()).toEqual(["publish", "settings"]);
    expect(typeof plugin.publish).toBe("function");
    expect(typeof plugin.unpublish).toBe("function");
    expect(plugin.supervisedProcess).toBeUndefined();
    expect(plugin.requestGuard).toBeUndefined();
    // The loader's own rule, asserted here rather than trusted downstream:
    // what is declared must be implemented, per type, both directions.
    expect(capabilityMismatches(plugin, "network")).toEqual([]);
  });

  it("declares controlUrl as a required setting field", () => {
    const fields = createPlugin(createTestHost()) as NetworkPlugin;
    expect(fields.settingsFields?.()).toEqual([
      {
        key: "controlUrl",
        label: "Control server URL",
        type: "string",
        required: true,
        placeholder: "https://headscale.example.com",
      },
    ]);
  });

  it("ships the § 11 copy verbatim, pinned — the rule the drift would have broken", () => {
    // § 11 declares every user-visible string verbatim; a reworded hint is
    // invisible to every check except one that quotes the spec. So this
    // quotes the spec. (The browser-consequence half is not this line's to
    // say — the per-address secure-context line already states it.)
    expect(httpOnlyHint().text).toBe(
      "Headscale does not issue certificates, so this address is plain http over WireGuard.",
    );
    expect(httpOnlyHint().docsUrl).toBe("https://github.com/juanfont/headscale/issues/2527");
  });

  it("flags a malformed controlUrl on the form, not minutes later in a join frame", () => {
    // The netbird twin's behavior, for a structurally identical field: an
    // obviously-wrong URL gets a named field error where the form can point,
    // instead of whichever DNS/TLS error the CLI will print at join time.
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const bad = plugin.validateSettings?.({ controlUrl: "headscale.example.com" }) ?? [];
    expect(bad.length).toBe(1);
    expect(bad[0]?.field).toBe("controlUrl");
    expect(bad[0]?.message).toContain("http(s) URL");
    expect(plugin.validateSettings?.({ controlUrl: "https://headscale.example.com" })).toEqual([]);
    // Absent/blank is the settings route's CLEAR spelling, never a bad URL.
    expect(plugin.validateSettings?.({ controlUrl: "  " })).toEqual([]);
    expect(plugin.validateSettings?.({})).toEqual([]);
  });
});

describe("HeadscalePlugin.status", () => {
  it("reports not-installed naming TAILSCALE the client, leaving the steps to the manifest", async () => {
    // § 4: "not-installed sentence names Tailscale (the client)" — what is
    // missing is the tailscale binary, and that is the word a reader can act on.
    const { plugin, host } = scripted({}, { findBinary: async () => null, platform: "linux" });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("not-installed");
    expect(status.hints[0]?.text).toBe("Tailscale is not installed on this machine.");
    expect(status.hints[0]?.docsUrl).toContain("install-linux");
    expect(status.hints.every((h) => h.command === undefined)).toBe(true);
    expect(host.calls).toEqual([]);
  });

  it("reports daemon-down when the CLI cannot reach the socket", async () => {
    // "needs-privilege and daemon-down map exactly as tailscale does" (§ 4).
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

  it("names BOTH macOS daemon routes when the socket is unreachable there", async () => {
    const { plugin } = scripted(
      { "/usr/bin/tailscale status --json": { code: 1, stderr: "failed to connect to local tailscaled" } },
      { platform: "darwin" },
    );
    const status = await plugin.status(CTX);
    expect(status.hints[0]?.command).toBeUndefined();
    expect(status.hints[1]?.command).toBe("sudo tailscaled install-system-daemon");
    expect(status.hints[1]?.privileged).toBe(true);
    expect(status.hints[2]?.text).toBe("failed to connect to local tailscaled");
  });

  it("reports daemon-down, not a throw, when the body will not parse", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { code: 0, stdout: "not json at all" } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("daemon-down");
    expect(status.hints.some((h) => h.text.includes("not json at all"))).toBe(true);
  });

  it("reports needs-login for an empty JSON document rather than guessing a state", async () => {
    // `{}` parses, so it is not daemon-down; `BackendState` is absent, so it is
    // not Running; the ladder's honest landing is needs-login with no URL.
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: "{}" } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.loginUrl).toBeUndefined();
  });

  it("reports needs-privilege when the daemon refuses this user", async () => {
    // The same "Access denied" strings, mapped exactly as tailscale does —
    // including the ordering: permission is checked before daemon-down.
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": {
        code: 1,
        stderr: "Access denied: watch IPN bus access denied, no server running?",
      },
    });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-privilege");
    expect(status.hints[0]?.command).toBe("sudo tailscale set --operator=test");
  });

  it("does not read a HEALTHY tailnet's own document as a permission failure", async () => {
    const healthy = JSON.parse(RUNNING_STATUS);
    healthy.Self.Tags = ["tag:operator"];
    healthy.Health = ["socket permission denied on some unrelated peer"];
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { code: 0, stdout: JSON.stringify(healthy) },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
    });
    const status = await plugin.status(CTX_CFG);
    expect(status.state).not.toBe("needs-privilege");
    expect(status.state).not.toBe("daemon-down");
    expect(status.addresses.length).toBeGreaterThan(0);
  });

  it("reports needs-login, carries the control server's AuthURL, and adds the admin hint", async () => {
    // The interactive login is finished BY A HEADSCALE ADMIN (§ 4.5: "true
    // (finished by a Headscale admin)"), so the needs-login row says both.
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.loginUrl).toBe("https://hs.example.net/a/1a2b3c4d5e6f");
    expect(status.hints.some((h) => h.text.includes("Ask your Headscale admin to register this machine"))).toBe(true);
  });

  it("reports no login URL at all when the daemon hands back one a browser would execute", async () => {
    const hostile = JSON.stringify({
      BackendState: "NeedsLogin",
      AuthURL: "javascript:fetch('/api/plugins',{method:'POST'})",
      Self: { HostName: "workshop" },
    });
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: hostile } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.loginUrl).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("javascript:");
  });

  it("says so distinctly when the client is merely switched off, and still adds the admin hint", async () => {
    const stopped = JSON.stringify({ BackendState: "Stopped", AuthURL: "", Self: { HostName: "workshop" } });
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: stopped } });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.hints[0]?.command).toBe("tailscale up");
    expect(status.hints.some((h) => h.text.includes("Ask your Headscale admin"))).toBe(true);
  });

  it("reports joined with http addresses only — CertDomains is treated as ALWAYS empty", async () => {
    // The fixture has `CertDomains` populated; a headscale tailnet issues no
    // certificates (headscale#2527), so this plugin must not put an https
    // address on screen nor a Certificate-Transparency warning about a
    // certificate this publish can never issue.
    const { plugin } = scripted(
      {
        "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
        "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
        "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
      },
      { probeVersion: async () => "1.76.1\n  tailscale commit: abc123" },
    );
    const status = await plugin.status(CTX_CFG);
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      // The DNS name first: the host promotes addresses[0], and the name is
      // the address the § 10.3 publish refusal points back to.
      { url: `http://workshop.example.net:${PORT}`, scheme: "http", label: "MagicDNS", secureContext: false },
      { url: `http://100.101.102.103:${PORT}`, scheme: "http", label: "Tailnet IP", secureContext: false },
    ]);
    expect(status.hints.some((h) => h.text.includes("Certificate Transparency"))).toBe(false);
    // And a hint SAYS WHY there is no https address (§ 4.5's status row),
    // in § 11's verbatim words — quoted, not substring-guessed.
    expect(status.hints.some((h) => h.text.includes("does not issue certificates"))).toBe(true);
    expect(status.identity).toEqual({ network: "example.net", hostname: "workshop", version: "1.76.1" });
  });

  it("reports joined with the hostname only when the tailnet NAME is absent — no guessing", async () => {
    // § 4: "when BackendState is Running but CurrentTailnet.Name is absent,
    // do NOT guess". The temptation is to synthesize a network name from
    // MagicDNSSuffix; the spec forbids it, so this pins its ABSENCE.
    const { plugin } = scripted(
      {
        "/usr/bin/tailscale status --json": { stdout: RUNNING_NO_TAILNET_NAME },
        "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
        "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
      },
      { probeVersion: async () => "1.76.1" },
    );
    const status = await plugin.status(CTX_CFG);
    expect(status.state).toBe("joined");
    // toEqual, not toMatchObject: the ABSENCE of `network` is the assertion.
    expect(status.identity).toEqual({ hostname: "workshop", version: "1.76.1" });
  });

  it("reports published once serve is proxying this server's port", async () => {
    // The published check still reads `tailscale serve status` (§ 4) even
    // though § 10.3 leaves the serve AGAINST HEADSCALE unmeasured — the read
    // is of the local daemon's config either way.
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_PUBLISHED },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
    });
    expect((await plugin.status(CTX_CFG)).state).toBe("published");
  });

  it("stays joined when serve names a different port", async () => {
    const other = SERVE_PUBLISHED.replace(`http://127.0.0.1:${PORT}`, "http://127.0.0.1:9999");
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: other },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
    });
    expect((await plugin.status(CTX_CFG)).state).toBe("joined");
  });

  it("asks the daemon to leave out the peer map", async () => {
    // Copied defense: a real headscale's peer map can overrun the host's
    // 64 KiB output cap and a truncated document does not parse.
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
    });
    await plugin.status(CTX_CFG);
    const statusCall = host.calls.find((c) => c[1] === "status");
    expect(statusCall).toEqual(["/usr/bin/tailscale", "status", "--json", "--peers=false"]);
  });

  // **The ownership gate (spec 2026-09-16 amendment to § 8's non-policing).**
  // Measured on the operator's live host (tailscale CLI 1.102.4): `status
  // --json` has no `LoginServer` key — the reason § 8 abstained — but
  // `tailscale debug prefs` reports `ControlURL`, the daemon's own word for
  // who it serves. The rows police that POSITIVE evidence now; the tests
  // below pin both the refusal and the fail-open that the README's pick-one
  // rule still lives on.

  it("will not call a daemon belonging to Tailscale's own service JOINED when no control server is set", async () => {
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_SERVICE },
    });
    const status = await plugin.status(CTX);
    expect(status.state).toBe("needs-login");
    expect(status.addresses).toEqual([]);
    expect(status.identity?.hostname).toBe("workshop");
    expect(status.hints).toEqual([
      {
        text: "This machine's Tailscale belongs to Tailscale's own service, and this plugin has no control server URL to check it against.",
      },
      { text: "Set the control server URL for this plugin, then re-check." },
    ]);
    // The foreign daemon's serve config is never read — a phantom
    // "Published" was the same defect one state further.
    expect(lines(host).some((l) => l.includes("serve status"))).toBe(false);
  });

  it("names the setting it wanted and offers `tailscale logout` when one IS configured", async () => {
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_SERVICE },
    });
    const status = await plugin.status(CTX_CFG);
    expect(status.state).toBe("needs-login");
    expect(status.hints).toEqual([
      {
        text: `This machine's Tailscale belongs to Tailscale's own service, not to your configured control server (${CONTROL_URL}).`,
      },
      {
        text: "To move this machine onto your control server, sign it out of that one first.",
        command: "tailscale logout",
      },
    ]);
    // Suggested as a copyable command; the plugin runs no logout of its own.
    expect(lines(host).some((l) => l.includes("logout"))).toBe(false);
    expect(lines(host).some((l) => l.includes("serve status"))).toBe(false);
  });

  it("names the other host when the daemon reports a self-hosted server that is not this one", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_OTHER },
    });
    const status = await plugin.status(CTX_CFG);
    expect(status.state).toBe("needs-login");
    expect(status.hints[0]?.text).toBe(
      "This machine's Tailscale belongs to hs.internal.example, not to your configured control server (https://hs.example.net).",
    );
  });

  it("reads a ControlURL differing only by trailing slash or host case as its own", async () => {
    // The comparison is by canonical URL, because both spellings are what
    // people type and what `URL` stores.
    for (const reported of ["https://hs.example.net/", "HTTPS://HS.Example.NET"]) {
      const { plugin, host } = scripted({
        "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
        "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
        "/usr/bin/tailscale debug prefs": { stdout: JSON.stringify({ ControlURL: reported }) },
      });
      const status = await plugin.status(CTX_CFG);
      expect(status.state).toBe("joined");
      expect(status.addresses.length).toBeGreaterThan(0);
      expect(lines(host).some((l) => l.includes("serve status"))).toBe(true);
    }
  });

  it("fails OPEN to the pre-amendment read when `debug prefs` cannot answer", async () => {
    // A CLI with no `debug prefs`, a refused read, an empty body and a body
    // that will not parse all leave the Running branch exactly where § 8
    // left it: joined, serve config consulted, README rule the human's.
    for (const prefs of [
      { code: 1, stderr: 'unknown command "debug" for "tailscale"' },
      { stdout: "" },
      { stdout: "not json" },
    ]) {
      const { plugin, host } = scripted({
        "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
        "/usr/bin/tailscale serve status --json": { stdout: SERVE_PUBLISHED },
        "/usr/bin/tailscale debug prefs": prefs,
      });
      expect((await plugin.status(CTX_CFG)).state).toBe("published");
      expect(lines(host).some((l) => l.includes("serve status"))).toBe(true);
    }
  });
});

describe("HeadscalePlugin.join", () => {
  it("refuses without a control server URL, before running anything", async () => {
    // § 4's exact sentence. The shape it shows — `{ refused }` — is publish's
    // answer; `JoinOutcome` has no refusal member, so the join THROWS this
    // sentence and the host maps the throw to the operator, exactly as
    // tailscale's join throws for a malformed key.
    const { plugin, host } = scripted({});
    await expect(plugin.join({ credential: "tskey-auth-k123-abc" }, CTX)).rejects.toThrow(
      "Headscale needs the URL of your control server before this machine can join.",
    );
    expect(host.calls).toEqual([]);
  });

  it("refuses the INTERACTIVE join without a control server URL too", async () => {
    const { plugin, host } = scripted({});
    await expect(plugin.join({}, CTX)).rejects.toThrow(
      "Headscale needs the URL of your control server before this machine can join.",
    );
    expect(host.calls).toEqual([]);
  });

  it("brings the machine up against the control server with a pasted key", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale up": { code: 0 } });
    const outcome = await plugin.join({ credential: "tskey-auth-k123-abc", hostname: "workshop" }, CTX_CFG);
    expect(outcome).toEqual({ state: "joined" });
    // `--login-server <url>` as two argv entries (§ 4's spelling), the
    // `--auth-key=` equals form copied from the tailscale plugin.
    expect(lines(host)).toEqual([
      `/usr/bin/tailscale up --login-server ${CONTROL_URL} --auth-key=tskey-auth-k123-abc --hostname=workshop`,
    ]);
  });

  it("refuses a credential that is not an auth key before running anything", async () => {
    const { plugin, host } = scripted({});
    await expect(plugin.join({ credential: "hunter2" }, CTX_CFG)).rejects.toThrow(/tskey-/);
    expect(host.calls).toEqual([]);
  });

  it("throws the CLI's own first line when the key is refused", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 1, stderr: "backend error: invalid key: unauthorized\nusage: tailscale up" },
    });
    await expect(plugin.join({ credential: "tskey-auth-bad" }, CTX_CFG)).rejects.toThrow(
      "backend error: invalid key: unauthorized",
    );
  });

  it("captures the login URL off the output stream and stops the run there", async () => {
    // The interactive join is tailscale's exactly ("URL capture and abort
    // exactly as tailscale's join does") — including recognizing a CONTROL
    // SERVER's own URL, not just login.tailscale.com.
    const seen: string[][] = [];
    const host = createTestHost({
      findBinary: async (name: string) => `/usr/bin/${name}`,
      run: async (argv: string[], opts?: RunOptions): Promise<RunResult> => {
        seen.push([...argv]);
        // The matcher copied from the origin recognizes a URL on a line that
        // says it is the one to open — here the CONTROL SERVER's host, not
        // login.tailscale.com. A URL printed on its own line is covered by
        // the status-fallback test below, which is the other half of the
        // origin's design ("it does not rest on which stream carries it").
        opts?.onLine?.(`To authenticate, visit: ${CONTROL_URL}/a/9f8e7d6c5b4a`);
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    const plugin = createPlugin(host) as NetworkPlugin;
    const outcome = await plugin.join({}, CTX_CFG);
    expect(outcome).toEqual({ state: "needs-login", loginUrl: `${CONTROL_URL}/a/9f8e7d6c5b4a` });
    expect(seen).toEqual([["/usr/bin/tailscale", "up", "--login-server", CONTROL_URL]]);
  });

  it("aborts the interactive run, rather than waiting out its deadline", async () => {
    const seen: { aborted: boolean } = { aborted: false };
    const host = createTestHost({
      findBinary: async (name: string) => `/usr/bin/${name}`,
      run: async (_argv: string[], opts?: RunOptions): Promise<RunResult> => {
        opts?.signal?.addEventListener("abort", () => {
          seen.aborted = true;
        });
        opts?.onLine?.(`To authenticate, visit: ${CONTROL_URL}/a/abc`);
        return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
      },
    });
    await (createPlugin(host) as NetworkPlugin).join({}, CTX_CFG);
    expect(seen.aborted).toBe(true);
  });

  it("falls back to the daemon's own AuthURL when the run printed none", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: null, aborted: false },
      "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS },
    });
    const outcome = await plugin.join({}, CTX_CFG);
    expect(outcome).toEqual({ state: "needs-login", loginUrl: `${CONTROL_URL}/a/1a2b3c4d5e6f` });
  });

  it("reports joined when `up` returned on a machine that was already up", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 0 },
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
    });
    expect(await plugin.join({}, CTX_CFG)).toEqual({ state: "joined" });
  });

  it("throws, naming what happened, when there is no URL and no tailnet", async () => {
    const { plugin } = scripted({
      "/usr/bin/tailscale up": { code: 1, stderr: "control server unreachable" },
      "/usr/bin/tailscale status --json": { stdout: JSON.stringify({ BackendState: "NoState", AuthURL: "" }) },
    });
    await expect(plugin.join({}, CTX_CFG)).rejects.toThrow("control server unreachable");
  });
});

describe("HeadscalePlugin.publish", () => {
  it("resets, then serves this server's port over http 80, in that order", async () => {
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
      "/usr/bin/tailscale serve reset": { code: 0 },
      "/usr/bin/tailscale serve --bg": { code: 0 },
    });
    const outcome = await plugin.publish?.(CTX_CFG);
    expect(outcome).toEqual({
      addresses: [
        // http, not https — the serve is `--http=80`, and a headscale tailnet
        // issues no certificates (headscale#2527). secureContext false: what
        // the BROWSER will refuse there, stated, not inferred.
        { url: "http://workshop.example.net", scheme: "http", label: "MagicDNS", secureContext: false },
      ],
    });
    expect(lines(host).slice(-2)).toEqual([
      "/usr/bin/tailscale serve reset",
      `/usr/bin/tailscale serve --bg --http=80 http://127.0.0.1:${PORT}`,
    ]);
  });

  it("refuses with the state's own sentence when the client is not installed", async () => {
    // State before anything, as tailscale's does.
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("not installed") } });
    expect(lines(host).some((l) => l.includes("serve --bg"))).toBe(false);
  });

  it("refuses when this machine is not on a tailnet", async () => {
    const { plugin } = scripted({ "/usr/bin/tailscale status --json": { stdout: NEEDS_LOGIN_STATUS } });
    const outcome = await plugin.publish?.(CTX);
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("not on a tailnet") } });
  });

  it("turns a refused serve into an honest refusal that never fabricates published", async () => {
    // § 4: "If the CLI refuses, publish is a { refused } naming § 10.3 as
    // unmeasured and pointing at the plain http://<DNSName>:<port> address
    // the status already lists. Do NOT fabricate a published state."
    const { plugin } = scripted({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
      "/usr/bin/tailscale serve reset": { code: 0 },
      "/usr/bin/tailscale serve --bg": { code: 1, stderr: "cannot serve: no HTTPS certificate\nsee docs" },
    });
    const outcome = await plugin.publish?.(CTX_CFG);
    expect(outcome).toBeDefined();
    expect("addresses" in (outcome ?? {})).toBe(false);
    // Direct property reads, not `toMatchObject` with nested matchers: bun
    // 1.4.2's `toMatchObject` MUTATES the received object when one is used (a
    // matched string becomes `{}`) — measured in this suite, and the reason
    // this assertion order fails on a correct refusal.
    const refused = (outcome as { refused: { text: string; docsUrl?: string } }).refused;
    expect(refused.text).toContain("10.3");
    expect(refused.text).toContain(`http://workshop.example.net:${PORT}`);
    expect(refused.docsUrl).toMatch(/^https:\/\//);
  });

  it("refuses before attempting serve when the daemon reported no DNS name", async () => {
    const noName = JSON.stringify({ ...JSON.parse(RUNNING_STATUS), Self: { HostName: "workshop" } });
    const { plugin, host } = scripted({
      "/usr/bin/tailscale status --json": { stdout: noName },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
    });
    const outcome = await plugin.publish?.(CTX_CFG);
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("name") } });
    expect(lines(host).some((l) => l.includes("serve --bg"))).toBe(false);
  });
});

describe("HeadscalePlugin.unpublish and leave", () => {
  it("takes the serve configuration down with one reset", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale serve reset": { code: 0 } });
    await plugin.unpublish?.(CTX);
    expect(lines(host)).toEqual(["/usr/bin/tailscale serve reset"]);
  });

  it("logs out, best-effort", async () => {
    const { plugin, host } = scripted({ "/usr/bin/tailscale logout": { code: 0 } });
    await plugin.leave(CTX);
    expect(lines(host)).toEqual(["/usr/bin/tailscale logout"]);
  });

  it("does nothing at all when there is no binary", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    await plugin.leave(CTX);
    await plugin.unpublish?.(CTX);
    expect(host.calls).toEqual([]);
  });
});

/**
 * The one environment variable every run needs — inherited from the tailscale
 * plugin whole, because it is a property of the shared BINARY, not of either
 * plugin (measured 2026-09-16 on the standalone Mac app: without it the
 * bundle tries to start its GUI and dies).
 */
describe("every run asks for CLI mode", () => {
  it("sets TAILSCALE_BE_CLI=1 on all of them, including the two `up` paths", async () => {
    const { plugin, runs } = recording({
      "/usr/bin/tailscale status --json": { stdout: RUNNING_STATUS },
      "/usr/bin/tailscale serve status --json": { stdout: SERVE_EMPTY },
      "/usr/bin/tailscale debug prefs": { stdout: PREFS_MINE },
      "/usr/bin/tailscale up": { code: 0 },
      "/usr/bin/tailscale serve reset": { code: 0 },
      "/usr/bin/tailscale serve --bg": { code: 0 },
      "/usr/bin/tailscale logout": { code: 0 },
    });
    await plugin.status(CTX_CFG);
    await plugin.join({ credential: "tskey-auth-k123-abc" }, CTX_CFG);
    await plugin.join({}, CTX_CFG);
    await plugin.publish?.(CTX);
    await plugin.unpublish?.(CTX);
    await plugin.leave(CTX);

    const verbs = new Set(runs.map((run) => run.argv[1]));
    expect([...verbs].sort()).toEqual(["debug", "logout", "serve", "status", "up"]);
    expect(runs.length).toBeGreaterThanOrEqual(8);
    for (const run of runs) {
      expect(run.env?.TAILSCALE_BE_CLI).toBe("1");
    }
  });
});

/**
 * The containment pin for the copied source (spec 2026-09-16 § 4).
 *
 * § 4 sanctions copying the tailscale plugin's source ONLY with the copy
 * naming its origin and the shared argv constants pinned so a silent drift is
 * a red test rather than two files disagreeing about one vendor CLI. The
 * precedent is the `tmux-<uid>` socket path, pinned across the Rust crates.
 *
 * These read the tailscale SOURCE from the checkout — tests run in the repo,
 * which is the only place this coupling exists (the built dist inlines the
 * copy; nothing at runtime reads across).
 */
describe("copied source stays pinned to its origin", () => {
  const pluginRoot = join(import.meta.dir, "..", "..", "..");
  const tailscaleSrc = join(pluginRoot, "tailscale", "src");
  const headscaleSrc = join(pluginRoot, "headscale", "src");

  const readFrom = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

  /** Literals that MUST appear in both packages: argv shared with the same binary. */
  const shared: { literal: string; file: string }[] = [
    { literal: '["status", "--json", "--peers=false"]', file: "status.ts" },
    { literal: '["serve", "status", "--json"]', file: "status.ts" },
    // The ownership read (spec 2026-09-16 amendment): both plugins ask the
    // same daemon the same question with the same two tokens.
    { literal: '["debug", "prefs"]', file: "cli.ts" },
    { literal: '["serve", "reset"]', file: "publish.ts" },
    { literal: '["logout"]', file: "publish.ts" },
    { literal: 'TAILSCALE_BE_CLI: "1"', file: "cli.ts" },
    // § 4 mandates the JOIN's URL capture be shared too: it is the same
    // daemon printing the same login lines, so the reader of them is one
    // reader — a tailscale-side tweak to either regex must go red here.
    { literal: "const LOGIN_URL_RE = /https:\\/\\/login\\.tailscale\\.com\\/\\S+/;", file: "join.ts" },
    { literal: "const ANY_URL_RE = /https:\\/\\/\\S+/;", file: "join.ts" },
  ];

  for (const { literal, file } of shared) {
    it(`"${literal}" (${file}) still agrees between the two plugins`, () => {
      expect(readFrom(tailscaleSrc, file)).toContain(literal);
      expect(readFrom(headscaleSrc, file)).toContain(literal);
    });
  }

  for (const file of ["cli.ts", "status.ts", "join.ts", "publish.ts", "hints.ts"]) {
    it(`${file} names the package it was copied from`, () => {
      expect(readFrom(headscaleSrc, file)).toContain("@subshell-ai/plugin-tailscale");
    });
  }

  it("the two manifests' detect blocks are byte-identical DATA", () => {
    // § 4's decision — same binary, same env override, same knownPaths
    // including the app route and the two Homebrew dirs. It is manifest
    // data, so the pin compares the package.json files themselves, not
    // whatever code parses them.
    const detect = (pkg: "tailscale" | "headscale"): unknown =>
      JSON.parse(readFileSync(join(pluginRoot, pkg, "package.json"), "utf8")).subshell.detect;
    expect(detect("headscale")).toEqual(detect("tailscale"));
  });
});
