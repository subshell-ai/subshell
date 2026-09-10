import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fetchVerifiedTarball, parsePackageSpec, resolvePackageVersion } from "../npm-registry.js";

describe("parsePackageSpec", () => {
  it("parses bare, scoped, and version/tag-pinned specs", () => {
    expect(parsePackageSpec("pi")).toEqual({ name: "pi" });
    expect(parsePackageSpec("@subshell-ai/plugin-codex")).toEqual({ name: "@subshell-ai/plugin-codex" });
    expect(parsePackageSpec("@subshell-ai/plugin-codex@1.2.3")).toEqual({
      name: "@subshell-ai/plugin-codex",
      range: "1.2.3",
    });
    expect(parsePackageSpec("thing@latest")).toEqual({ name: "thing", range: "latest" });
  });

  it("refuses semver RANGES by name: resolution is exact-version or dist-tag only", () => {
    expect(() => parsePackageSpec("thing@^1.0.0")).toThrow(/range/);
    expect(() => parsePackageSpec("thing@~1")).toThrow(/range/);
    expect(() => parsePackageSpec("thing@1.x")).toThrow(/range/);
  });

  it("refuses anything not shaped like a package name", () => {
    for (const bad of ["", " ", "@", "a b", "../x", "-x", "x@"]) expect(() => parsePackageSpec(bad)).toThrow();
  });
});

const TARBALL = new Uint8Array([1, 2, 3, 4]);
/** Computed, never hardcoded: the digest the fake registry announces. */
const SRI = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;

/** The abbreviated ("corgi") packument shape: dist-tags + per-version dist. */
function packument(overrides: Record<string, unknown> = {}) {
  return {
    "dist-tags": { latest: "1.1.0" },
    versions: {
      "1.0.0": { name: "thing", version: "1.0.0", dist: { tarball: "/thing-1.0.0.tgz", integrity: SRI } },
      "1.1.0": { name: "thing", version: "1.1.0", dist: { tarball: "/thing-1.1.0.tgz", integrity: SRI } },
      ...overrides,
    },
  };
}

let servedPackument: unknown = packument();
let brokenIntegrity = false;
let lastPath = "";
let base = "";
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      lastPath = p;
      if (p === "/thing")
        return Response.json(servedPackument, {
          headers: { "content-type": "application/vnd.npm.install-v1+json" },
        });
      if (p.endsWith(".tgz")) return new Response(brokenIntegrity ? new Uint8Array([9]) : TARBALL);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("resolvePackageVersion", () => {
  it("resolves the dist-tag latest (no range given)", async () => {
    const resolved = await resolvePackageVersion("thing", undefined, base);
    expect(resolved).toEqual({ version: "1.1.0", tarball: "/thing-1.1.0.tgz", integrity: SRI });
  });

  it("resolves an exact version", async () => {
    const resolved = await resolvePackageVersion("thing", "1.0.0", base);
    expect(resolved.version).toBe("1.0.0");
    expect(resolved.tarball).toBe("/thing-1.0.0.tgz");
  });

  it("refuses an unknown version, naming it and the registry base", async () => {
    const message = await rejection(() => resolvePackageVersion("thing", "9.9.9", base));
    expect(message).toContain("9.9.9");
    expect(message).toContain(base);
  });

  it("refuses a scoped-name packument 404, naming the URL it tried", async () => {
    const message = await rejection(() => resolvePackageVersion("@scope/missing", undefined, base));
    expect(message).toContain("404");
    expect(message).toContain(`${base}/%40scope/missing`);
    // The scoped name must reach the registry with each path segment encoded
    // (the `@` as %40), never raw: that is the URL real registries and proxies route.
    expect(lastPath).toBe("/%40scope/missing");
  });

  it("refuses a packument whose resolved version carries no dist.integrity", async () => {
    servedPackument = packument({
      "1.1.0": { name: "thing", version: "1.1.0", dist: { tarball: "/thing-1.1.0.tgz" } },
    });
    try {
      const message = await rejection(() => resolvePackageVersion("thing", undefined, base));
      expect(message).toMatch(/integrity/i);
    } finally {
      servedPackument = packument();
    }
  });
});

describe("fetchVerifiedTarball", () => {
  it("returns the bytes when the sha512 digest matches", async () => {
    const resolved = await resolvePackageVersion("thing", undefined, base);
    const bytes = await fetchVerifiedTarball(resolved, base);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("throws an integrity error when the served bytes do not match the announced digest", async () => {
    const resolved = await resolvePackageVersion("thing", undefined, base);
    brokenIntegrity = true;
    try {
      await expect(fetchVerifiedTarball(resolved, base)).rejects.toThrow(/integrity/i);
    } finally {
      brokenIntegrity = false;
    }
  });
});
