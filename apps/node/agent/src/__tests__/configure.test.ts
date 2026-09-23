import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { configPath, loadConfig, type NodeConfig, saveConfig } from "../config.js";
import { runConfigure } from "../configure.js";
import { wsUrlFor } from "../daemon.js";
import { newHome } from "../test-preload.js";

/**
 * `subshell configure` — repoint an ENROLLED node at a different control-plane
 * address without re-enrolling.
 *
 * The point of the command is what it does NOT do. `enroll` overwrites
 * `config.json`, mints a second node row on the plane, spends a single-use
 * setup key and discards the node key whose only home was that file — so
 * "the server moved" had no non-destructive answer. This keeps the identity
 * and rewrites the address.
 */

const enrolled: NodeConfig = {
  serverUrl: "http://localhost:3080",
  nodeId: "11111111-2222-3333-4444-555555555555",
  nodeKey: "subshell_secret_never_printed",
  controlPublicKey: '{"kty":"EC","crv":"P-256"}',
  dataDir: "/tmp/node-data",
  name: "workstation",
  nodeWsUrl: "ws://localhost:3080/ws/node",
};

describe("runConfigure — repointing", () => {
  test("rewrites serverUrl and keeps every identity field byte-identical", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await runConfigure({ server: "https://subshell.example" });
    expect(result.serverUrl).toBe("https://subshell.example");
    const after = await loadConfig();
    expect(after.serverUrl).toBe("https://subshell.example");
    expect(after.nodeId).toBe(enrolled.nodeId);
    expect(after.nodeKey).toBe(enrolled.nodeKey);
    expect(after.controlPublicKey).toBe(enrolled.controlPublicKey);
    expect(after.dataDir).toBe(enrolled.dataDir);
    expect(after.name).toBe(enrolled.name);
  });

  /**
   * The load-bearing one. `nodeWsUrl` is what the OLD plane reported about
   * itself at enroll, and `resolveWsUrl` PREFERS it over any derivation — so
   * carrying it forward would leave the daemon dialing the old host forever
   * while `serverUrl` claimed otherwise, which is unexplainable from any
   * surface that shows one of the two.
   */
  test("CLEARS the enroll-time nodeWsUrl, so the daemon re-derives from the new address", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "https://subshell.example" });
    expect((await loadConfig()).nodeWsUrl).toBeUndefined();
    expect(readFileSync(configPath(), "utf8")).not.toContain("localhost:3080");
  });

  /**
   * The scheme is lower-cased, and that is a correctness fix rather than
   * cosmetics.
   *
   * `normalizeServer` returned the raw string with only trailing slashes
   * stripped, so `--server HTTP://X:3080` was stored verbatim — and
   * `wsUrlFor` builds the dial URL with `serverUrl.replace(/^http/, "ws")`,
   * a CASE-SENSITIVE regex. Measured: `HTTP://X:3080` came out as
   * `HTTP://X:3080/ws/node`, which is not a WebSocket URL at all, so the node
   * could never connect and nothing named the reason.
   */
  test("lower-cases the scheme, which wsUrlFor's replace depends on", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "HTTP://Box.Local:3080" });
    const stored = (await loadConfig()).serverUrl;
    expect(stored.startsWith("http://")).toBe(true);
    expect(wsUrlFor(stored)).toBe("ws://box.local:3080/ws/node");
  });

  test("a trailing slash is stripped, so the stored URL matches what enroll would write", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "https://subshell.example///" });
    expect((await loadConfig()).serverUrl).toBe("https://subshell.example");
  });

  /**
   * Surrounding whitespace is what a paste produces. The URL constructor
   * strips it to PARSE, so a padded value validates — and then the stored
   * string kept the padding, which `wsUrlFor` turns into a dial URL with
   * spaces in it. The Rust `validate_server_url` this app's GUI uses has
   * always trimmed, so untrimmed here meant two spellings of one
   * normalization.
   */
  test("surrounding whitespace is stripped, not merely tolerated by the parser", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "  https://subshell.example/  " });
    expect((await loadConfig()).serverUrl).toBe("https://subshell.example");
  });

  /**
   * The plane reads this file's `name` in exactly one place — the enroll POST
   * body — and never in `readyEvent` or the inventory event, so a repoint that
   * wrote it would change only what local `subshell status` prints while the
   * Nodes page kept the old name forever. Renaming belongs to the plane.
   */
  test("never touches the name — the control plane owns that", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "https://subshell.example" });
    expect((await loadConfig()).name).toBe("workstation");
  });

  test("keeps the config file at 0600 — it still holds the node key", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "https://subshell.example" });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test("repointing to the SAME address keeps the plane's own ws answer", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: enrolled.serverUrl });
    // The address did not change, so `nodeWsUrl` is still the plane's answer
    // rather than something to re-derive.
    expect((await loadConfig()).nodeWsUrl).toBe(enrolled.nodeWsUrl);
  });
});

/**
 * The dead phase-3 mirror key. `--registry-url` is gone with the node's
 * plugin concept (inversion spec 2026-09-10 §6), and `loadConfig` no longer
 * carries the field — so a repoint of an OLD config drops the key from disk
 * rather than preserving it. A config rewrite is the right scrubber: it is
 * the one write this command already owes the file.
 */
/**
 * `--key` — the rotated-key half of the command, added because the plane's
 * Rotate key shows the replacement ONCE and there was nowhere to put it. The
 * only prior answer was hand-editing the 0600 file (and an instruction naming
 * a `subshell config` command that never existed); re-enrolling instead would
 * mint a SECOND node row and spend a setup key to correct one field.
 */
describe("runConfigure — installing a rotated key", () => {
  test("replaces ONLY nodeKey: every other field survives verbatim", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await runConfigure({ key: "subshell_rotated_rotated_rotated" });
    expect(result.nodeKey).toBe("subshell_rotated_rotated_rotated");
    const after = await loadConfig();
    expect(after.nodeKey).toBe("subshell_rotated_rotated_rotated");
    // The identity rule the whole command rests on: the plane keeps seeing
    // THIS node, which is the difference between rotating and re-enrolling.
    expect(after.nodeId).toBe(enrolled.nodeId);
    expect(after.serverUrl).toBe(enrolled.serverUrl);
    expect(after.controlPublicKey).toBe(enrolled.controlPublicKey);
    expect(after.dataDir).toBe(enrolled.dataDir);
    expect(after.name).toBe(enrolled.name);
    // A key rotation changes nothing about WHERE the node dials, so the
    // plane's own enroll-time ws answer stays — clearing it is the --server
    // half's rule, not this one's.
    expect(after.nodeWsUrl).toBe(enrolled.nodeWsUrl);
  });

  test("surrounding whitespace from the paste is stripped, not stored", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ key: "  subshell_rotated_rotated_rotated\n" });
    expect((await loadConfig()).nodeKey).toBe("subshell_rotated_rotated_rotated");
  });

  test("keeps the config file at 0600 — the new key lives there", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ key: "subshell_rotated_rotated_rotated" });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test("--server and --key together do both edits in one write", async () => {
    newHome();
    await saveConfig(enrolled);
    await runConfigure({ server: "https://subshell.example", key: "subshell_rotated_rotated_rotated" });
    const after = await loadConfig();
    expect(after.serverUrl).toBe("https://subshell.example");
    expect(after.nodeKey).toBe("subshell_rotated_rotated_rotated");
    // The address changed, so the old plane's ws answer goes with it.
    expect(after.nodeWsUrl).toBeUndefined();
  });

  /**
   * The one confusion this command would otherwise create on its own: it
   * takes "a key", and the product has TWO key kinds. An `nsk_` setup key
   * stored as a bearer secret would leave the node dialing forever with a
   * credential that can never authenticate, and no surface can name that
   * cause. Refused by shape, before any write.
   */
  test("refuses a SETUP key by name and leaves the config untouched", async () => {
    newHome();
    await saveConfig(enrolled);
    const before = readFileSync(configPath(), "utf8");
    await expect(runConfigure({ key: "nsk_alpha_alpha_alpha_alpha_1" })).rejects.toThrow(/SETUP key/);
    await expect(runConfigure({ key: "nsk_alpha_alpha_alpha_alpha_1" })).rejects.toThrow(/subshell setup/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  test("refuses a blank --key (an empty bearer secret is a dead node, not an edit)", async () => {
    newHome();
    await saveConfig(enrolled);
    const before = readFileSync(configPath(), "utf8");
    await expect(runConfigure({ key: "   " })).rejects.toThrow(/--key/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  test("with neither flag, refuses instead of rewriting a 0600 file for nothing", async () => {
    newHome();
    await saveConfig(enrolled);
    const before = readFileSync(configPath(), "utf8");
    await expect(runConfigure({})).rejects.toThrow(/changes nothing/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("runConfigure — the stale registryUrl key does not survive a rewrite", () => {
  test("a repoint of a config that carries registryUrl writes one without it", async () => {
    newHome();
    writeFileSync(configPath(), JSON.stringify({ ...enrolled, registryUrl: "http://mirror.internal:4873" }), {
      mode: 0o600,
    });
    await runConfigure({ server: "https://subshell.example" });
    expect(readFileSync(configPath(), "utf8")).not.toContain("registryUrl");
    const after = await loadConfig();
    expect("registryUrl" in after).toBe(false);
    expect(after.serverUrl).toBe("https://subshell.example");
    expect(after.nodeKey).toBe(enrolled.nodeKey); // every identity rule above still holds
  });
});

describe("runConfigure — refusals, all before any write", () => {
  test("with no config at all, it points at enroll rather than inventing one", async () => {
    newHome();
    await expect(runConfigure({ server: "https://subshell.example" })).rejects.toThrow(/enroll/i);
    expect(() => readFileSync(configPath())).toThrow();
  });

  for (const bad of ["subshell.example", "ftp://subshell.example", "not a url"]) {
    test(`refuses an unusable --server '${bad}' and leaves the config untouched`, async () => {
      newHome();
      await saveConfig(enrolled);
      const before = readFileSync(configPath(), "utf8");
      await expect(runConfigure({ server: bad })).rejects.toThrow();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    });
  }

  test("a corrupt config is reported, never silently replaced", async () => {
    newHome();
    await saveConfig(enrolled);
    writeFileSync(configPath(), "{not json", { mode: 0o600 });
    await expect(runConfigure({ server: "https://subshell.example" })).rejects.toThrow();
    expect(readFileSync(configPath(), "utf8")).toBe("{not json");
  });
});
