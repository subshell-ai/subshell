import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalled, readInstallRecord } from "@internal/pane-runtime";
import { run } from "../cli.js";
import { saveConfig } from "../config.js";
import { newHome } from "../test-preload.js";

/**
 * The `subshell plugin` verbs end to end through `run()`.
 *
 * The §2.5 embedded-first rules and the §2.7 fetch live inside pane-runtime's
 * `installPlugin` and are pinned upstream; what is pinned HERE is the CLI:
 * config → dataDir/registryUrl resolution, the human + `--json` output
 * shapes, the exit codes, and — the trap that matters — that an embedded
 * install NEVER dials the configured registry. The fake below records every
 * packument and tarball request it answers; the embedded-path tests assert
 * that log is empty, so a facade change that always fetches fails the test
 * rather than quietly succeeding against the fake.
 */

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-cli-"));
}

/** Enrolls a fresh config (home reset by beforeEach) aimed at `dataDir`. */
async function enrolled(dataDir: string, registryUrl?: string): Promise<void> {
  await saveConfig({
    serverUrl: "http://plane.local:3080",
    nodeId: "node_plugin_cli",
    nodeKey: "subshell_key_never_printed",
    controlPublicKey: '{"kty":"EC"}',
    dataDir,
    name: "cli-test",
    ...(registryUrl === undefined ? {} : { registryUrl }),
  });
}

/* ------------------------------------------------------------------ */
/* The fake registry (fixture duplicated from plugin-commands.test.ts: */
/* the upstream tgz helper is a package-internal test file).           */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

/** One 512-byte ustar header block: file typeflag, mode 644, zero uid/gid/mtime. */
function ustarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s.padEnd(len, "\0")).subarray(0, len), off);
  if (enc.encode(name).length > 100) throw new Error(`fixture name does not fit the ustar name field: ${name}`);
  put(name, 0, 100);
  put("644".padStart(7, "0"), 100, 8);
  put("0".padStart(7, "0"), 108, 8);
  put("0".padStart(7, "0"), 116, 8);
  put(size.toString(8).padStart(11, "0"), 124, 12);
  put("0".padStart(11, "0"), 136, 12);
  put("        ", 148, 8); // checksum placeholder, then the sum over the block
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  return h;
}

/**
 * A minimal LOADABLE plugin package as an npm tgz. "Loadable" is load-bearing:
 * the installer runs the real loader against the staging copy before the swap,
 * so the default entry satisfies every check (a factory declaring no
 * capabilities, modelled on pane-runtime's upstream fixture).
 */
function makePluginTgz(opts: { name: string; version: string; id: string }): Uint8Array<ArrayBuffer> {
  const manifest = {
    name: opts.name,
    version: opts.version,
    type: "module",
    subshell: {
      apiVersion: 1,
      id: opts.id,
      type: "agent-harness",
      name: "fixture",
      description: "fixture plugin",
      entry: "index.js",
    },
  };
  const blocks: Uint8Array[] = [];
  for (const [name, content] of [
    ["package/package.json", JSON.stringify(manifest)],
    [
      "package/index.js",
      "export default function fixture() { return { capabilities: () => [], buildCommand: (input) => [input.binary], validateProfile: () => ({ valid: true }) }; }\n",
    ],
  ] as const) {
    const body = enc.encode(content);
    blocks.push(ustarHeader(name, body.length));
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate
  const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    all.set(b, at);
    at += b.length;
  }
  return Bun.gzipSync(all);
}

/** One served package: name → latest + exact versions → tgz bytes. */
const served = new Map<string, { latest: string; versions: Record<string, Uint8Array<ArrayBuffer>> }>();
/** What the fake answered, per request kind. The embedded-path tests assert these stay EMPTY. */
const packumentHits: string[] = [];
const tarballHits: string[] = [];
let base = "";
let registry: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  registry = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p.startsWith("/tarball/")) {
        const rest = p.slice("/tarball/".length);
        const slash = rest.indexOf("/");
        const name = decodeURIComponent(rest.slice(0, slash));
        const version = decodeURIComponent(rest.slice(slash + 1)).replace(/\.tgz$/, "");
        tarballHits.push(`${name}@${version}`);
        const bytes = served.get(name)?.versions[version];
        return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
      }
      const name = p.slice(1).split("/").map(decodeURIComponent).join("/");
      packumentHits.push(name);
      const pkg = served.get(name);
      if (!pkg) return new Response("not found", { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const [v, tgz] of Object.entries(pkg.versions)) {
        versions[v] = {
          name,
          version: v,
          dist: {
            // Relative on purpose, as real registries announce: the client
            // resolves it against the base URL.
            tarball: `/tarball/${encodeURIComponent(name)}/${encodeURIComponent(v)}.tgz`,
            integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
          },
        };
      }
      return Response.json({ "dist-tags": { latest: pkg.latest }, versions });
    },
  });
  base = `http://127.0.0.1:${registry.port}`;
});
afterAll(() => registry?.stop(true));

beforeEach(() => {
  newHome();
  served.clear();
  packumentHits.length = 0;
  tarballHits.length = 0;
});

const tgz = (version: string) => makePluginTgz({ name: "third-party", version, id: "third" });
const tgzSec = (version: string) => makePluginTgz({ name: "second-party", version, id: "sec" });

/* ------------------------------------------------------------------ */

describe("plugin verbs with no config", () => {
  test("every verb exits 1 pointing at enroll (the `status` rule)", async () => {
    for (const argv of [
      ["plugin", "list"],
      ["plugin", "install", "pi"],
      ["plugin", "uninstall", "pi"],
      ["plugin", "update"],
    ]) {
      const res = await run(argv);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/enroll/i);
      // A runtime refusal, not a usage dump: the usage block belongs to exit 2.
      expect(res.err).not.toInclude("subshell: node agent daemon");
    }
  });
});

describe("plugin install, embedded path", () => {
  test("`plugin install pi` writes the embedded copy and NEVER dials the configured registry", async () => {
    const dir = tempDataDir();
    await enrolled(dir, base);
    const res = await run(["plugin", "install", "pi"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^installed pi@\d+\.\d+\.\d+\n$/);
    // THE TRAP: not one request left this process. Revert the facade to
    // always-fetch and this assertion fires (and the install itself breaks
    // too, since the fake serves no package named "pi").
    expect(packumentHits).toEqual([]);
    expect(tarballHits).toEqual([]);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["pi"]);
    // An embedded copy carries no sidecar, so `list` shows no package column.
    expect(await readInstallRecord(dir, "pi")).toBeNull();
  });

  test("a first install says nothing about restarting; re-installing the same id does", async () => {
    const dir = tempDataDir();
    await enrolled(dir, base);
    const first = await run(["plugin", "install", "pi"]);
    expect(first.code).toBe(0);
    expect(first.out).not.toInclude("restart");
    const again = await run(["plugin", "install", "pi"]);
    expect(again.code).toBe(0);
    expect(again.out).toInclude("note: a running agent keeps its loaded copy until restart");
  });
});

describe("plugin install, registry path", () => {
  test("`plugin install third-party@1.0.0` fetches from the configured registry and names the source", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    const res = await run(["plugin", "install", "third-party@1.0.0"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("installed third@1.0.0 (third-party)\n");
    expect(packumentHits).toContain("third-party");
    expect(await readInstallRecord(dir, "third")).toMatchObject({ name: "third-party", version: "1.0.0" });
    // A registry install does not print the restart note: nothing was there.
    expect(res.out).not.toInclude("restart");
  });

  test("the deps.plugin seam overrides BOTH the configured registry URL and the data dir", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    // The config points at a dead port and a data dir nothing may touch: an
    // install that succeeds could only have used the seam for both.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    await enrolled(`${dir}/never-written`, dead);
    const res = await run(["plugin", "install", "third-party@1.0.0"], { plugin: { dataDir: dir, registryUrl: base } });
    expect(res.code).toBe(0);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["third"]);
    expect(packumentHits).toContain("third-party");
  });

  test("an unreachable registry is exit 1 naming the URL, and writes nothing", async () => {
    const dir = tempDataDir();
    const probe = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    await enrolled(dir, dead);
    const res = await run(["plugin", "install", "third-party@1.0.0"]);
    expect(res.code).toBe(1);
    expect(res.err).toInclude(dead);
    expect(await listInstalled(dir)).toEqual([]);
  });
});

describe("plugin list", () => {
  test("--json answers the id-sorted rows; package fields appear only for sidecar'd installs", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "pi"])).code).toBe(0);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    const res = await run(["plugin", "list", "--json"]);
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.out) as Record<string, unknown>[];
    const piVersion = (await listInstalled(dir)).find((p) => p.id === "pi")?.version ?? "";
    expect(rows).toEqual([
      { id: "pi", version: piVersion },
      { id: "third", version: "1.0.0", package: "third-party", packageVersion: "1.0.0" },
    ]);
    // The KEY SET is the contract a GUI codes against, not just the values.
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "version"]);
    expect(Object.keys(rows[1] ?? {})).toEqual(["id", "version", "package", "packageVersion"]);
  });

  test("a directory that is not a plugin is reported broken, never omitted", async () => {
    const dir = tempDataDir();
    await enrolled(dir);
    mkdirSync(join(dir, "plugins", "zzbroken"), { recursive: true });
    const json = await run(["plugin", "list", "--json"]);
    expect(json.code).toBe(0);
    const rows = JSON.parse(json.out) as { id: string; version: string; broken?: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("zzbroken");
    expect(rows[0]?.broken).toContain("no package.json");
    const human = await run(["plugin", "list"]);
    expect(human.out).toInclude("zzbroken");
    expect(human.out).toInclude("(broken:");
  });

  test("the human lines are one per plugin: id, version, and the package column when it exists", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "pi"])).code).toBe(0);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    const res = await run(["plugin", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^pi \d+\.\d+\.\d+\n/m); // embedded: no column
    expect(res.out).toInclude("third 1.0.0 (from third-party@1.0.0)");
  });

  test("a node with no plugins says so in prose and answers [] in json", async () => {
    const dir = tempDataDir();
    await enrolled(dir);
    const human = await run(["plugin", "list"]);
    expect(human.code).toBe(0);
    expect(human.out.trim()).toBe("no plugins installed");
    const json = await run(["plugin", "list", "--json"]);
    expect(json.code).toBe(0);
    expect(json.out).toBe("[]\n");
  });
});

describe("plugin uninstall", () => {
  test("removes it and exits 0; uninstalling an absent id is the same success (idempotence is the contract)", async () => {
    const dir = tempDataDir();
    await enrolled(dir);
    expect((await run(["plugin", "install", "pi"])).code).toBe(0);
    const res = await run(["plugin", "uninstall", "pi"]);
    expect(res.code).toBe(0);
    expect(res.out).toInclude("uninstalled pi");
    expect(await listInstalled(dir)).toEqual([]);
    const again = await run(["plugin", "uninstall", "pi"]);
    expect(again.code).toBe(0);
    expect(again.out.trim()).not.toBe("");
    expect(await listInstalled(dir)).toEqual([]);
  });

  test("an unsafe id exits 1 naming the id rule, from assertSafeId, before anything is touched", async () => {
    const dir = tempDataDir();
    await enrolled(dir);
    const res = await run(["plugin", "uninstall", "../escape"]);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("invalid plugin id");
  });
});

describe("plugin update", () => {
  test("embedded-only installs report [] and never dial the registry", async () => {
    const dir = tempDataDir();
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "pi"])).code).toBe(0);
    packumentHits.length = 0;
    const res = await run(["plugin", "update", "--json"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("[]\n");
    expect(res.err).toBe("");
    // The update-side trap: a sidecar-less copy is never checked against a
    // registry, let alone upgraded from one behind its operator's back.
    expect(packumentHits).toEqual([]);
  });

  test("--json answers the PluginUpdate array verbatim, installs the newer bytes, and keeps stdout parseable", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    served.set("third-party", { latest: "1.1.0", versions: { "1.0.0": tgz("1.0.0"), "1.1.0": tgz("1.1.0") } });
    const res = await run(["plugin", "update", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual([{ id: "third", name: "third-party", from: "1.0.0", to: "1.1.0" }]);
    expect(await readInstallRecord(dir, "third")).toMatchObject({ version: "1.1.0" });
    // The restart note rides stderr, so stdout stays the whole JSON answer.
    expect(res.err).toInclude("note: a running agent keeps its loaded copy until restart");
  });

  test("already at or above latest is reported to:null and installs nothing", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    packumentHits.length = 0;
    tarballHits.length = 0;
    const res = await run(["plugin", "update", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual([{ id: "third", name: "third-party", from: "1.0.0", to: null }]);
    expect(res.err).toBe("");
    // The check ran; no second tarball moved.
    expect(packumentHits).toEqual(["third-party"]);
    expect(tarballHits).toEqual([]);
    expect(await readInstallRecord(dir, "third")).toMatchObject({ version: "1.0.0" });
  });

  test("the human lines name what moved, say when nothing did, and carry the note only when bytes changed", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    served.set("third-party", { latest: "1.1.0", versions: { "1.0.0": tgz("1.0.0"), "1.1.0": tgz("1.1.0") } });
    const moved = await run(["plugin", "update"]);
    expect(moved.code).toBe(0);
    expect(moved.out).toInclude("third 1.0.0 -> 1.1.0 (updated)");
    expect(moved.out).toInclude("note: a running agent keeps its loaded copy until restart");
    const settled = await run(["plugin", "update"]);
    expect(settled.code).toBe(0);
    expect(settled.out).toInclude("third 1.1.0 (already at latest)");
    expect(settled.out).not.toInclude("note:");
  });

  test("`plugin update <id>` checks and moves only that id", async () => {
    const dir = tempDataDir();
    served.set("third-party", { latest: "1.0.0", versions: { "1.0.0": tgz("1.0.0") } });
    served.set("second-party", { latest: "1.0.0", versions: { "1.0.0": tgzSec("1.0.0") } });
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "third-party@1.0.0"])).code).toBe(0);
    expect((await run(["plugin", "install", "second-party@1.0.0"])).code).toBe(0);
    served.set("third-party", { latest: "1.1.0", versions: { "1.0.0": tgz("1.0.0"), "1.1.0": tgz("1.1.0") } });
    served.set("second-party", { latest: "2.0.0", versions: { "1.0.0": tgzSec("1.0.0"), "2.0.0": tgzSec("2.0.0") } });
    const res = await run(["plugin", "update", "third", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual([{ id: "third", name: "third-party", from: "1.0.0", to: "1.1.0" }]);
    expect(await readInstallRecord(dir, "third")).toMatchObject({ version: "1.1.0" });
    expect(await readInstallRecord(dir, "sec")).toMatchObject({ version: "1.0.0" });
    expect(tarballHits).not.toContain("second-party@2.0.0");
  });

  test("an embedded-only node answers the human line and exits 0, not an error", async () => {
    const dir = tempDataDir();
    await enrolled(dir, base);
    expect((await run(["plugin", "install", "pi"])).code).toBe(0);
    const res = await run(["plugin", "update"]);
    expect(res.code).toBe(0);
    expect(res.out).toInclude("no updates found");
    expect(res.out).not.toInclude("note:");
  });
});
