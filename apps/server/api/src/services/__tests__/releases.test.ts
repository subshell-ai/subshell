import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_AGENT_VERSION, NODE_PROTOCOL_VERSION, RELEASE_MANIFEST_NAME } from "@internal/subshell-protocol";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { artifactPath } from "@/lib/node-artifacts.js";
import {
  autoFetchEnabled,
  compatibleNodeRelease,
  downloadVerified,
  fetchArtifact,
  fetchDigest,
  refreshReleases,
  resetReleaseCacheForTests,
  resolveReleases,
  setReleaseUrlForTests,
} from "@/services/releases.js";

/**
 * A stand-in for the repository's releases endpoint.
 *
 * A real fake server rather than a stubbed `fetch`: the module's whole subject
 * is bytes arriving over the network — chunked, out of order with the digest,
 * possibly wrong — and a stub that resolves an array cannot exercise the one
 * thing that matters, which is what happens to a partially written cache file
 * when the hash does not match at the end.
 */
interface Fake {
  url: string;
  stop: () => void;
  /** Bodies served per asset name; mutate between cases. */
  assets: Map<string, Uint8Array>;
  /** Releases listed, newest-by-date first the way GitHub answers. */
  tags: { tag: string; draft?: boolean }[];
  /** How many times the list endpoint was read — the TTL's observable effect. */
  listReads: number;
}

function startFakeRelease(): Fake {
  const state: Partial<Fake> = { assets: new Map(), tags: [], listReads: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/releases") {
        state.listReads = (state.listReads ?? 0) + 1;
        const body = (state.tags ?? []).map((entry) => ({
          tag_name: entry.tag,
          draft: entry.draft ?? false,
          assets: [...(state.assets ?? new Map()).keys()].map((name) => ({
            name,
            browser_download_url: `${state.url}/asset/${encodeURIComponent(name)}`,
          })),
        }));
        return Response.json(body);
      }
      const asset = url.pathname.startsWith("/asset/")
        ? decodeURIComponent(url.pathname.slice("/asset/".length))
        : null;
      const bytes = asset ? (state.assets ?? new Map()).get(asset) : undefined;
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes);
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state as Fake;
}

const TARGET = "linux-x64" as const;
const BINARY = "subshell-node-cli-linux-x64";
const SIDECAR = `${BINARY}.sha256`;

/** Bytes, and the digest a correct sidecar would carry for them. */
function payload(text: string): { bytes: Uint8Array; digest: string } {
  const bytes = new TextEncoder().encode(text);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { bytes, digest: hasher.digest("hex") };
}

const enc = (text: string) => new TextEncoder().encode(text);

/** Drain a stream, which is what the download route's Response does. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) total += chunk.byteLength;
  return total;
}

/**
 * A `release-manifest.json` body, as a release script writes it.
 *
 * Every node-release case needs one: without it `compatibleNodeRelease`
 * refuses by design (spec §3.3), because a plane that cannot read which
 * protocol an agent speaks must not install it.
 */
function manifestBody(over: Record<string, unknown> = {}): Uint8Array {
  return enc(
    JSON.stringify({
      component: "node",
      version: "9.9.9",
      nodeProtocol: NODE_PROTOCOL_VERSION,
      minAgentVersion: MIN_AGENT_VERSION,
      commit: "0123456789abcdef0123456789abcdef01234567",
      ...over,
    }),
  );
}

let fake: Fake;

beforeEach(() => {
  fake = startFakeRelease();
  fake.tags = [{ tag: "node-v9.9.9" }];
  const { bytes, digest } = payload("a convincing binary");
  fake.assets.set(BINARY, bytes);
  fake.assets.set(SIDECAR, enc(`${digest}\n`));
  fake.assets.set(RELEASE_MANIFEST_NAME, manifestBody());
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  setReleaseUrlForTests(`${fake.url}/releases`);
});

afterEach(() => {
  fake.stop();
  setReleaseUrlForTests(null);
  resetReleaseCacheForTests();
  rmSync(NODE_ARTIFACTS_DIR, { recursive: true, force: true });
});

afterAll(() => {
  setReleaseUrlForTests(null);
});

describe("autoFetchEnabled", () => {
  it("is off when the operator empties the release URL", () => {
    expect(autoFetchEnabled()).toBe(true);
    setReleaseUrlForTests("");
    // The supported air-gapped configuration: the routes then serve only
    // what is on disk, which is the behaviour that predates this module.
    expect(autoFetchEnabled()).toBe(false);
  });
});

describe("resolveReleases", () => {
  it("indexes the newest release of EVERY component from one read", async () => {
    fake.tags = [
      { tag: "server-v50.0.0" },
      { tag: "server-v1.0.0" },
      { tag: "node-v9.9.9" },
      { tag: "node-v1.0.0" },
      { tag: "desktop-server-v2.0.0" },
      { tag: "@subshell-ai/plugin-api@1.0.0" },
    ];
    const index = await resolveReleases();
    expect(index.byComponent.server?.version).toBe("50.0.0");
    expect(index.byComponent.node?.version).toBe("9.9.9");
    expect(index.byComponent["desktop-server"]?.version).toBe("2.0.0");
    // Nothing published it, so the answer is null rather than a throw: three
    // components resolving must not fail because a fourth has no release.
    expect(index.byComponent["desktop-client"]).toBeNull();
    // One list read answers all four — the whole point of an index.
    expect(fake.listReads).toBe(1);
  });

  it("memoizes the read, and refreshReleases busts it", async () => {
    await resolveReleases();
    await resolveReleases();
    // A burst of enrollments must not become a burst of API reads.
    expect(fake.listReads).toBe(1);
    await refreshReleases();
    expect(fake.listReads).toBe(2);
  });

  it("skips drafts", async () => {
    // The release pipeline publishes draft-then-live, so a cut in flight must
    // never be handed to anyone.
    fake.tags = [{ tag: "node-v99.0.0", draft: true }, { tag: "node-v9.9.9" }];
    expect((await resolveReleases()).byComponent.node?.tag).toBe("node-v9.9.9");
  });

  it("names the URL it could not read", async () => {
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    expect(resolveReleases()).rejects.toThrow(/127\.0\.0\.1:1/);
  });

  it("refuses when the source is off", async () => {
    setReleaseUrlForTests("");
    expect(resolveReleases()).rejects.toThrow(/SUBSHELL_RELEASE_URL is empty/);
  });
});

describe("compatibleNodeRelease", () => {
  it("offers the newest node release whose manifest matches this server's protocol", async () => {
    const { release, reason } = await compatibleNodeRelease();
    expect(release?.tag).toBe("node-v9.9.9");
    expect(reason).toBeNull();
  });

  it("refuses a release below the server's own agent floor", async () => {
    fake.tags = [{ tag: "node-v0.0.1" }];
    const { release, reason } = await compatibleNodeRelease();
    expect(release).toBeNull();
    expect(reason).toMatch(/minimum agent version/);
  });

  it("refuses a release that carries no manifest, and says why", async () => {
    // Every cut before 2026-09-15. Unknown is refused rather than guessed:
    // installing an agent this plane cannot talk to produces a node that
    // enrolls, reconnects and is closed 4406 forever.
    fake.assets.delete(RELEASE_MANIFEST_NAME);
    const { release, reason } = await compatibleNodeRelease();
    expect(release).toBeNull();
    expect(reason).toMatch(/carries no release manifest/);
  });

  it("refuses a release that speaks a different protocol, naming both", async () => {
    fake.assets.set(RELEASE_MANIFEST_NAME, manifestBody({ nodeProtocol: NODE_PROTOCOL_VERSION + 1 }));
    const { reason } = await compatibleNodeRelease();
    expect(reason).toContain(`protocol ${NODE_PROTOCOL_VERSION + 1}`);
    expect(reason).toContain("update the server first");
  });

  it("refuses an unparseable manifest the same way as an absent one", async () => {
    fake.assets.set(RELEASE_MANIFEST_NAME, enc("<!doctype html>"));
    expect((await compatibleNodeRelease()).reason).toMatch(/carries no release manifest/);
  });

  it("refuses when the repository publishes no node release", async () => {
    fake.tags = [{ tag: "server-v1.0.0" }];
    expect((await compatibleNodeRelease()).reason).toMatch(/no node-v\* release/);
  });
});

describe("fetchArtifact", () => {
  it("streams the bytes and caches them once verified", async () => {
    const fetched = await fetchArtifact(TARGET);
    expect(fetched.tag).toBe("node-v9.9.9");
    const bytes = await drain(fetched.stream);
    expect(bytes).toBe(fake.assets.get(BINARY)?.byteLength ?? -1);
    // Cached only after the digest matched, with its sidecar beside it so the
    // `.sha256` route is answered locally next time.
    expect(readFileSync(artifactPath(TARGET), "utf8")).toBe("a convincing binary");
    expect(readFileSync(`${artifactPath(TARGET)}.sha256`, "utf8").trim()).toBe(fetched.digest);
  });

  it("records what it fetched, so the file is known to be ours", async () => {
    await drain((await fetchArtifact(TARGET)).stream);
    const manifest = JSON.parse(readFileSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"), "utf8"));
    expect(manifest[TARGET]?.tag).toBe("node-v9.9.9");
    expect(manifest[TARGET]?.digest).toBe((await fetchArtifact(TARGET)).digest);
  });

  it("errors the stream and caches NOTHING when the digest is wrong", async () => {
    // The sidecar announces a digest the bytes do not have — a corrupted
    // transfer, or a release whose two assets disagree.
    fake.assets.set(SIDECAR, enc(`${"0".repeat(64)}\n`));
    const fetched = await fetchArtifact(TARGET);
    expect(drain(fetched.stream)).rejects.toThrow(/did not match the digest/);
    // The node sees a truncated download and fails its own check; the next
    // machine must not be served the bad bytes from a cache.
    expect(existsSync(artifactPath(TARGET))).toBe(false);
    expect(existsSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"))).toBe(false);
  });

  it("refuses a sidecar that is not a digest", async () => {
    // An HTML error page must never become the thing a binary is checked against.
    fake.assets.set(SIDECAR, enc("<!doctype html><title>404</title>"));
    expect(fetchArtifact(TARGET)).rejects.toThrow(/not a sha256 digest/);
  });

  it("refuses a platform the release does not publish", async () => {
    fake.assets.delete(BINARY);
    expect(fetchArtifact(TARGET)).rejects.toThrow(/publishes no/);
  });

  it("downloads once when two machines ask at the same moment", async () => {
    const [a, b] = await Promise.all([fetchArtifact(TARGET), fetchArtifact(TARGET)]);
    // Same in-flight fetch, so the 80 MB is spent once rather than twice.
    expect(a).toBe(b);
    await drain(a.stream);
  });
});

describe("superseding", () => {
  it("removes a cached binary from an older release, and only a cached one", async () => {
    // One file we fetched at an old tag, and one the operator published.
    writeFileSync(artifactPath(TARGET), "stale");
    writeFileSync(join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64"), "the operator's own");
    writeFileSync(
      join(NODE_ARTIFACTS_DIR, ".fetched.json"),
      JSON.stringify({ [TARGET]: { tag: "node-v1.0.0", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" } }),
    );

    await drain((await fetchArtifact(TARGET)).stream);

    // Ours was superseded and replaced by the new release's bytes...
    expect(readFileSync(artifactPath(TARGET), "utf8")).toBe("a convincing binary");
    // ...and the operator's, which has no manifest entry, was never touched.
    expect(readFileSync(join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64"), "utf8")).toBe("the operator's own");
  });

  it("deletes a superseded platform rather than re-downloading it", async () => {
    // darwin was fetched at an older tag and nobody has asked for it since.
    // It is removed, not refreshed: refreshing would spend 80 MB on a platform
    // no machine has requested, which is the laziness this module keeps.
    const darwin = join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64");
    writeFileSync(darwin, "old darwin build");
    writeFileSync(
      join(NODE_ARTIFACTS_DIR, ".fetched.json"),
      JSON.stringify({ "darwin-arm64": { tag: "node-v1.0.0", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" } }),
    );

    await drain((await fetchArtifact(TARGET)).stream);

    expect(existsSync(darwin)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"), "utf8"));
    expect(manifest["darwin-arm64"]).toBeUndefined();
  });

  it("leaves a cached binary from the CURRENT release alone", async () => {
    writeFileSync(join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64"), "current darwin build");
    writeFileSync(
      join(NODE_ARTIFACTS_DIR, ".fetched.json"),
      JSON.stringify({ "darwin-arm64": { tag: "node-v9.9.9", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" } }),
    );
    await drain((await fetchArtifact(TARGET)).stream);
    expect(readFileSync(join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64"), "utf8")).toBe(
      "current darwin build",
    );
  });
});

describe("fetchDigest", () => {
  it("answers the digest without pulling the binary", async () => {
    const digest = await fetchDigest(TARGET);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // `install.sh` asks for the binary first, so this path exists for the
    // other order — and it must not cache a binary nobody asked for.
    expect(existsSync(artifactPath(TARGET))).toBe(false);
  });
});

describe("downloadVerified", () => {
  const assetUrl = (name: string) => `${fake.url}/asset/${encodeURIComponent(name)}`;

  it("writes a temp file and returns its path on a digest match", async () => {
    const { digest } = payload("a convincing binary");
    const path = await downloadVerified({
      url: assetUrl(BINARY),
      expectedDigest: digest,
      destDir: NODE_ARTIFACTS_DIR,
      destName: "subshell-server",
    });
    expect(path).toContain("subshell-server.download-");
    expect(readFileSync(path, "utf8")).toBe("a convincing binary");
    // It never chmods: deciding that a downloaded file may be EXECUTED is the
    // caller's act, beside the caller's own version probe.
    expect(statSync(path).mode & 0o111).toBe(0);
  });

  it("deletes the partial file and throws on a mismatch", async () => {
    // The server's own update EXECS what this writes, so a mismatch must leave
    // nothing behind rather than merely report.
    let path = "";
    await expect(
      downloadVerified({
        url: assetUrl(BINARY),
        expectedDigest: "0".repeat(64),
        destDir: NODE_ARTIFACTS_DIR,
        destName: "subshell-server",
        onProgress: () => {
          path = join(NODE_ARTIFACTS_DIR, `subshell-server.download-${process.pid}`);
        },
      }),
    ).rejects.toThrow(/did not match the published digest/);
    expect(existsSync(path)).toBe(false);
  });

  it("reports progress as the bytes arrive", async () => {
    const { digest } = payload("a convincing binary");
    const seen: number[] = [];
    await downloadVerified({
      url: assetUrl(BINARY),
      expectedDigest: digest,
      destDir: NODE_ARTIFACTS_DIR,
      destName: "subshell-server",
      onProgress: (received) => seen.push(received),
    });
    expect(seen.at(-1)).toBe("a convincing binary".length);
  });

  it("throws and keeps nothing when the asset is not there", async () => {
    await expect(
      downloadVerified({
        url: assetUrl("nothing-published-under-this-name"),
        expectedDigest: "0".repeat(64),
        destDir: NODE_ARTIFACTS_DIR,
        destName: "subshell-server",
      }),
    ).rejects.toThrow(/answered 404/);
    expect(existsSync(join(NODE_ARTIFACTS_DIR, `subshell-server.download-${process.pid}`))).toBe(false);
  });
});
