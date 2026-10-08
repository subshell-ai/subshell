import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MachinePin, MachinePinStore, machinePinPath } from "../machine-pin-store.js";

/**
 * Relay pins are raw PUBLIC JWK strings; byte equality runs on these exact
 * strings (spec 2026-10-08 §4.4), so the fixtures are just distinct opaque
 * texts. Fingerprints are a display concern (ssh-pin-store.ts), not a store
 * concern.
 */
const keyA: MachinePin = {
  signing: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}',
  encryption: '{"kty":"EC","crv":"P-256","x":"CCC","y":"DDD"}',
};
const keyB: MachinePin = {
  signing: '{"kty":"EC","crv":"P-256","x":"EEE","y":"FFF"}',
  encryption: '{"kty":"EC","crv":"P-256","x":"GGG","y":"HHH"}',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "subshell-mpin-"));
}

test("pins land in ssh-machine-pins.json, a file DISTINCT from the pane channels' peers.json", () => {
  const dir = freshDir();
  // The channel TOFU store (mcp-core pin-store.ts) lives at <mcpDataDir>/peers.json.
  // The relay store must never read or write it, so it is a different name.
  expect(machinePinPath(dir)).toBe(join(dir, "ssh-machine-pins.json"));
  expect(machinePinPath(dir)).not.toBe(join(dir, "peers.json"));

  const peersFile = join(dir, "peers.json");
  writeFileSync(peersFile, '{"principal:other":"{"untouched":true}"}', { mode: 0o600 });
  const store = new MachinePinStore(dir);
  store.pin("node-1", keyA);
  store.check("node-1", keyA);
  // The channel pin file rides through byte-identical: the relay store has its
  // own path and never borrows the channels'.
  expect(readFileSync(peersFile, "utf8")).toBe('{"principal:other":"{"untouched":true}"}');
});

test("the pin file is 0600 after write, and a pre-existing looser mode is repaired", () => {
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  store.pin("node-1", keyA);
  expect(statSync(machinePinPath(dir)).mode & 0o777).toBe(0o600);
  // A hand-chmod or a umask surprise never survives the next write: chmodSync
  // after writeFileSync is load-bearing, since O_CREAT's mode is masked by the
  // umask and ignored for an existing file.
  chmodSync(machinePinPath(dir), 0o644);
  store.pin("node-2", keyB);
  expect(statSync(machinePinPath(dir)).mode & 0o777).toBe(0o600);
});

test("get returns the raw pinned strings verbatim; an unknown peer has no pin", () => {
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  expect(store.get("node-1")).toBe(null);
  store.pin("node-1", keyA);
  // Byte-for-byte round trip: the stored material is exactly what was pinned,
  // not a re-serialization.
  expect(store.get("node-1")).toEqual(keyA);
});

test("check is byte equality on both halves: ok for the same bytes, changed for either half moving", () => {
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  store.pin("node-1", keyA);
  expect(store.check("node-1", keyA)).toBe("ok");
  expect(store.check("node-1", { ...keyA, signing: keyB.signing })).toBe("changed");
  expect(store.check("node-1", { ...keyA, encryption: keyB.encryption })).toBe("changed");
});

test("check compares the RAW strings, not fingerprints: a reordered serialization of the same key is 'changed'", () => {
  // The store's comparison rule mirrors pin-store.ts: byte equality on the
  // stored material (§4.4). KEY display hashes DER, but a candidate that
  // re-serializes the same key is NOT the plane delivering the registered
  // bytes, so strictness says "changed" here; the equality the store enforces
  // is on the raw strings.
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  store.pin("node-1", keyA);
  const reordered = JSON.parse(keyA.signing);
  const reorderedSigning = JSON.stringify({ y: reordered.y, x: reordered.x, crv: reordered.crv, kty: reordered.kty });
  expect(store.check("node-1", { signing: reorderedSigning, encryption: keyA.encryption })).toBe("changed");
});

test("check on an unpinned peer is 'changed': the store fails closed, it never seals-to or verifies-to an unpinned stranger", () => {
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  expect(store.check("never-seen", keyA)).toBe("changed");
});

test("pins persist across store instances and multiple peers coexist; re-pin replaces one entry", () => {
  const dir = freshDir();
  new MachinePinStore(dir).pin("node-1", keyA);
  new MachinePinStore(dir).pin("node-2", keyB);
  const reopened = new MachinePinStore(dir);
  expect(reopened.get("node-1")).toEqual(keyA);
  expect(reopened.get("node-2")).toEqual(keyB);
  // §4.5's re-pair replaces the stored pin for that peer and only that peer.
  reopened.pin("node-1", keyB);
  expect(reopened.get("node-1")).toEqual(keyB);
  expect(reopened.get("node-2")).toEqual(keyB);
  expect(reopened.check("node-1", keyA)).toBe("changed");
});

test("a corrupt pin file is quarantined and throws; it is never read as an empty pin set", () => {
  const dir = freshDir();
  const store = new MachinePinStore(dir);
  store.pin("node-1", keyA);
  writeFileSync(machinePinPath(dir), "{ definitely not json");
  // Fail closed on FIRST read: an unreadable pin set must not silently become
  // "no pins" (the pin-store.ts / identity.ts doctrine). The unreadable file
  // is moved aside, its bytes preserved for the operator.
  expect(() => store.get("node-1")).toThrow();
  const quarantined = readdirSync(dir).filter((f) => f.includes("corrupt"));
  expect(quarantined.length).toBe(1);
  expect(readFileSync(join(dir, quarantined[0]), "utf8")).toContain("definitely not json");
  // Only after quarantine does the store read empty; a re-pin works again.
  expect(store.get("node-1")).toBe(null);
  store.pin("node-1", keyA);
  expect(store.check("node-1", keyA)).toBe("ok");
  // check() fail-closes the same way: a junk file is never an "empty pin set",
  // and a wrong-shape entry is junk too.
  writeFileSync(machinePinPath(dir), "[]");
  expect(() => store.check("node-1", keyA)).toThrow();
});

test("SUBSHELL_CHANNEL_PIN has NO effect on this store: it is always strict", () => {
  // The channel escape hatch (SUBSHELL_CHANNEL_PIN=trust) is pinned OUT of the
  // relay path: setting it must not soften a byte-equality verdict nor skip
  // writing the file (spec 2026-10-08 §4.4: "never its escape hatch").
  const previous = process.env.SUBSHELL_CHANNEL_PIN;
  process.env.SUBSHELL_CHANNEL_PIN = "trust";
  try {
    const dir = freshDir();
    const store = new MachinePinStore(dir);
    store.pin("node-1", keyA);
    expect(store.check("node-1", keyB)).toBe("changed");
    expect(statSync(machinePinPath(dir)).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env.SUBSHELL_CHANNEL_PIN;
    else process.env.SUBSHELL_CHANNEL_PIN = previous;
  }
});

test("the source never consults SUBSHELL_CHANNEL_PIN (code, not prose, is scanned)", () => {
  // The header comment NAMES the env var to say the store never reads it; the
  // load-bearing fact is that no CODE expression touches it. Comments stripped
  // first, then even the word may not appear.
  const source = readFileSync(new URL("../machine-pin-store.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  expect(source).not.toMatch(/SUBSHELL_CHANNEL_PIN/);
  expect(source).not.toMatch(/process\.env/);
});
