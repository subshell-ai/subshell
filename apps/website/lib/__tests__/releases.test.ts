import { describe, expect, test } from "bun:test";
import { parseReleases, type ReleasesManifest, refreshReleases } from "../releases";

const GOOD = {
  schemaVersion: 1,
  generatedAt: "2026-09-23T00:00:00.000Z",
  components: {
    "cli-server": {
      version: "0.16.0",
      tag: "cli-server-v0.16.0",
      url: "https://x",
      installScript: "install-server.sh",
    },
    "desktop-client": { version: "0.6.0", tag: "desktop-client-v0.6.0", url: "https://y" },
  },
};
const baked = GOOD as ReleasesManifest;

describe("parseReleases", () => {
  test("accepts a valid manifest and tolerates unknown extra fields", () => {
    expect(parseReleases(JSON.stringify({ ...GOOD, futureField: 1 }))).not.toBeNull();
  });
  test("refuses a wrong schemaVersion", () => {
    expect(parseReleases(JSON.stringify({ ...GOOD, schemaVersion: 2 }))).toBeNull();
  });
  test("refuses non-JSON (an HTML error page from a proxy)", () => {
    expect(parseReleases("<!doctype html><html>")).toBeNull();
  });
  test("refuses a missing components map and a non-semver version", () => {
    expect(parseReleases(JSON.stringify({ schemaVersion: 1 }))).toBeNull();
    expect(
      parseReleases(
        JSON.stringify({ ...GOOD, components: { "cli-server": { version: "latest", tag: "t", url: "u" } } }),
      ),
    ).toBeNull();
  });
});

describe("refreshReleases", () => {
  test("returns the fetched manifest when it parses", async () => {
    const fresh = { ...GOOD, components: { "cli-server": { ...GOOD.components["cli-server"], version: "0.17.0" } } };
    const fetchImpl = (async () => new Response(JSON.stringify(fresh))) as unknown as typeof fetch;
    expect((await refreshReleases(baked, fetchImpl)).components["cli-server"]?.version).toBe("0.17.0");
  });
  test("keeps the baked copy on network failure, HTTP error, and bad schema", async () => {
    const dying = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await refreshReleases(baked, dying)).toBe(baked);
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await refreshReleases(baked, notFound)).toBe(baked);
    const html = (async () => new Response("<html>")) as unknown as typeof fetch;
    expect(await refreshReleases(baked, html)).toBe(baked);
  });
});
