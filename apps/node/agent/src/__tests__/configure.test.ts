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
