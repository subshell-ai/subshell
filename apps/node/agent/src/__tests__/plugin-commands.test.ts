import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEmbedded, listInstalled, readInstallRecord } from "@internal/pane-runtime";
import type { NodeEvent } from "@internal/subshell-protocol";
import { execPluginInstall, execPluginUninstall } from "../commands/basics.js";
import type { CommandContext } from "../commands/context.js";
import { buildInventoryEvent, resetInventoryScanCache } from "../inventory.js";

/**
 * The two plugin commands.
 *
 * Both answer with the node's WHOLE set rather than the one plugin, because
 * the control plane mirrors what the node reports: a partial answer would
 * leave it guessing at the rest.
 */
/**
 * A context whose socket keeps what was sent, so the pushes are observable.
 * `registryUrl` rides on the config exactly as the daemon's loaded config
 * carries it (phase 3): absent means "use the default registry".
 */
function ctxFor(dataDir: string, registryUrl?: string): CommandContext & { sent: NodeEvent[] } {
  const sent: NodeEvent[] = [];
  return {
    sent,
    config: {
      serverUrl: "",
      nodeId: "n",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "n",
      ...(registryUrl === undefined ? {} : { registryUrl }),
    },
    nowMs: () => Date.now(),
    ws: {
      send(event: NodeEvent) {
        sent.push(event);
      },
    },
  } as unknown as CommandContext & { sent: NodeEvent[] };
}

/** The inventory events a context received, in order. */
function inventories(ctx: { sent: NodeEvent[] }): Extract<NodeEvent, { type: "inventory" }>[] {
  return ctx.sent.filter((e): e is Extract<NodeEvent, { type: "inventory" }> => e.type === "inventory");
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-cmd-"));
}

describe("plugin_install", () => {
  it("installs and answers with the whole set", async () => {
    const dir = tempDataDir();
    const result = await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "codex" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plugins = (result.data as { plugins: { id: string }[] }).plugins;
    expect(plugins.map((p) => p.id)).toEqual(["codex"]);
  });

  it("answers ok:false naming an unknown plugin", async () => {
    const result = await execPluginInstall(ctxFor(tempDataDir()), { type: "plugin_install", id: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("nope");
  });

  it("refuses an unsafe id before it reaches the filesystem", async () => {
    const result = await execPluginInstall(ctxFor(tempDataDir()), { type: "plugin_install", id: "../escape" });
    expect(result.ok).toBe(false);
  });
});

describe("plugin_uninstall", () => {
  it("removes it and answers with what remains", async () => {
    const dir = tempDataDir();
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "pi" });
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "codex" });
    const result = await execPluginUninstall(ctxFor(dir), { type: "plugin_uninstall", id: "pi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { removed: boolean; plugins: { id: string }[] };
    expect(data.removed).toBe(true);
    expect(data.plugins.map((p) => p.id)).toEqual(["codex"]);
  });

  it("SUCCEEDS when the plugin was already absent", async () => {
    // The caller asked for a state and that state holds. Failing here would
    // make a retry after a dropped connection look like a real failure.
    const result = await execPluginUninstall(ctxFor(tempDataDir()), { type: "plugin_uninstall", id: "pi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { removed: boolean }).removed).toBe(false);
  });

  it("leaves the node's other plugins alone", async () => {
    const dir = tempDataDir();
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "hermes" });
    await execPluginUninstall(ctxFor(dir), { type: "plugin_uninstall", id: "codex" });
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["hermes"]);
  });
});

describe("the inventory a plugin change pushes", () => {
  it("goes out on install, carrying the plugin that was just added", async () => {
    // The probe follows what is INSTALLED, so without this push the new
    // plugin has no row until the next cadence tick and the node page reads
    // "program not found" on a machine where the program is on the PATH.
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });

    const events = inventories(ctx);
    expect(events.length).toBe(1);
    expect(events[0]?.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
    expect(events[0]?.plugins?.map((p) => p.id)).toEqual(["codex"]);
  });

  it("goes out on uninstall, no longer carrying what was removed", async () => {
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });
    await execPluginUninstall(ctx, { type: "plugin_uninstall", id: "codex" });

    const events = inventories(ctx);
    expect(events.length).toBe(2);
    expect(events[1]?.harnesses).toEqual([]);
  });

  it("drops the scan memo, so the push is not the probe from before the change", async () => {
    // The memo coalesces the inventories that land together on a connection.
    // Reusing one across an install is precisely the staleness it must not
    // introduce: two installs a moment apart must report different sets.
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });
    await execPluginInstall(ctx, { type: "plugin_install", id: "pi" });

    const events = inventories(ctx);
    expect(events[0]?.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
    expect(events[1]?.harnesses.map((h) => h.harnessId)).toEqual(["codex", "pi"]);
  });
});

describe("an inventory built with no data dir", () => {
  it("does not poison the memo for the callers that have one", async () => {
    // It answers empty because there is nothing to probe, which is fine. What
    // is not fine is caching that empty answer under the key a real probe
    // shares: one such call used to blank the inventory for ten seconds.
    resetInventoryScanCache();
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");

    await buildInventoryEvent(Date.now());
    const real = await buildInventoryEvent(Date.now(), undefined, dir);
    expect(real.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
  });
});

/**
 * The in-file fake registry and tarball fixture for the phase-3 `spec`
 * branch. The §2.5 embedded-first rules and the §2.7 fetch live inside
 * `installPlugin` and are pinned upstream in pane-runtime's
 * `install-registry.test.ts`; what is pinned HERE is the agent-side seam:
 * `spec` and `ctx.config.registryUrl` ride from the command frame into that
 * call, a registry install answers like any other install, and a fetch
 * failure comes back as `ok:false` rather than a throw. (The upstream tgz
 * helper is a package-internal test file, so the writer is duplicated at
 * this size on purpose.)
 */

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
/** Packument requests the fake answered, in order. */
const packumentHits: string[] = [];
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

describe("plugin_install with a registry spec (phase 3)", () => {
  it("installs against the configured registry: answers the whole set and pushes the inventory", async () => {
    resetInventoryScanCache();
    const dir = tempDataDir();
    served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    const ctx = ctxFor(dir, base);
    const result = await execPluginInstall(ctx, { type: "plugin_install", id: "third", spec: "third-party@1.0.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plugins = (result.data as { plugins: { id: string }[] }).plugins;
    expect(plugins.map((p) => p.id)).toEqual(["third"]);
    // The fake was actually dialed. A handler still pinned to the embedded
    // copy answers "no built-in plugin 'third' in this build", never ok.
    expect(packumentHits).toContain("third-party");
    // The pushed inventory is the second signal after the result frame: the
    // probe follows what is installed, so without it the node page reads
    // "program not found" until the next cadence tick.
    const events = inventories(ctx);
    expect(events.length).toBe(1);
    expect(events[0]?.plugins?.map((p) => p.id)).toEqual(["third"]);
    // And the answer is a registry install, sidecar and all.
    expect(await readInstallRecord(dir, "third")).toMatchObject({ name: "third-party", version: "1.0.0" });
  });

  it("an unreachable registryUrl answers ok:false naming the URL", async () => {
    // Grab a port, then stop the server: nothing listens there anymore.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const result = await execPluginInstall(ctxFor(tempDataDir(), dead), {
      type: "plugin_install",
      id: "third",
      spec: "third-party@1.0.0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(dead);
  });

  it("with NO registryUrl configured the install still reaches the default registry", async () => {
    // `registryUrl` is a MIRROR knob, not a switch: unset must not refuse the
    // spec and must not fall back to the embedded copy. The package name is
    // one this fake serves and npm does not, so the fake must stay silent
    // while the answer names the default host. Both fetch outcomes satisfy
    // the assertion: online the packument 404s with the URL in the message,
    // offline the failed fetch throws "could not reach the registry at
    // https://registry.npmjs.org". The generous timeout covers only the
    // worst-case fetch timeout of the offline path.
    packumentHits.length = 0;
    const result = await execPluginInstall(ctxFor(tempDataDir()), {
      type: "plugin_install",
      id: "phantom",
      spec: "subshell-phantom-zx8743@1.0.0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("registry.npmjs.org");
    expect(packumentHits).toEqual([]);
  }, 25_000);
});
