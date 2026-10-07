import { describe, expect, it } from "bun:test";
import { parseSshConnectionSnapshot, SSH_FORBIDDEN_SNAPSHOT_FIELDS } from "../ssh-config.js";
import { SSH_MAX_PROXY_HOPS } from "../ssh-limits.js";
import {
  invalidSnapshotHygieneVariants,
  invalidSnapshotVariants,
  makeHop,
  makeSnapshot,
} from "./fixtures/ssh-fixtures.js";

/**
 * The Gate A snapshot grammar: what the node re-checks on every command, so
 * these refusals ARE the security story of §2's "configuration is executable"
 * rule at the boundary. A green suite here means a `ProxyCommand` cannot
 * reach a resolver's argv through a snapshot, whatever the plane stored.
 */
describe("parseSshConnectionSnapshot", () => {
  it("round-trips the canonical snapshot with every field intact", () => {
    const snapshot = makeSnapshot();
    expect(parseSshConnectionSnapshot(structuredClone(snapshot))).toEqual(snapshot);
  });

  it("accepts an all-null minimal snapshot (no user, no agent, no hops)", () => {
    const minimal = makeSnapshot({
      user: null,
      identityFiles: [],
      certificateFiles: [],
      authAgentSocket: null,
      knownHostsFiles: [],
      proxyJumps: [],
    });
    expect(parseSshConnectionSnapshot(minimal)).toEqual(minimal);
  });

  it("rebuilt output is not the input object (stray keys die with the copy)", () => {
    const input = { ...makeSnapshot(), proxyUseExec: true } as unknown as Record<string, unknown>;
    const out = parseSshConnectionSnapshot(input);
    expect(out).not.toBeNull();
    expect("proxyUseExec" in (out as unknown as Record<string, unknown>)).toBe(false);
    expect(out).not.toBe(input);
  });

  it("refuses every absent-forbidden member carrying a value", () => {
    for (const { field, snapshot } of invalidSnapshotVariants()) {
      expect(parseSshConnectionSnapshot(structuredClone(snapshot))).toBeNull();
      // The list is the documented eight; a fixture drift (a variant whose
      // field is not in the constant) fails right here, not in a downstream
      // matcher that forgot to check one.
      expect((SSH_FORBIDDEN_SNAPSHOT_FIELDS as readonly string[]).includes(field)).toBe(true);
    }
  });

  it("refuses explicit non-null spellings too (true, 0, empty string: only null is absent)", () => {
    for (const value of [true, false, 0, "", [], {}] as unknown[]) {
      expect(parseSshConnectionSnapshot({ ...makeSnapshot(), forwards: value })).toBeNull();
    }
  });

  it("hygiene refusals: option-like hosts, control characters, relative paths, bad ports, over-cap lists, missing keys", () => {
    for (const { field, snapshot } of invalidSnapshotHygieneVariants()) {
      expect(parseSshConnectionSnapshot(structuredClone(snapshot))).toBeNull();
      expect(field).not.toEqual("");
    }
  });

  it("a hop chain exactly at the cap parses; one past it does not", () => {
    const hops = Array.from({ length: SSH_MAX_PROXY_HOPS }, (_, i) => makeHop(i));
    expect(parseSshConnectionSnapshot(makeSnapshot({ proxyJumps: hops }))).not.toBeNull();
    expect(parseSshConnectionSnapshot(makeSnapshot({ proxyJumps: [...hops, makeHop(99)] }))).toBeNull();
  });

  it("an IPv6 literal host and a bracketed alias survive (colons are legal there)", () => {
    expect(parseSshConnectionSnapshot(makeSnapshot({ host: "[2001:db8::2]:22" }))).toBeNull(); // a port baked into host is NOT the shape; port is its own field
    expect(parseSshConnectionSnapshot(makeSnapshot({ host: "[2001:db8::2]" }))).not.toBeNull();
  });

  it("rejects null and non-objects whole", () => {
    expect(parseSshConnectionSnapshot(null)).toBeNull();
    expect(parseSshConnectionSnapshot("app02")).toBeNull();
    expect(parseSshConnectionSnapshot([])).toBeNull();
  });
});
