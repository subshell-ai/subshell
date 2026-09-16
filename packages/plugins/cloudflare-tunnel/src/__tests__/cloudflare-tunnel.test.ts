import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  capabilityMismatches,
  type NetworkContext,
  type NetworkPlugin,
  type PluginHost,
} from "@subshell-ai/plugin-api";
import { createScriptedHost, createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

/**
 * The contract assertions for the first plugin that actually uses `supervise`
 * and `guard` (spec 2026-09-15 phases, § 6 of the phase 2-3 spec).
 *
 * Nothing here talks to Cloudflare. The pre-flight is driven by a fake
 * `globalThis.fetch` including the 302-with-Location case and the error case;
 * `cloudflared` is never run, because this plugin runs nothing — it returns
 * declarations for the HOST to act on, and that is most of what these tests
 * pin: the shape of the process spec (the token is never an argv element), the
 * shape of the guard, and the fail-closed pre-flight.
 */

/** The port the host says this server listens on. */
const PORT = 3080;

/** A complete, well-formed settings set. */
const SETTINGS = { hostname: "subshell.example.com", teamDomain: "myteam", aud: "aud-tag-1" };

/**
 * A well-formed Cloudflare tunnel token: base64 of the JSON whose decoded form
 * carries the account/tunnel/secret triple. The value is inert — a made-up
 * triple that exists only to be checked for shape.
 */
const TOKEN = Buffer.from(JSON.stringify({ a: "account-tag", t: "tunnel-uuid", s: "c2VjcmV0LWJ5dGVz" })).toString(
  "base64",
);

/** The context a host passes on every call. A network plugin holds none of this itself. */
function ctx(over: { settings?: Record<string, string>; tokenSet?: boolean } = {}): NetworkContext {
  return {
    port: PORT,
    // A passed settings object REPLACES the complete set — cases that want a
    // modified copy spread SETTINGS themselves.
    settings: over.settings ?? { ...SETTINGS },
    // Presence only, for the one declared secret: the real `ctx.secrets` is
    // probed with the declared field keys and nothing else.
    secrets: { has: (name: string) => name === "tunnel-token" && (over.tokenSet ?? true) },
  };
}

/** Builds the plugin over a scripted host, and hands back both so calls can be asserted. */
function scripted(
  answers: Record<string, Partial<{ code: number | null; stdout: string; stderr: string }>>,
  over: Partial<PluginHost> = {},
): { plugin: NetworkPlugin; host: PluginHost & { calls: string[][] }; secretWrites: string[] } {
  const host = createScriptedHost(answers, over);
  const secretWrites: string[] = [];
  const innerSet = host.secrets.set;
  const innerDelete = host.secrets.delete;
  host.secrets = {
    ...host.secrets,
    set: async (name, value) => {
      secretWrites.push(`set:${name}`);
      return innerSet(name, value);
    },
    delete: async (name) => {
      secretWrites.push(`delete:${name}`);
      return innerDelete(name);
    },
  };
  return { plugin: createPlugin(host) as NetworkPlugin, host, secretWrites };
}

/* ------------------------------------------------------------------ */
/* the fake Cloudflare                                                 */
/* ------------------------------------------------------------------ */

interface FakeCloudflare {
  /** The URLs the pre-flight fetched, in order. */
  urls: string[];
  /** The RequestInits the pre-flight passed, in order. */
  inits: (RequestInit | undefined)[];
}

const realFetch = globalThis.fetch;

/**
 * Replaces `globalThis.fetch` with a handler, recording every call.
 *
 * The plugin calls the global at call time (that is all it has), so replacing
 * it is the honest seam — the same way a supervisor test replaces `Bun.spawn`.
 */
function fakeCloudflare(handler: (url: string, init: RequestInit | undefined) => Response): FakeCloudflare {
  const recorded: FakeCloudflare = { urls: [], inits: [] };
  globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = String(input);
    recorded.urls.push(url);
    recorded.inits.push(init);
    return handler(url, init);
  }) as typeof fetch;
  return recorded;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

describe("cloudflare-tunnel manifest", () => {
  it("declares its identity and network facts as DATA, not in code", () => {
    expect(manifest.id).toBe("cloudflare-tunnel");
    expect(manifest.type).toBe("network");
    expect(manifest.name).toBe("Cloudflare Tunnel");
    expect(manifest.icon).toBe("icon.svg");
    expect(manifest.network?.platforms).toEqual(["darwin", "linux"]);
    // The one public exposure in the set, stated before the button (§ 7.1),
    // and the reason the host refuses to arm this plugin's tunnel unguarded.
    expect(manifest.network?.exposure).toBe("public-with-gate");
    // There is no interactive login: the token is the identity. The parser
    // drops a `false`, so absence is the parsed spelling of "not offered".
    expect(manifest.network?.interactiveLogin).toBeUndefined();
  });

  it("carries the ONLY server-runnable installer, and it is not privileged", () => {
    // § 8: cloudflared needs no root anywhere, which is the whole reason it
    // is the one plugin with an install.command a surface may offer a button
    // for. The manifest parser refuses a sudo-prefixed command outright, so
    // parsing this one at all (the import above) proves the refusal passed.
    expect(manifest.install?.command).toBe("brew install cloudflared");
    expect(manifest.install?.docsUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
  });

  it("prints the Linux install as one copyable privileged command", () => {
    // The apt-repo lines from Cloudflare's own docs, ONE command to copy. It
    // carries sudo — which is exactly what makes it `privileged` data and not
    // an install.command: the copy-only channel.
    const steps = manifest.network?.privileged?.linux ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.command).toContain("apt-get install");
    expect(steps[0]?.command).toContain("sudo");
    expect(steps[0]?.docsUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    // macOS needs no privileged step: brew runs as the user, and the install
    // button covers it.
    expect(manifest.network?.privileged?.darwin).toBeUndefined();
  });

  it("uses the vendor's own words for the two acts", () => {
    expect(manifest.network?.labels?.credential).toBe("Tunnel token");
    expect(manifest.network?.labels?.publish).toBe("Start tunnel");
  });

  it("detects cloudflared by name, with an env override and absolute fallbacks", () => {
    expect(manifest.detect?.binaryName).toBe("cloudflared");
    expect(manifest.detect?.envOverride).toBe("CLOUDFLARED_PATH");
    expect(manifest.detect?.knownPaths).toEqual([
      ".local/bin/cloudflared",
      "/usr/local/bin/cloudflared",
      "/opt/homebrew/bin/cloudflared",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* capabilities                                                        */
/* ------------------------------------------------------------------ */

describe("capabilities", () => {
  it("declares all four network capabilities and implements every one", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.capabilities()).toEqual(["publish", "supervise", "guard", "settings"]);
    // The loader's own check, run here rather than only there: this plugin is
    // the FIRST real consumer of `supervise` and `guard`, and a declaration
    // that disagrees with the members is refused at load, not at first use.
    expect(capabilityMismatches(plugin, "network")).toEqual([]);
    expect(typeof plugin.publish).toBe("function");
    expect(typeof plugin.unpublish).toBe("function");
    expect(typeof plugin.supervisedProcess).toBe("function");
    expect(typeof plugin.requestGuard).toBe("function");
    expect(typeof plugin.settingsFields).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/* settings fields                                                     */
/* ------------------------------------------------------------------ */

describe("settingsFields", () => {
  it("declares hostname, teamDomain and aud, plus the write-only token", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const fields = plugin.settingsFields?.() ?? [];
    expect(fields.map((f) => f.key)).toEqual(["hostname", "teamDomain", "aud", "tunnel-token"]);
    expect(fields.map((f) => f.type)).toEqual(["string", "string", "string", "secret"]);
    expect(fields.every((f) => f.required)).toBe(true);
    expect(fields.find((f) => f.key === "hostname")?.placeholder).toBe("subshell.example.com");
    expect(fields.find((f) => f.key === "teamDomain")?.placeholder).toBe("myteam");
    expect(fields.find((f) => f.key === "tunnel-token")?.label).toBe("Tunnel token");
  });

  it("names the secret's limits beside the field, not after a restore", () => {
    // `subshell-server backup` snapshots the database alone (§ 9), so a
    // restored instance needs the token pasted again. The spec makes that a
    // UI promise; this is what makes it true.
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const token = plugin.settingsFields?.().find((f) => f.key === "tunnel-token");
    expect(token?.description).toContain("subshell-server backup");
    expect(token?.description).toContain("paste it again");
  });

  it("keys the secret a dashed name, because the store says so", () => {
    // The host stores each secret under the field's KEY, and secret names
    // become file names: lowercase letters, digits and hyphens only. A
    // camelCase key would make the field permanently unsettable — the store
    // refusing every write by name — so the key is `tunnel-token` even where
    // the other three fields are camelCase.
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.settingsFields?.().find((f) => f.type === "secret")?.key).toBe("tunnel-token");
    expect(plugin.settingsFields?.().find((f) => f.type === "secret")?.key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("validateSettings", () => {
  it("accepts a well-formed set", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    expect(plugin.validateSettings?.(SETTINGS) ?? []).toEqual([]);
  });

  it("flags a hostname carrying a scheme or a path", () => {
    // The hostname is what the guard compares a Host header against and what
    // the pre-flight fetches — a `https://` in it breaks both silently.
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const issues = plugin.validateSettings?.({ ...SETTINGS, hostname: "https://sub.example.com/" }) ?? [];
    expect(issues.map((i) => i.field)).toContain("hostname");
  });

  it("flags a team domain that is neither a bare team nor a cloudflareaccess host", () => {
    const plugin = createPlugin(createTestHost()) as NetworkPlugin;
    const issues = plugin.validateSettings?.({ ...SETTINGS, teamDomain: "not a team" }) ?? [];
    expect(issues.map((i) => i.field)).toContain("teamDomain");
  });
});

/* ------------------------------------------------------------------ */
/* join                                                                */
/* ------------------------------------------------------------------ */

describe("join", () => {
  it("stores a well-formed token and spawns nothing", () => {
    const { plugin, host, secretWrites } = scripted({});
    const outcome = plugin.join({ credential: TOKEN }, ctx({ tokenSet: false }));
    return outcome.then((result) => {
      expect(result).toEqual({ state: "joined" });
      expect(secretWrites).toEqual(["set:tunnel-token"]);
      // The join is a secret write and nothing else: there is no `cloudflared`
      // invocation that means "authenticate" — the token IS the identity.
      expect(host.calls).toEqual([]);
    });
  });

  it("refuses a value that is not base64 JSON, naming where the token comes from", async () => {
    const { plugin, host, secretWrites } = scripted({});
    await expect(plugin.join({ credential: "hunter2" }, ctx())).rejects.toThrow(/Zero Trust .* Networks .* Tunnels/);
    expect(secretWrites).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("refuses base64 that decodes to JSON without the account/tunnel/secret triple", async () => {
    const { plugin, secretWrites } = scripted({});
    const wrongShape = Buffer.from(JSON.stringify({ a: "account-tag", t: "tunnel-uuid" })).toString("base64");
    await expect(plugin.join({ credential: wrongShape }, ctx())).rejects.toThrow(/Cloudflare tunnel token/);
    expect(secretWrites).toEqual([]);
  });

  it("refuses base64 of something that is not JSON at all", async () => {
    const { plugin } = scripted({});
    const notJson = Buffer.from("just some text").toString("base64");
    await expect(plugin.join({ credential: notJson }, ctx())).rejects.toThrow(/Cloudflare tunnel token/);
  });

  it("refuses an empty interactive join, because interactiveLogin is false", async () => {
    const { plugin, secretWrites } = scripted({});
    await expect(plugin.join({}, ctx())).rejects.toThrow(/tunnel token/);
    expect(secretWrites).toEqual([]);
  });

  it("trims the credential before storing it", async () => {
    const { host } = scripted({});
    let stored: string | undefined;
    host.secrets = {
      ...host.secrets,
      set: async (_name, value) => {
        stored = value;
      },
    };
    await (createPlugin(host) as NetworkPlugin).join({ credential: `  ${TOKEN}\n` }, ctx({ tokenSet: false }));
    expect(stored).toBe(TOKEN);
  });
});

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

describe("status", () => {
  it("reports not-installed and says so, leaving the steps to the manifest, when there is no binary", async () => {
    const { plugin, host } = scripted({}, { findBinary: async () => null });
    const status = await plugin.status(ctx());
    expect(status.state).toBe("not-installed");
    expect(status.addresses).toEqual([]);
    expect(status.hints.every((h) => h.text.trim() !== "")).toBe(true);
    // Nothing was run: the manifest already carries the install steps, and a
    // hint repeating them renders the card twice (the tailscale lesson).
    expect(host.calls).toEqual([]);
    expect(status.hints.some((h) => h.command)).toBe(false);
  });

  it("reports needs-login with nothing configured, pointing at the token", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => "cloudflared version 2026.9.0" });
    const status = await plugin.status(ctx({ settings: {}, tokenSet: false }));
    expect(status.state).toBe("needs-login");
    expect(status.addresses).toEqual([]);
    expect(status.hints.some((h) => h.text.includes("tunnel token"))).toBe(true);
  });

  it("says the settings sentence when the token is in but the settings are not", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    const status = await plugin.status(ctx({ settings: {}, tokenSet: true }));
    expect(status.state).toBe("needs-login");
    expect(
      status.hints.some((h) => h.text === "Set the hostname, team domain and application AUD before publishing."),
    ).toBe(true);
  });

  it("reports joined when the binary, the settings and the token are all present", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => "cloudflared version 2026.9.0\nbuild junk" });
    const status = await plugin.status(ctx());
    // `published` ⇔ the SUPERVISOR reports running, and the plugin cannot see
    // the supervisor — that merge is the host's (§ 4.5). The plugin answers
    // presence and completeness, never process state.
    expect(status.state).toBe("joined");
    expect(status.addresses).toEqual([
      { url: "https://subshell.example.com", scheme: "https", label: "Public hostname", secureContext: true },
    ]);
    expect(status.identity?.version).toBe("cloudflared version 2026.9.0");
  });

  it("states the two disclosures a public hostname needs beside it", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    const status = await plugin.status(ctx());
    // Access is a front door, not a session (§ 6) — said where the address is
    // rendered, not discovered at the login screen.
    expect(status.hints.some((h) => h.text.includes("front door") && h.text.includes("sign-in"))).toBe(true);
    // And the § 5.6 trap: the port the tunnel routes to lives in the
    // dashboard, not in the token, so a port change never reaches it.
    expect(status.hints.some((h) => h.text.includes("port") && h.text.toLowerCase().includes("dashboard"))).toBe(true);
  });

  it("stays needs-login when the secret row is gone, even with complete settings", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    const status = await plugin.status(ctx({ tokenSet: false }));
    expect(status.state).toBe("needs-login");
    expect(status.addresses).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the Access pre-flight and publish                                   */
/* ------------------------------------------------------------------ */

describe("publish", () => {
  it("refuses without every setting, and never reaches the network", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: URL | Request | string) => {
      seen.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { plugin } = scripted({});
    const outcome = await plugin.publish?.(ctx({ settings: { hostname: "sub.example.com" } }));
    expect(outcome).toEqual({
      refused: { text: "Set the hostname, team domain and application AUD before publishing." },
    });
    expect(seen).toEqual([]);
  });

  it("refuses without the stored token, and never reaches the network", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: URL | Request | string) => {
      seen.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { plugin } = scripted({});
    const outcome = await plugin.publish?.(ctx({ tokenSet: false }));
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("tunnel token") } });
    expect(seen).toEqual([]);
  });

  it("publishes on a 302 to the Access host, and hands the host the process and nothing else", async () => {
    const { plugin, host } = scripted({}, { probeVersion: async () => null });
    const recorded = fakeCloudflare(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/subshell.example.com" },
        }),
    );
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toEqual({
      addresses: [
        { url: "https://subshell.example.com", scheme: "https", label: "Public hostname", secureContext: true },
      ],
      process: {
        command: "/usr/bin/cloudflared",
        // The token is NOT here — not in args, not anywhere. The host hydrates
        // it into the child's TUNNEL_TOKEN environment at spawn (secrets
        // contract, § 4.4), so `ps` on this host shows no credential.
        args: ["tunnel", "run", "--no-autoupdate"],
        secretEnv: { TUNNEL_TOKEN: "tunnel-token" },
      },
    });
    // The pre-flight fetched the hostname itself, and did NOT follow the
    // redirect: following it would land on the Access login page and read
    // like a pass.
    expect(recorded.urls).toEqual(["https://subshell.example.com/"]);
    expect(recorded.inits[0]?.redirect).toBe("manual");
    // And the plugin ran nothing. The guard is NOT in this outcome — the host
    // re-asks `requestGuard`, the single source (§ 4.3).
    expect(host.calls).toEqual([]);
  });

  it("publishes on a 403 that carries cf-access headers", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    fakeCloudflare(() => new Response(null, { status: 403, headers: { "cf-access-denied-reason": "no_session" } }));
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toMatchObject({
      addresses: [{ url: "https://subshell.example.com" }],
      process: { command: "/usr/bin/cloudflared" },
    });
  });

  it("refuses a bare public hostname — the exact exposure the guard exists for", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    fakeCloudflare(() => new Response("<html>subshell</html>", { status: 200 }));
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toEqual({
      refused: {
        text: "Cloudflare Access does not cover subshell.example.com yet. Create an Access application for it, then publish.",
      },
    });
  });

  it("refuses a 403 that carries no cf-access headers", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    fakeCloudflare(() => new Response("forbidden", { status: 403 }));
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("does not cover") } });
  });

  it("refuses a redirect that does not go to the team's Access host", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    fakeCloudflare(
      () => new Response(null, { status: 302, headers: { location: "https://somewhere-else.example.net/login" } }),
    );
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("does not cover") } });
  });

  it("fails closed when the check itself errors, carrying the vendor's own words", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND subshell.example.com");
    }) as unknown as typeof fetch;
    const outcome = await plugin.publish?.(ctx());
    if (!outcome || !("refused" in outcome)) {
      throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
    }
    const text = outcome.refused.text;
    // Named in pieces because it is a refusal built from the runtime's words:
    // the plugin's own sentence, the hostname, and whatever `fetch` said —
    // never a silent fall-through to publishing.
    expect(text).toContain("could not be confirmed");
    expect(text).toContain("subshell.example.com");
    expect(text).toContain("ENOTFOUND");
    expect(text).toContain("Nothing was published");
  });

  it("refuses when the connector vanished after the settings were saved", async () => {
    const { plugin } = scripted({}, { findBinary: async () => null, probeVersion: async () => null });
    fakeCloudflare(
      () => new Response(null, { status: 302, headers: { location: "https://myteam.cloudflareaccess.com/login" } }),
    );
    const outcome = await plugin.publish?.(ctx());
    expect(outcome).toMatchObject({ refused: { text: expect.stringContaining("not installed") } });
  });
});

/* ------------------------------------------------------------------ */
/* supervisedProcess and requestGuard                                  */
/* ------------------------------------------------------------------ */

describe("supervisedProcess", () => {
  it("describes the same child publish described, resolved from the host's ladder", async () => {
    const { plugin, host } = scripted({}, { probeVersion: async () => null });
    const spec = await plugin.supervisedProcess?.(ctx());
    expect(spec).toEqual({
      command: "/usr/bin/cloudflared",
      args: ["tunnel", "run", "--no-autoupdate"],
      secretEnv: { TUNNEL_TOKEN: "tunnel-token" },
    });
    // The lookup went through the manifest's own detection data.
    expect(host.calls).toEqual([]);
  });

  it("describes nothing when the token is absent — the child would only crash-loop", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    expect(await plugin.supervisedProcess?.(ctx({ tokenSet: false }))).toBeNull();
  });

  it("describes nothing when a setting is missing or the binary is gone", async () => {
    const { plugin } = scripted({}, { probeVersion: async () => null });
    expect(await plugin.supervisedProcess?.(ctx({ settings: { hostname: "sub.example.com" } }))).toBeNull();
    const noBinary = scripted({}, { findBinary: async () => null });
    expect(await noBinary.plugin.supervisedProcess?.(ctx())).toBeNull();
  });
});

describe("requestGuard", () => {
  it("declares the cloudflare-access check the host's guard consumes", () => {
    const { plugin } = scripted({});
    expect(plugin.requestGuard?.(ctx())).toEqual({
      kind: "cloudflare-access",
      hostname: "subshell.example.com",
      // The settings field is a bare team name; the guard spec wants the
      // issuer and JWKS HOST, and normalizing belongs here, at the one place
      // that reads the field.
      teamDomain: "myteam.cloudflareaccess.com",
      aud: "aud-tag-1",
    });
  });

  it("keeps a fully-qualified team domain as written", () => {
    const { plugin } = scripted({});
    const spec = plugin.requestGuard?.(ctx({ settings: { ...SETTINGS, teamDomain: "myteam.cloudflareaccess.com" } }));
    expect(spec?.teamDomain).toBe("myteam.cloudflareaccess.com");
  });

  it("normalizes a pasted URL spelling of the hostname", () => {
    // The placeholder shows a bare hostname; pasting `https://…/` into a
    // field is how people type URLs. The guard compares Host headers against
    // this string, so the scheme cannot survive it.
    const { plugin } = scripted({});
    const spec = plugin.requestGuard?.(ctx({ settings: { ...SETTINGS, hostname: "https://Sub.Example.com/" } }));
    expect(spec?.hostname).toBe("sub.example.com");
  });

  it("declares nothing when a guard input is missing", () => {
    const { plugin } = scripted({});
    expect(plugin.requestGuard?.(ctx({ settings: {} }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* unpublish and leave                                                 */
/* ------------------------------------------------------------------ */

describe("unpublish and leave", () => {
  it("unpublishes by doing nothing — the host stopped the process and drops the guard last", async () => {
    const { plugin, host, secretWrites } = scripted({});
    // § 5.3 ordering is implemented: step 1 is `disarmProcess`, awaited. A
    // plugin that stopped its own tunnel here would race the host that owns
    // it, and the token is NOT deleted here (unpublish keeps the join).
    await expect(plugin.unpublish?.(ctx())).resolves.toBeUndefined();
    expect(host.calls).toEqual([]);
    expect(secretWrites).toEqual([]);
  });

  it("leave deletes the token and runs nothing", async () => {
    const { plugin, host, secretWrites } = scripted({});
    await plugin.leave(ctx());
    expect(secretWrites).toEqual(["delete:tunnel-token"]);
    expect(host.calls).toEqual([]);
  });
});
