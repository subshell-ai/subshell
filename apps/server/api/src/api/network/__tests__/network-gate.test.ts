import { describe, expect, it } from "bun:test";
import { builtInNetworkPlugins, type NetworkContext } from "@internal/pane-runtime";
import { configurationRefusal } from "@/api/network/network-gate.js";

/**
 * The settings/secret gate, run against the REAL built-in manifests.
 *
 * This is the seam the phases-2/3 review found untested: each plugin suite
 * calls its own `join`/`publish` directly, and the route suites drive fakes —
 * so the one combination no suite exercised was a real plugin's real
 * `settingsFields` passing through the real gate. Cloudflare's
 * required-secret `tunnel-token` was exactly that blind spot: the gate
 * demanded the token the join had not yet been allowed to store, which made
 * the Connect button structurally dead. A machine with no vendor CLI installed
 * can still run these: the gate reads `settingsFields` and a presence probe,
 * so nothing here spawns or reaches the network.
 */

/** The context of a configured-NO-THING host: no settings, no stored secrets. */
function emptyCtx(): NetworkContext {
  return { port: 3080, settings: {}, secrets: { has: () => false } };
}

function entry(id: string) {
  const found = builtInNetworkPlugins().find((e) => e.manifest.id === id);
  if (!found) throw new Error(`built-in network plugin "${id}" is missing from the registry`);
  return found;
}

describe("configurationRefusal across the real built-ins", () => {
  it("admits a cloudflare join with NOTHING stored — the token IS what join delivers", () => {
    // The bug this pins out of existence: `tunnel-token` is a REQUIRED
    // SECRET, and demanding the store hold it before join 409'd every first
    // Connect press. The exemption covers secrets ONLY — so the join is
    // still refused for the hostname, by name, proving both halves.
    const refusal = configurationRefusal(entry("cloudflare-tunnel"), emptyCtx(), "join");
    expect(refusal?.message).toContain("Hostname");
    expect(refusal?.message).not.toContain("Tunnel token");

    // With the three ordinary settings present, the join is admitted while
    // the token is still absent — which is the whole point of the act.
    const configured: NetworkContext = {
      port: 3080,
      settings: { hostname: "sub.example.com", teamDomain: "myteam", aud: "aud-1" },
      secrets: { has: () => false },
    };
    expect(configurationRefusal(entry("cloudflare-tunnel"), configured, "join")).toBeUndefined();
  });

  it("still demands the token at publish — delivery is join's, publishing is downstream", () => {
    const configured: NetworkContext = {
      port: 3080,
      settings: { hostname: "sub.example.com", teamDomain: "myteam", aud: "aud-1" },
      secrets: { has: () => false },
    };
    const refusal = configurationRefusal(entry("cloudflare-tunnel"), configured, "publish");
    expect(refusal?.status).toBe(409);
    expect(refusal?.message).toContain("Tunnel token");

    // And once the join has stored it, publish is admitted.
    const withToken: NetworkContext = { ...configured, secrets: { has: (n) => n === "tunnel-token" } };
    expect(configurationRefusal(entry("cloudflare-tunnel"), withToken, "publish")).toBeUndefined();
  });

  it("gates a headscale join on the control URL — no join delivers an ordinary setting", () => {
    // The exemption's boundary, on the sibling plugin that motivated the
    // two-step flow: `controlUrl` is required and NOT a secret, so join
    // still refuses until the settings form has saved it.
    const refusal = configurationRefusal(entry("headscale"), emptyCtx(), "join");
    expect(refusal?.status).toBe(409);
    expect(refusal?.message).toContain("Control server URL");

    const configured: NetworkContext = {
      port: 3080,
      settings: { controlUrl: "https://headscale.example.com" },
      secrets: { has: () => false },
    };
    expect(configurationRefusal(entry("headscale"), configured, "join")).toBeUndefined();
  });

  it("admits tailscale and netbird joins and publishes unconditionally", () => {
    // Tailscale declares no settings fields; NetBird's management URL is
    // optional. The gate must stay transparent for the plugins that shipped
    // phase 1 and 2 — their flows never had a required-field precondition.
    for (const id of ["tailscale", "netbird"]) {
      expect(configurationRefusal(entry(id), emptyCtx(), "join")).toBeUndefined();
      expect(configurationRefusal(entry(id), emptyCtx(), "publish")).toBeUndefined();
    }
  });
});
