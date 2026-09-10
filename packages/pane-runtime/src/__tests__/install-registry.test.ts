import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuiltIn } from "../builtin-source.js";
import {
  installPlugin,
  listInstalled,
  pluginsDir,
  readInstallRecord,
  refreshStaleBuiltIns,
  resetPluginLogForTests,
  resolvePluginUpdates,
  setPluginLog,
} from "../plugins-dir.js";
import { makePluginTgz, makeTgz } from "./helpers/tgz-fixture.js";

/**
 * The install facade: one door for embedded and registry installs, with the
 * spec §2.5 rules, an `install.json` sidecar riding inside the swap, and a
 * load-check that runs BEFORE anything moves.
 */

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "install-registry-"));
}

/** One package the fake registry serves: exact version -> tgz bytes. */
interface ServedPackage {
  latest: string;
  /** Extra dist-tags, e.g. `{ bad: "9.9.9" }` so `pkg@bad` resolves. */
  tags?: Record<string, string>;
  versions: Record<string, Uint8Array>;
  /** Announce a digest that does NOT match the served bytes. */
  tamper?: boolean;
}

const served = new Map<string, ServedPackage>();
const WRONG_SRI = `sha512-${createHash("sha512").update("not the tarball").digest("base64")}`;
const packumentHits: string[] = [];
let trapHits = 0;
let base = "";
let trapBase = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let trapServer: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  server = Bun.serve({
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
            // Relative on purpose: mirrors what registries and mirrors
            // (verdaccio) actually announce, which the client resolves
            // against the base URL.
            tarball: `/tarball/${encodeURIComponent(name)}/${encodeURIComponent(v)}.tgz`,
            integrity: pkg.tamper ? WRONG_SRI : `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
          },
        };
      }
      return Response.json({ "dist-tags": { latest: pkg.latest, ...pkg.tags }, versions });
    },
  });
  trapServer = Bun.serve({
    port: 0,
    fetch() {
      trapHits += 1;
      return new Response("the registry must not be reached", { status: 500 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  trapBase = `http://127.0.0.1:${trapServer.port}`;
});
afterAll(() => {
  server?.stop(true);
  trapServer?.stop(true);
});

/** The real pi built-in's bytes re-published as another version: same id, same loadable code. */
async function builtInAsTgz(id: string, version: string): Promise<Uint8Array> {
  const src = await readBuiltIn(id);
  if (!src) throw new Error(`fixture needs the '${id}' built-in to exist in this build`);
  const pkg = JSON.parse(src.files["package.json"] ?? "{}") as { version?: string };
  pkg.version = version;
  return makeTgz([
    { path: "package/package.json", content: JSON.stringify(pkg) },
    ...Object.entries(src.files)
      .filter(([rel]) => rel !== "package.json")
      .map(([rel, content]) => ({ path: `package/${rel}`, content })),
  ]);
}

describe("installPlugin", () => {
  it("a bare built-in id never touches the network (spec §2.5 rule 1)", async () => {
    const dir = tempDataDir();
    trapHits = 0;
    const p = await installPlugin(dir, { id: "pi", spec: "pi", registryUrl: trapBase });
    expect(p.id).toBe("pi");
    expect(p.broken).toBeUndefined();
    // The v1 meaning, unchanged: id with no spec is an embedded install.
    const q = await installPlugin(dir, { id: "codex", registryUrl: trapBase });
    expect(q.id).toBe("codex");
    expect(trapHits).toBe(0);
    // Embedded installs carry no sidecar: null is how "came from this build" reads.
    expect(await readInstallRecord(dir, "pi")).toBeNull();
  });

  it("a bare built-in PACKAGE NAME with no id also stays offline (spec §2.5 rule 1)", async () => {
    // The embedded door is a property of the spec's package name, not of the
    // caller passing an `id` — the scoped name alone must already name pi.
    const dir = tempDataDir();
    trapHits = 0;
    const p = await installPlugin(dir, { spec: "@subshell-ai/plugin-pi", registryUrl: trapBase });
    expect(p.id).toBe("pi");
    expect(trapHits).toBe(0);
    expect(await readInstallRecord(dir, "pi")).toBeNull();
  });

  it("an `id` naming a built-in does NOT open the embedded door when the spec names a different package", async () => {
    // Regression: `installPlugin(dir, {id:"pi", spec:"evil@0.1.0"})` used to
    // install the embedded pi and report success without dialing the
    // registry, because the facade only ever consulted `opts.id`. The spec's
    // package name must be consulted too, and a caller-id collision alone
    // must never open the embedded door.
    const dir = tempDataDir();
    const source = await readBuiltIn("pi");
    if (!source) throw new Error("fixture needs the 'pi' built-in to exist in this build");
    const embeddedVersion = String((JSON.parse(source.files["package.json"] ?? "{}") as { version: string }).version);
    packumentHits.length = 0;
    await expect(
      installPlugin(dir, { id: "pi", spec: `other-package@${embeddedVersion}`, registryUrl: base }),
    ).rejects.toThrow(/other-package/);
    // Reached the registry (never silently answered from the embedded copy),
    // and refused honestly rather than installing anything under the wrong name.
    expect(packumentHits).toContain("other-package");
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("needs an id or a spec", async () => {
    await expect(installPlugin(tempDataDir(), { registryUrl: trapBase })).rejects.toThrow(/id or a spec/);
  });

  it("a pinned-equal version still uses embedded, a pinned-different version goes to the registry", async () => {
    const dir = tempDataDir();
    const source = await readBuiltIn("pi");
    if (!source) throw new Error("fixture needs the 'pi' built-in to exist in this build");
    const embeddedVersion = String((JSON.parse(source.files["package.json"] ?? "{}") as { version: string }).version);

    // Rules 2/3: a pin at the embedded version is answered from this build, no bytes over the wire.
    trapHits = 0;
    const eq = await installPlugin(dir, {
      id: "pi",
      spec: `@subshell-ai/plugin-pi@${embeddedVersion}`,
      registryUrl: trapBase,
    });
    expect(eq.id).toBe("pi");
    expect(trapHits).toBe(0);
    expect(await readInstallRecord(dir, "pi")).toBeNull();

    // A pin the embedded copy cannot answer goes to the registry, and records where it came from.
    served.set("@subshell-ai/plugin-pi", {
      latest: "99.0.0",
      versions: { "99.0.0": await builtInAsTgz("pi", "99.0.0") },
    });
    const up = await installPlugin(dir, { id: "pi", spec: "@subshell-ai/plugin-pi@99.0.0", registryUrl: base });
    expect(up.id).toBe("pi");
    expect(up.version).toBe("99.0.0");
    expect(up.broken).toBeUndefined();
    const record = await readInstallRecord(dir, "pi");
    expect(record?.name).toBe("@subshell-ai/plugin-pi");
    expect(record?.version).toBe("99.0.0");
    expect(record?.integrity).toMatch(/^sha512-/);
    expect(existsSync(join(pluginsDir(dir), "pi", "install.json"))).toBe(true);
    // The sidecar rides INSIDE the swap: the directory still reads back clean.
    expect(readdirSync(pluginsDir(dir))).toEqual(["pi"]);
  });

  it("an unknown id resolves to the manifest's OWN id and records the sidecar (rule 4)", async () => {
    const dir = tempDataDir();
    served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    const p = await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: base });
    expect(p.id).toBe("third");
    expect(await listInstalled(dir)).toEqual([expect.objectContaining({ id: "third", version: "1.0.0" })]);
    expect((await readInstallRecord(dir, "third"))?.name).toBe("third-party");
  });

  it("refuses when the caller's id disagrees with the manifest's", async () => {
    const dir = tempDataDir();
    served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    await expect(installPlugin(dir, { id: "wrong", spec: "third-party@1.0.0", registryUrl: base })).rejects.toThrow(
      /third/,
    );
    // The refusal moved nothing.
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("refuses to overwrite another package's claim on the id (spec §2.4)", async () => {
    const dir = tempDataDir();
    served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    served.set("squatter", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "squatter", version: "1.0.0", id: "third" }) },
    });
    await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: base });
    await expect(installPlugin(dir, { spec: "squatter@1.0.0", registryUrl: base })).rejects.toThrow(
      /third-party|squatter/,
    );
    // The original claim survives, sidecar and bytes untouched.
    expect((await readInstallRecord(dir, "third"))?.name).toBe("third-party");
    expect(readdirSync(pluginsDir(dir))).toEqual(["third"]);
  });

  it("a registry package declaring a built-in's id cannot replace the embedded install it has no name tie to", async () => {
    // The §2.4 guard cannot lean on the sidecar alone: an embedded install
    // carries none, so a squatter would pass a record-only check and the swap
    // would record the squatter over the operator's built-in. The target's
    // OWN package.json name is the other half of the claim.
    const dir = tempDataDir();
    await installPlugin(dir, { id: "pi" });
    const embeddedVersion = (await listInstalled(dir))[0]?.version;
    served.set("evil-pi", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "evil-pi", version: "1.0.0", id: "pi" }) },
    });
    await expect(installPlugin(dir, { spec: "evil-pi@1.0.0", registryUrl: base })).rejects.toThrow(
      /evil-pi.*@subshell-ai\/plugin-pi|@subshell-ai\/plugin-pi.*evil-pi/,
    );
    expect(await readInstallRecord(dir, "pi")).toBeNull();
    expect((await listInstalled(dir))[0]?.version).toBe(embeddedVersion);
    expect(readdirSync(pluginsDir(dir))).toEqual(["pi"]);
  });

  it("a broken module is refused by the pre-swap load and the old copy survives intact", async () => {
    const dir = tempDataDir();
    await installPlugin(dir, { id: "pi" });
    const before = (await listInstalled(dir))[0]?.version;

    served.set("bad-pi", {
      latest: "99.0.0",
      tags: { bad: "99.0.0" },
      versions: {
        "99.0.0": makePluginTgz({
          name: "@subshell-ai/plugin-pi",
          version: "99.0.0",
          id: "pi",
          entryBody: "throw new Error('fixture module throws');\n",
        }),
      },
    });
    await expect(installPlugin(dir, { id: "pi", spec: "bad-pi@bad", registryUrl: base })).rejects.toThrow(
      /loaded with an error/,
    );
    // The swap never happened: no sidecar, the old embedded bytes, no leftover working dirs.
    expect(await readInstallRecord(dir, "pi")).toBeNull();
    const after = await listInstalled(dir);
    expect(after.map((p) => p.id)).toEqual(["pi"]);
    expect(after[0]?.version).toBe(before);
    expect(after[0]?.broken).toBeUndefined();
    expect(readdirSync(pluginsDir(dir))).toEqual(["pi"]);
  });

  it("integrity mismatch: nothing written, previous state intact", async () => {
    const dir = tempDataDir();
    served.set("tampered", {
      latest: "1.0.0",
      tamper: true,
      versions: { "1.0.0": makePluginTgz({ name: "tampered", version: "1.0.0", id: "tampered" }) },
    });
    served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: base });
    await expect(installPlugin(dir, { spec: "tampered@1.0.0", registryUrl: base })).rejects.toThrow(/integrity/i);
    expect(await listInstalled(dir)).toEqual([expect.objectContaining({ id: "third" })]);
    expect(existsSync(join(pluginsDir(dir), "tampered"))).toBe(false);
  });
});

describe("refreshStaleBuiltIns vs registry-installed built-ins", () => {
  it("leaves a registry-pinned built-in alone instead of reverting it to the embedded copy", async () => {
    // The pass exists for the case where the UPGRADED BINARY is ahead of disk.
    // Here the opposite is true by choice: pi@99.0.0 was installed from a
    // registry on purpose, so an embedded 0.x on disk is not stale, and
    // reinstalling it would silently undo the operator (and drop the sidecar).
    const dir = tempDataDir();
    served.set("@subshell-ai/plugin-pi", {
      latest: "99.0.0",
      versions: { "99.0.0": await builtInAsTgz("pi", "99.0.0") },
    });
    await installPlugin(dir, { id: "pi", spec: "@subshell-ai/plugin-pi@99.0.0", registryUrl: base });

    const infos: string[] = [];
    setPluginLog({ info: (m) => void infos.push(m), warn: () => {} });
    let refreshed: string[];
    try {
      refreshed = await refreshStaleBuiltIns(dir);
    } finally {
      resetPluginLogForTests();
    }
    expect(refreshed).toEqual([]);
    expect((await listInstalled(dir))[0]?.version).toBe("99.0.0");
    expect((await readInstallRecord(dir, "pi"))?.version).toBe("99.0.0");
    expect(infos.join("\n")).toMatch(/skipped 'pi'.*99\.0\.0/);
  });
});

describe("resolvePluginUpdates", () => {
  it("names newer versions for sidecar'd installs only", async () => {
    const dir = tempDataDir();
    served.set("upd", {
      latest: "1.2.0",
      versions: {
        "1.0.0": makePluginTgz({ name: "upd", version: "1.0.0" }),
        "1.2.0": makePluginTgz({ name: "upd", version: "1.2.0" }),
      },
    });
    await installPlugin(dir, { spec: "upd@1.0.0", registryUrl: base });
    await installPlugin(dir, { id: "pi" });
    expect(await resolvePluginUpdates(dir, { registryUrl: base })).toEqual([
      { id: "upd", name: "upd", from: "1.0.0", to: "1.2.0" },
    ]);
  });

  it("reports to:null when the record is already at or above latest, and skips embedded installs entirely", async () => {
    const dir = tempDataDir();
    served.set("ahead", {
      latest: "1.1.0",
      versions: {
        "1.1.0": makePluginTgz({ name: "ahead", version: "1.1.0" }),
        "1.2.0": makePluginTgz({ name: "ahead", version: "1.2.0" }),
      },
    });
    await installPlugin(dir, { spec: "ahead@1.2.0", registryUrl: base });
    await installPlugin(dir, { id: "pi" });
    expect(await resolvePluginUpdates(dir, { registryUrl: base })).toEqual([
      { id: "ahead", name: "ahead", from: "1.2.0", to: null },
    ]);
    // The id filter narrows the answer, and the embedded pi is simply not in it.
    expect(await resolvePluginUpdates(dir, { id: "pi", registryUrl: base })).toEqual([]);
  });

  it("an unreachable registry is reported on the log, never guessed at", async () => {
    const dir = tempDataDir();
    served.set("upd", {
      latest: "1.2.0",
      versions: { "1.0.0": makePluginTgz({ name: "upd", version: "1.0.0" }) },
    });
    await installPlugin(dir, { spec: "upd@1.0.0", registryUrl: base });
    const warnings: string[] = [];
    setPluginLog({ info: () => {}, warn: (m) => void warnings.push(m) });
    try {
      trapHits = 0;
      expect(await resolvePluginUpdates(dir, { registryUrl: trapBase })).toEqual([]);
      expect(trapHits).toBeGreaterThan(0);
    } finally {
      resetPluginLogForTests();
    }
    expect(warnings.join("\n")).toMatch(/update check for 'upd' failed/);
  });
});
