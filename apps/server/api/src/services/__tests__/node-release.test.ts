import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { artifactPath } from "@/lib/node-artifacts.js";
import {
  autoFetchEnabled,
  fetchArtifact,
  fetchDigest,
  resetReleaseCacheForTests,
  resolveRelease,
  setNodeReleaseUrlForTests,
} from "@/services/node-release.js";

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

let fake: Fake;

beforeEach(() => {
  fake = startFakeRelease();
  fake.tags = [{ tag: "node-v9.9.9" }];
  const { bytes, digest } = payload("a convincing binary");
  fake.assets.set(BINARY, bytes);
  fake.assets.set(SIDECAR, enc(`${digest}\n`));
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  setNodeReleaseUrlForTests(`${fake.url}/releases`);
});

afterEach(() => {
  fake.stop();
  setNodeReleaseUrlForTests(null);
  resetReleaseCacheForTests();
  rmSync(NODE_ARTIFACTS_DIR, { recursive: true, force: true });
});

afterAll(() => {
  setNodeReleaseUrlForTests(null);
});

describe("autoFetchEnabled", () => {
  it("is off when the operator empties the release URL", () => {
    expect(autoFetchEnabled()).toBe(true);
    setNodeReleaseUrlForTests("");
    // The supported air-gapped configuration: the routes then serve only
    // what is on disk, which is the behaviour that predates this module.
    expect(autoFetchEnabled()).toBe(false);
  });
});

describe("resolveRelease", () => {
  it("picks the newest node release and memoizes the read", async () => {
    fake.tags = [{ tag: "server-v50.0.0" }, { tag: "node-v9.9.9" }, { tag: "node-v1.0.0" }];
    expect((await resolveRelease()).tag).toBe("node-v9.9.9");
    expect((await resolveRelease()).tag).toBe("node-v9.9.9");
    // A burst of enrollments must not become a burst of API reads.
    expect(fake.listReads).toBe(1);
  });

  it("skips drafts", async () => {
    // The release pipeline publishes draft-then-live, so a cut in flight must
    // never be handed to a node.
    fake.tags = [{ tag: "node-v99.0.0", draft: true }, { tag: "node-v9.9.9" }];
    expect((await resolveRelease()).tag).toBe("node-v9.9.9");
  });

  it("refuses a release below the server's own agent floor", async () => {
    fake.tags = [{ tag: "node-v0.0.1" }];
    expect(resolveRelease()).rejects.toThrow(/minimum agent version/);
  });

  it("names the URL it could not read", async () => {
    setNodeReleaseUrlForTests("http://127.0.0.1:1/releases");
    expect(resolveRelease()).rejects.toThrow(/127\.0\.0\.1:1/);
  });

  it("refuses when the repository publishes no node release", async () => {
    fake.tags = [{ tag: "server-v1.0.0" }];
    expect(resolveRelease()).rejects.toThrow(/no node-v\* release/);
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
