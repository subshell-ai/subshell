import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientHome, configPath, loadConfig, type NodeConfig, saveConfig, updateConfig } from "../config.js";
import { newHome } from "../test-preload.js";

const sample: NodeConfig = {
  serverUrl: "http://localhost:4000",
  nodeId: "node_123",
  nodeKey: "subshell_secret_never_printed",
  controlPublicKey: '{"kty":"EC","crv":"P-256"}',
  dataDir: "/tmp/somewhere",
  name: "workstation",
  // The link-encryption pair (spec 2026-09-24 §3) rides the round-trip tests
  // too: `saveConfig → loadConfig` with them present proves the field-by-field
  // rebuild in `loadConfig` models both (the merge discipline below).
  encryptKeyPair: { publicKey: "cHViLWJhbGQ", privateKey: "cHJpdi1iYWxk" },
  controlEncryptPublicKey: "c3J2LXB1Yi1iYWxk",
};

test("saveConfig → loadConfig round-trip with 0600 file and 0700 dir", async () => {
  newHome();
  await saveConfig(sample);
  expect(await loadConfig()).toEqual(sample);
  // Unconditional mode assert: every supported target is POSIX (spec §8 — the
  // agent ships macos/linux only), and bun:test runs on the dev host anyway.
  expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(configPath())).mode & 0o777).toBe(0o700);
});

test("saveConfig re-applies the mode when umask interfered", async () => {
  newHome();
  await saveConfig(sample);
  // Simulate a permissive umask having widened the file: save must re-tighten.
  writeFileSync(configPath(), JSON.stringify({ ...sample, name: "second" }));
  chmodSync(configPath(), 0o644);
  await saveConfig({ ...sample, name: "second" });
  expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  expect((await loadConfig()).name).toBe("second");
});

test("nodeWsUrl round-trips when present; an old config loads without it (ledger 17c)", async () => {
  newHome();
  // Enroll now persists the server-reported ws URL; load must hand it back verbatim.
  const pinned = { ...sample, nodeWsUrl: "wss://subshell.example/ws/node" };
  await saveConfig(pinned);
  expect(await loadConfig()).toEqual(pinned);
  // Old config on disk (no nodeWsUrl): tolerated — the field is simply absent and
  // the daemon falls back to the derived URL.
  writeFileSync(configPath(), JSON.stringify(sample));
  const old = await loadConfig();
  expect(old.nodeWsUrl).toBeUndefined();
  expect(old).toEqual(sample);
});

test("a hand-edited empty/blank nodeWsUrl is junk → absent, so resolveWsUrl derives (never dials '')", async () => {
  newHome();
  // enroll only persists a non-empty server answer, so "" on disk is a
  // hand-edit; the daemon's `??` would otherwise pin an empty dial target.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: "" }));
  const empty = await loadConfig();
  expect(empty.nodeWsUrl).toBeUndefined();
  expect(empty).toEqual(sample);
  // Whitespace-only is the same junk class.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: "   " }));
  expect((await loadConfig()).nodeWsUrl).toBeUndefined();
  // A non-string value was always junk-tolerated the same way — unchanged.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: 42 }));
  expect((await loadConfig()).nodeWsUrl).toBeUndefined();
});

/**
 * The phase-3 registry mirror key is DEAD (inversion spec 2026-09-10 §6: the
 * node installs nothing), but configs written before its removal still carry
 * it. `loadConfig` rebuilds the object field by field, so the key is dropped
 * on the way to the daemon and the next `configure` rewrite scrubs it from
 * disk — an old config must load as exactly the shape this code understands,
 * junk keys included.
 */
test("a stale registryUrl key is inert: loadConfig drops it, the loaded shape is exactly NodeConfig", async () => {
  newHome();
  for (const junk of ["http://mirror.internal:4873", "", "   ", 42]) {
    writeFileSync(configPath(), JSON.stringify({ ...sample, registryUrl: junk }));
    const loaded = await loadConfig();
    expect("registryUrl" in loaded).toBe(false);
    expect(loaded).toEqual(sample);
  }
});

test("pane-log retention fields round-trip; junk is dropped to absent like nodeWsUrl", async () => {
  newHome();
  const pinned = { ...sample, logRetentionDays: 0, logRetentionHours: 6 };
  await saveConfig(pinned);
  expect(await loadConfig()).toEqual(pinned); // 0 is a real value here (half of the keep-forever pair)
  for (const junk of [-1, 1.5, "many", null]) {
    writeFileSync(configPath(), JSON.stringify({ ...sample, logRetentionDays: junk }));
    expect((await loadConfig()).logRetentionDays).toBeUndefined();
  }
  // An older config (never touched the fields) loads with them absent — the
  // resolver reads that as the one-day default.
  writeFileSync(configPath(), JSON.stringify(sample));
  const old = await loadConfig();
  expect(old.logRetentionDays).toBeUndefined();
  expect(old.logRetentionHours).toBeUndefined();
});

/**
 * The link-encryption fields (spec 2026-09-24 §3). The happy round-trip rides
 * `sample` through every test above; these pin the two edges of the doctrine:
 * junk never becomes a corruption verdict, and a legacy config (written before
 * the feature) loads with them absent — REQUIRED_FIELDS does NOT list them, so
 * the new binary self-heals them on first connect (§5).
 */
test("link-keypair fields: a half-keyed or junk shape loads as absent, never corrupt", async () => {
  newHome();
  // A half-keyed object cannot complete a handshake and can only come from a
  // hand-edit or a torn write — re-registration, not a corruption throw.
  for (const junk of [{ publicKey: "only-one-half" }, { privateKey: "only-one-half" }, "pub-only", 42, null]) {
    writeFileSync(configPath(), JSON.stringify({ ...sample, encryptKeyPair: junk }));
    expect((await loadConfig()).encryptKeyPair).toBeUndefined();
  }
  // Blank halves are hand-edit junk (enroll never persists them), same class
  // as a blank nodeWsUrl.
  writeFileSync(configPath(), JSON.stringify({ ...sample, encryptKeyPair: { publicKey: "", privateKey: "q" } }));
  expect((await loadConfig()).encryptKeyPair).toBeUndefined();
  for (const junk of ["", "   ", 42, null]) {
    writeFileSync(configPath(), JSON.stringify({ ...sample, controlEncryptPublicKey: junk }));
    expect((await loadConfig()).controlEncryptPublicKey).toBeUndefined();
  }
});

test("a config lacking both link-keypair fields loads unchanged (legacy boots, spec §5)", async () => {
  newHome();
  const legacy: NodeConfig = { ...sample };
  delete legacy.encryptKeyPair;
  delete legacy.controlEncryptPublicKey;
  writeFileSync(configPath(), JSON.stringify(legacy));
  const old = await loadConfig();
  expect(old.encryptKeyPair).toBeUndefined();
  expect(old.controlEncryptPublicKey).toBeUndefined();
  // Nothing invented: the loaded shape is exactly the legacy file's fields.
  expect(old).toEqual(legacy);
});

test("loadConfig throws an actionable error when no config exists", async () => {
  newHome();
  await expect(loadConfig()).rejects.toThrow(/enroll/);
});

test("loadConfig reports corruption as corrupt, not missing", async () => {
  newHome();
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), "{ not json");
  await expect(loadConfig()).rejects.toThrow(/corrupt/);
});

test("loadConfig rejects a JSON file that is not a usable config object", async () => {
  newHome();
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ serverUrl: "http://x" }));
  await expect(loadConfig()).rejects.toThrow(/corrupt/);
});

test("debugLogging round-trips: false and true are real values, junk is absent", async () => {
  // `updateConfig` re-reads through THIS loader, so a field dropped here is
  // silently cleared by every unrelated write — and `loadAndApplyDebugLogging`
  // can only restore what this returns.
  newHome();
  for (const stored of [true, false] as const) {
    await saveConfig({ ...sample, debugLogging: stored });
    expect(await loadConfig()).toEqual({ ...sample, debugLogging: stored });
  }
  writeFileSync(configPath(), JSON.stringify({ ...sample, debugLogging: "yes" }));
  expect((await loadConfig()).debugLogging).toBeUndefined();
});

/**
 * The merge discipline every live writer goes through (round-3 review,
 * finding 3): a read fresh AT SAVE TIME, named keys only. The defect it closes
 * is the two-dashboard-writers race — retention and debug-logging each used to
 * `loadConfig → mutate → saveConfig` the WHOLE file, so an interleaved pair
 * silently reverted one another's fields on a file that is also the node key's
 * only home.
 */
describe("updateConfig", () => {
  test("applies ONLY the named keys; every other field survives", async () => {
    newHome();
    await saveConfig({ ...sample, debugLogging: true, logRetentionDays: 7, logRetentionHours: 3 });
    const written = await updateConfig({ logRetentionDays: 1 });
    expect(written.logRetentionDays).toBe(1);
    const onDisk = await loadConfig();
    expect(onDisk.logRetentionDays).toBe(1);
    expect(onDisk.logRetentionHours).toBe(3);
    expect(onDisk.debugLogging).toBe(true);
    expect(onDisk.nodeKey).toBe(sample.nodeKey); // the credential rides along untouched
  });

  test("an interleaved pair lands BOTH fields (the lost update, fixed)", async () => {
    newHome();
    await saveConfig({ ...sample, debugLogging: false, logRetentionDays: 1 });
    // The OLD shape, replayed as the contrast it replaces: writing from a
    // snapshot read before the other writer saved reverts that writer.
    const stale = await loadConfig();
    await updateConfig({ debugLogging: true }); // "B saves"
    await saveConfig({ ...stale, logRetentionDays: 5 }); // "A saves" the old way
    expect((await loadConfig()).debugLogging).toBe(false); // B's write, silently gone
    // The NEW shape: each save re-reads, so neither can revert the other.
    await saveConfig({ ...sample, debugLogging: false, logRetentionDays: 1 });
    const alsoStale = await loadConfig(); // "A reads"
    await updateConfig({ debugLogging: true }); // "B saves"
    await updateConfig({ logRetentionDays: 5 }); // "A saves" — re-read at save time
    const both = await loadConfig();
    expect(both.debugLogging).toBe(true);
    expect(both.logRetentionDays).toBe(5);
    expect(alsoStale).not.toEqual(both); // the snapshot really was stale; the merge wasn't
  });

  /**
   * THE field-by-field test (spec 2026-09-24 §3): a `debugLogging` write over a
   * config that carries the link keypair must preserve BOTH new fields. This
   * only passes because `loadConfig` names `encryptKeyPair` and
   * `controlEncryptPublicKey` explicitly in its rebuild — a spread of the raw
   * parse would pass it too, but then the registryUrl-drop doctrine and the
   * junk guards could not exist, and the next field that needs modelling would
   * be forgotten the way `debugLogging` was until the retention race forced it.
   */
  test("an unrelated debugLogging write preserves the link keypair and the server pin", async () => {
    newHome();
    await saveConfig({
      serverUrl: sample.serverUrl,
      nodeId: sample.nodeId,
      nodeKey: sample.nodeKey,
      controlPublicKey: sample.controlPublicKey,
      dataDir: sample.dataDir,
      name: sample.name,
      encryptKeyPair: { publicKey: "cHViLWJhbGQ", privateKey: "cHJpdi1iYWxk" },
      controlEncryptPublicKey: "c3J2LXB1Yi1iYWxk",
    });
    await updateConfig({ debugLogging: true });
    const onDisk = await loadConfig();
    expect(onDisk.encryptKeyPair).toEqual({ publicKey: "cHViLWJhbGQ", privateKey: "cHJpdi1iYWxk" });
    expect(onDisk.controlEncryptPublicKey).toBe("c3J2LXB1Yi1iYWxk");
    expect(onDisk.debugLogging).toBe(true);
    expect(onDisk.nodeKey).toBe(sample.nodeKey); // the neighbouring credential also survives
  });

  test("overlap on ONE key is last-writer-wins, and only that key", async () => {
    newHome();
    await saveConfig({ ...sample, debugLogging: true, logRetentionHours: 4 });
    await updateConfig({ logRetentionDays: 2 });
    await updateConfig({ logRetentionDays: 9 });
    const onDisk = await loadConfig();
    expect(onDisk.logRetentionDays).toBe(9);
    expect(onDisk.debugLogging).toBe(true);
    expect(onDisk.logRetentionHours).toBe(4);
  });

  test("an explicit undefined CLEARS the field; an omitted key does not", async () => {
    newHome();
    await saveConfig({ ...sample, nodeWsUrl: "wss://old.invalid/ws", logRetentionDays: 8 });
    const cleared = await updateConfig({ nodeWsUrl: undefined });
    expect(cleared.nodeWsUrl).toBeUndefined();
    expect((await loadConfig()).nodeWsUrl).toBeUndefined();
    expect((await loadConfig()).logRetentionDays).toBe(8); // untouched
  });

  test("no config means no merge — the error points at enroll, nothing is created", async () => {
    newHome();
    await expect(updateConfig({ debugLogging: true })).rejects.toThrow(/enroll/);
  });
});

describe("clientHome", () => {
  test("defaults to ~/.config/subshell with no env override", () => {
    const saved = process.env.SUBSHELL_CONFIG_HOME;
    delete process.env.SUBSHELL_CONFIG_HOME;
    try {
      // homedir() is host truth; assert the tail, not the whole path.
      expect(clientHome().endsWith(join(".config", "subshell"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SUBSHELL_CONFIG_HOME;
      else process.env.SUBSHELL_CONFIG_HOME = saved;
    }
  });

  test("SUBSHELL_CONFIG_HOME overrides the default", () => {
    const dir = newHome();
    process.env.SUBSHELL_CONFIG_HOME = dir;
    expect(clientHome()).toBe(dir);
  });
});
