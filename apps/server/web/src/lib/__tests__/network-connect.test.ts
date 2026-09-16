import { describe, expect, it } from "bun:test";
import { connectBlocker } from "@/lib/network-connect";
import type { NetworkRow, SettingsFieldWire } from "@/types/network";

/**
 * The pure gate behind the card's Connect / Sign-in buttons.
 *
 * This is `configurationRefusal`'s join variant read off the row rather than
 * off the server's context: the same fields, the same exemption for secrets,
 * the same satisfaction by a stored value or a non-blank default. The card
 * test proves the wiring; this proves the RULE, one row per interesting
 * difference.
 */

function rowWith(fields: SettingsFieldWire[], settings: NetworkRow["settings"] = {}): NetworkRow {
  return {
    id: "test-network",
    name: "Test Network",
    description: "",
    exposure: "private",
    platforms: ["darwin"],
    supported: true,
    enabled: true,
    interactiveLogin: true,
    publishImplicit: false,
    labels: {},
    privileged: [],
    settingsFields: fields,
    settings,
    published: false,
  };
}

const CONTROL_URL: SettingsFieldWire = {
  key: "controlUrl",
  label: "Control server URL",
  type: "string",
  required: true,
};

describe("connectBlocker", () => {
  it("names the first required non-secret the server would refuse on", () => {
    expect(connectBlocker(rowWith([CONTROL_URL]))).toBe("Save the Control server URL first.");
  });

  it("passes a row whose required field is stored", () => {
    expect(connectBlocker(rowWith([CONTROL_URL], { controlUrl: "https://headscale.example.com" }))).toBeNull();
  });

  it("treats a blank stored value as unset", () => {
    // Mirrors the server: `(settings[key] ?? "").trim() !== ""`. A stored
    // empty string is a field that was cleared, not one that is set.
    expect(connectBlocker(rowWith([CONTROL_URL], { controlUrl: "   " }))).toBe("Save the Control server URL first.");
  });

  it("treats a non-blank default as satisfied", () => {
    // The plugin will SEE the default, so demanding a retype would refuse a
    // configuration that already works — the server's rule, mirrored.
    expect(connectBlocker(rowWith([{ ...CONTROL_URL, default: "https://headscale.example.com" }]))).toBeNull();
  });

  it("does not treat a blank default as satisfied", () => {
    expect(connectBlocker(rowWith([{ ...CONTROL_URL, default: "" }]))).toBe("Save the Control server URL first.");
  });

  it("exempts required secrets, because the join is what delivers them", () => {
    // The paste box the buttons sit under IS this field's delivery door; a
    // gate demanding the store already hold the credential the act stores is
    // the contradiction that once made cloudflare's Connect structurally dead.
    const token: SettingsFieldWire = { key: "tunnel-token", label: "Tunnel token", type: "secret", required: true };
    expect(connectBlocker(rowWith([token]))).toBeNull();
    expect(connectBlocker(rowWith([token], { "tunnel-token": { set: false } }))).toBeNull();
  });

  it("ignores optional fields entirely", () => {
    const optional: SettingsFieldWire = { key: "region", label: "Region", type: "string" };
    expect(connectBlocker(rowWith([optional, CONTROL_URL]))).toBe("Save the Control server URL first.");
    expect(connectBlocker(rowWith([optional]))).toBeNull();
  });

  it("names the FIRST unset field, the one the server would refuse on first", () => {
    const hostname: SettingsFieldWire = { key: "hostname", label: "Hostname", type: "string", required: true };
    // hostname first AND set, control URL second and not: the answer names
    // the unset one, not the first field.
    expect(connectBlocker(rowWith([hostname, CONTROL_URL], { hostname: "subshell.example.com" }))).toBe(
      "Save the Control server URL first.",
    );
    // Reordered with control URL first and unset, it is the one named — the
    // server walks in declaration order and refuses on the first gap.
    expect(connectBlocker(rowWith([CONTROL_URL, hostname], { hostname: "subshell.example.com" }))).toBe(
      "Save the Control server URL first.",
    );
    // Both unset names the FIRST-DECLARED one — one sentence per press is
    // the server's behaviour, and the card mirrors it rather than listing.
    expect(connectBlocker(rowWith([hostname, CONTROL_URL]))).toBe("Save the Hostname first.");
    // And every field satisfied is no blocker at all.
    expect(
      connectBlocker(
        rowWith([CONTROL_URL, hostname], { hostname: "subshell.example.com", controlUrl: "https://hs.example.com" }),
      ),
    ).toBeNull();
  });

  it("passes a row that declares no fields at all", () => {
    // Tailscale's real shape: no settings, so the buttons are gated only by
    // the paste box itself.
    expect(connectBlocker(rowWith([]))).toBeNull();
  });
});
