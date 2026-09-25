import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
} from "@internal/subshell-protocol";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { artifactPath } from "@/lib/node-artifacts.js";
import {
  autoFetchEnabled,
  checkReleaseManifest,
  compatibleNodeRelease,
  downloadVerified,
  fetchArtifact,
  fetchDigest,
  MAX_REDIRECT_HOPS,
  refreshReleases,
  releaseFetchAllowed,
  releaseSeams,
  resetReleaseCacheForTests,
  resolveReleases,
  setReleaseUrlForTests,
  signedAssetDigest,
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
  /** Assets answered with a 302 to this Location instead of a body. */
  redirects: Map<string, string>;
  /** Asset name → how many times its path was fetched (redirect hops included). */
  assetFetches: Map<string, number>;
  /** Releases listed, newest-by-date first the way GitHub answers. */
  tags: { tag: string; draft?: boolean }[];
  /** How many times the list endpoint was read — the TTL's observable effect. */
  listReads: number;
}

function startFakeRelease(): Fake {
  const state: Partial<Fake> = {
    assets: new Map(),
    redirects: new Map(),
    assetFetches: new Map(),
    tags: [],
    listReads: 0,
  };
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
      if (asset) state.assetFetches!.set(asset, (state.assetFetches!.get(asset) ?? 0) + 1);
      const to = asset ? state.redirects!.get(asset) : undefined;
      if (to !== undefined) return new Response(null, { status: 302, headers: { location: to } });
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

/** The bytes the fixture binary serves, and their digest — the manifest names it. */
const BINARY_PAYLOAD = payload("a convincing binary");

/**
 * A `release-manifest.json` body, as a release script writes it.
 *
 * Every node-release case needs one: without it `compatibleNodeRelease`
 * refuses by design (spec §3.3), because a plane that cannot read which
 * protocol an agent speaks must not install it. And since spec 2026-09-17
 * it needs a SIGNED one — `assets` carries the digest the bytes are checked
 * against, and `releaseSeams.verifyManifest` below stands in for the crypto
 * the protocol package pins against real `tauri signer` fixtures.
 */
function manifestBody(over: Record<string, unknown> = {}): Uint8Array {
  return enc(
    JSON.stringify({
      component: "cli-node",
      version: "9.9.9",
      nodeProtocol: NODE_PROTOCOL_VERSION,
      minNodeVersion: MIN_NODE_VERSION,
      commit: "0123456789abcdef0123456789abcdef01234567",
      assets: { [BINARY]: BINARY_PAYLOAD.digest },
      ...over,
    }),
  );
}

/** The armor the fake verifier accepts; anything else is a failed signature. */
const TEST_ARMOR = "TEST-ARMOR";
const realVerify = { ...releaseSeams };

let fake: Fake;

beforeEach(() => {
  fake = startFakeRelease();
  fake.tags = [{ tag: "cli-node-v9.9.9" }];
  fake.assets.set(BINARY, BINARY_PAYLOAD.bytes);
  fake.assets.set(SIDECAR, enc(`${BINARY_PAYLOAD.digest}\n`));
  fake.assets.set(RELEASE_MANIFEST_NAME, manifestBody());
  fake.assets.set(RELEASE_MANIFEST_SIG_NAME, enc(TEST_ARMOR));
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  setReleaseUrlForTests(`${fake.url}/releases`);
  // The crypto half stands in — accepting exactly the fixture pair and
  // enforcing the payload binding (component + version), like the real one.
  releaseSeams.verifyManifest = async (bytes, sig, _pub, expected) => {
    const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
    if (parsed === null) return { ok: false, reason: "test: the bytes are not a manifest" };
    if (sig.trim() !== TEST_ARMOR) return { ok: false, reason: "test: signature refused" };
    if (parsed.component !== expected.component || parsed.version !== expected.version) {
      return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
    }
    return { ok: true, manifest: parsed };
  };
});

afterEach(() => {
  fake.stop();
  setReleaseUrlForTests(null);
  resetReleaseCacheForTests();
  rmSync(NODE_ARTIFACTS_DIR, { recursive: true, force: true });
  Object.assign(releaseSeams, realVerify);
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
      { tag: "cli-server-v50.0.0" },
      { tag: "cli-server-v1.0.0" },
      { tag: "cli-node-v9.9.9" },
      { tag: "cli-node-v1.0.0" },
      { tag: "desktop-server-v2.0.0" },
      { tag: "@subshell-ai/plugin-api@1.0.0" },
    ];
    const index = await resolveReleases();
    expect(index.byComponent["cli-server"]?.version).toBe("50.0.0");
    expect(index.byComponent["cli-node"]?.version).toBe("9.9.9");
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
    fake.tags = [{ tag: "cli-node-v99.0.0", draft: true }, { tag: "cli-node-v9.9.9" }];
    expect((await resolveReleases()).byComponent["cli-node"]?.tag).toBe("cli-node-v9.9.9");
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
    expect(release?.tag).toBe("cli-node-v9.9.9");
    expect(reason).toBeNull();
  });

  it("refuses a release below the server's own agent floor", async () => {
    fake.tags = [{ tag: "cli-node-v0.0.1" }];
    const { release, reason } = await compatibleNodeRelease();
    expect(release).toBeNull();
    expect(reason).toMatch(/minimum node version/);
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

  it("refuses a release whose manifest carries no signature — and names that as the reason", async () => {
    // Every cut between 2026-09-15 and the signing pipeline landing. The
    // spec (2026-09-17 §4): a fresh instance pointed at the current, wholly
    // unsigned release set shows NO available updates, which is correct.
    fake.assets.delete(RELEASE_MANIFEST_SIG_NAME);
    const { release, reason } = await compatibleNodeRelease();
    expect(release).toBeNull();
    expect(reason).toMatch(/no publisher signature covers/);
  });

  it("refuses a release whose signature fails to verify — the third distinct sentence", async () => {
    // The attack-shaped case gets its own wording, not the "no manifest"
    // one: telling an operator their release carries no manifest when
    // someone handed them a bad signature is the wrong story.
    fake.assets.set(RELEASE_MANIFEST_SIG_NAME, enc("NOT-THE-ARMOR"));
    const { release, reason } = await compatibleNodeRelease();
    expect(release).toBeNull();
    expect(reason).toMatch(/signature failed to verify/);
  });

  it("refuses a release that speaks a different protocol, naming both", async () => {
    fake.assets.set(RELEASE_MANIFEST_NAME, manifestBody({ nodeProtocol: NODE_PROTOCOL_VERSION + 1 }));
    const { reason } = await compatibleNodeRelease();
    expect(reason).toContain(`protocol ${NODE_PROTOCOL_VERSION + 1}`);
    expect(reason).toContain("update the server first");
  });

  it("refuses an unparseable manifest rather than offering it", async () => {
    fake.assets.set(RELEASE_MANIFEST_NAME, enc("<!doctype html>"));
    expect((await compatibleNodeRelease()).reason).toMatch(/failed to verify|not a release manifest/);
  });

  it("refuses when the repository publishes no node release", async () => {
    fake.tags = [{ tag: "cli-server-v1.0.0" }];
    expect((await compatibleNodeRelease()).reason).toMatch(/no cli-node-v\* release/);
  });
});

describe("fetchArtifact", () => {
  it("creates the artifacts directory when the instance never had one", async () => {
    // mac-builder 2026-09-20: a plane that never ran `release:cli-node` into
    // its data dir has no node-artifacts directory, and the lazy fetch died
    // opening its temp file — ENOENT before a single byte moved, surfaced to
    // the node as a 404 download failure. Every other test in this file
    // creates the directory in `beforeEach`, which is exactly why it passed
    // CI for a week. This test removes what the fixture adds, so the fetcher
    // has to survive on its own mkdir.
    rmSync(NODE_ARTIFACTS_DIR, { recursive: true, force: true });
    const fetched = await fetchArtifact(TARGET);
    await drain(fetched.stream);
    expect(existsSync(artifactPath(TARGET))).toBe(true);
    expect(readFileSync(artifactPath(TARGET), "utf8")).toBe("a convincing binary");
  });

  it("streams the bytes and caches them once verified", async () => {
    const fetched = await fetchArtifact(TARGET);
    expect(fetched.tag).toBe("cli-node-v9.9.9");
    const bytes = await drain(fetched.stream);
    expect(bytes).toBe(fake.assets.get(BINARY)?.byteLength ?? -1);
    // Cached only after the digest matched, with its sidecar beside it so the
    // `.sha256` route is answered locally next time.
    expect(readFileSync(artifactPath(TARGET), "utf8")).toBe("a convincing binary");
    expect(readFileSync(`${artifactPath(TARGET)}.sha256`, "utf8").trim()).toBe(fetched.digest);
  });

  it("records what it fetched — tag and the signed manifest's commit — so the file is known to be ours", async () => {
    await drain((await fetchArtifact(TARGET)).stream);
    const manifest = JSON.parse(readFileSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"), "utf8"));
    expect(manifest[TARGET]?.tag).toBe("cli-node-v9.9.9");
    expect(manifest[TARGET]?.digest).toBe((await fetchArtifact(TARGET)).digest);
    // The commit the VERIFIED manifest named (spec 2026-09-17 §5) — the audit
    // trail says what was checked, not merely which tag was current.
    expect(manifest[TARGET]?.commit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("errors the stream and caches NOTHING when the digest is wrong", async () => {
    // The SIGNED manifest announces a digest the bytes do not have — a
    // corrupted transfer, or a release whose assets disagree.
    fake.assets.set(RELEASE_MANIFEST_NAME, manifestBody({ assets: { [BINARY]: "0".repeat(64) } }));
    const fetched = await fetchArtifact(TARGET);
    expect(drain(fetched.stream)).rejects.toThrow(/did not match the digest/);
    // The node sees a truncated download and fails its own check; the next
    // machine must not be served the bad bytes from a cache.
    expect(existsSync(artifactPath(TARGET))).toBe(false);
    expect(existsSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"))).toBe(false);
  });

  it("caches NOTHING when the signature fails — the release source alone cannot push bytes here", async () => {
    // The whole point of path 3 (spec 2026-09-17 §5): a compromised release
    // source swaps BOTH assets consistently and still gets nothing cached,
    // because the fake verifier only accepts the fixture armor.
    fake.assets.set(RELEASE_MANIFEST_SIG_NAME, enc("FORGED"));
    expect(fetchArtifact(TARGET)).rejects.toThrow(/signature failed to verify|no publisher signature/);
    expect(existsSync(artifactPath(TARGET))).toBe(false);
  });

  it("refuses a signed manifest that omits this platform", async () => {
    fake.assets.set(
      RELEASE_MANIFEST_NAME,
      manifestBody({ assets: { "subshell-node-cli-some-other-machine": BINARY_PAYLOAD.digest } }),
    );
    expect(fetchArtifact(TARGET)).rejects.toThrow(/signed manifest names no/);
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

describe("egress pin (round-3 sweep C12)", () => {
  it("allows GitHub's release hosts and the configured source's origin — and nothing else", () => {
    // The shipped default IS this list: `DEFAULT_RELEASE_API` is api.github.com
    // (which the configured-origin rule also covers), a GitHub release asset's
    // `browser_download_url` is github.com, and that 302s to the asset host —
    // BOTH spellings allowed, because GitHub renamed the destination
    // (release-assets.githubusercontent.com is where the 1.0.0 post-cut proof
    // measured the hop landing; objects.githubusercontent.com stays for the
    // legacy URLs that still redirect there). So for the default
    // configuration the pin is trivially true of every real fetch, and it
    // exists for the other one: an operator pointing SUBSHELL_RELEASE_URL at
    // a mirror, where the LIST can then name any host and must not be able to
    // turn the plane into a probe of link-local internals.
    expect(releaseFetchAllowed("https://api.github.com/repos/theo/subshell/releases")).toBe(true);
    expect(releaseFetchAllowed("https://github.com/theo/subshell/releases/download/cli-node-v1/bin")).toBe(true);
    expect(releaseFetchAllowed("https://objects.githubusercontent.com/signed/asset-blob")).toBe(true);
    expect(releaseFetchAllowed("https://release-assets.githubusercontent.com/signed/asset-blob")).toBe(true);
    expect(releaseFetchAllowed(`${fake.url}/asset/bin`)).toBe(true); // the configured source
    expect(releaseFetchAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(releaseFetchAllowed(`${fake.url.replace("127.0.0.1", "localhost")}/asset/bin`)).toBe(false); // not same-origin
    expect(releaseFetchAllowed("https://attacker.example/whatever")).toBe(false);
    expect(releaseFetchAllowed("not a url")).toBe(false);
  });

  it("refuses an off-list binary URL before anything is fetched from it", async () => {
    // The SSRF-probe class, end to end: the digest gate bounds what ARRIVES;
    // this bounds where the plane KNOCKS. `hits` is the assertion — a
    // connection to the refused host is the bug, whatever error arrives.
    let hits = 0;
    const attacker = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("should never be fetched");
      },
    });
    try {
      // The cached index the rest of the flow reads is the live object —
      // rewriting its binary URL is what a mirror would have done in its
      // JSON, without needing a second fake release source.
      const index = await resolveReleases();
      const release = index.byComponent["cli-node"]!;
      release.assets.set(BINARY, `http://127.0.0.1:${attacker.port}/asset/bin`);
      await expect(fetchArtifact(TARGET)).rejects.toThrow(
        /is neither a GitHub release host nor the configured release source's host/,
      );
      expect(hits).toBe(0);
    } finally {
      attacker.stop(true);
    }
  });

  it("refuses an off-list manifest before reading the digest from it — the release is not offered", async () => {
    // The tiny reads get the same pin as the 80 MB one. A manifest hosted
    // elsewhere cannot reach the verification stage at all, and the refusal
    // reads as the ordinary "failed" outcome (the page explains it; the log
    // line carries the host).
    const index = await resolveReleases();
    const release = index.byComponent["cli-node"]!;
    release.assets.set(RELEASE_MANIFEST_NAME, "http://169.254.169.254/latest/meta-data/manifest");
    release.manifestRead = false;
    release.manifestOutcome = null;
    const outcome = await checkReleaseManifest(release);
    if (outcome.kind !== "failed") throw new Error(`expected the off-list manifest to fail, got ${outcome.kind}`);
    expect(outcome.reason).toMatch(
      /169\.254\.169\.254 is neither a GitHub release host nor the configured release source's host/,
    );
    // …and the digest question has nothing to answer, which is the same
    // refusal the update paths already render.
    expect(signedAssetDigest(release, BINARY)).rejects.toThrow(/no verifiable manifest/);
  });

  it("downloadVerified — the server's OWN update download — is pinned too", async () => {
    // Same untrusted field (a URL out of the release list), and the caller
    // EXECUTES what this writes.
    let hits = 0;
    const attacker = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("x");
      },
    });
    try {
      await expect(
        downloadVerified({
          url: `http://127.0.0.1:${attacker.port}/bin`,
          expectedDigest: "0".repeat(64),
          destDir: NODE_ARTIFACTS_DIR,
          destName: "subshell-server",
        }),
      ).rejects.toThrow(/is neither a GitHub release host nor the configured release source's host/);
      expect(hits).toBe(0);
      expect(existsSync(join(NODE_ARTIFACTS_DIR, `subshell-server.download-${process.pid}`))).toBe(false);
    } finally {
      attacker.stop(true);
    }
  });

  it("the default GitHub flow is unregressed through the real list fetch", async () => {
    // The fake IS the configured source, so every fetch here goes to the
    // configured origin — the case the pin must never break. One full
    // manifest-and-digest round confirms it.
    const digest = await fetchDigest(TARGET);
    expect(digest).toBe(BINARY_PAYLOAD.digest);
  });

  // --- redirect hops (C12's blind spot, closed 2026-09-24) -----------------
  // Bun's fetch follows 302s by default, so pinning the URL the source NAMED
  // left every one of those fetches one redirect away from any host on the
  // planet. The module now fetches with `redirect: "manual"` and re-runs the
  // pin on each hop itself; these three cases are the whole shape of that.

  it("a source-named 302 to an off-list host is refused BEFORE the second hop is fetched", async () => {
    // The mirror stays on the allowlist — it is the configured source — and
    // answers the binary's URL with a 302 to a link-local stand-in. Byte
    // trust was never egress trust: the refused hop must cost zero probes.
    let hits = 0;
    const linkLocalStandIn = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("the metadata endpoint nobody asked to knock on");
      },
    });
    try {
      fake.redirects.set(BINARY, `http://127.0.0.1:${linkLocalStandIn.port}/latest/meta-data/`);
      await expect(fetchArtifact(TARGET)).rejects.toThrow(
        /is neither a GitHub release host nor the configured release source's host/,
      );
      expect(hits).toBe(0);
      expect(existsSync(artifactPath(TARGET))).toBe(false);
    } finally {
      linkLocalStandIn.stop(true);
    }
  });

  it("follows an allowed redirect chain — the mirror-to-storage shape still delivers verified bytes", async () => {
    // github.com 302s to its asset host in production; the
    // test's honest stand-in is a hop that stays on an allowed origin. The
    // hop is followed, the digest still decides, and the cache still lands.
    fake.assets.set("signed-blob-storage", BINARY_PAYLOAD.bytes);
    fake.redirects.set(BINARY, "/asset/signed-blob-storage");
    const fetched = await fetchArtifact(TARGET);
    expect(await drain(fetched.stream)).toBe(BINARY_PAYLOAD.bytes.byteLength);
    expect(readFileSync(artifactPath(TARGET), "utf8")).toBe("a convincing binary");
    expect(fake.assetFetches.get("signed-blob-storage")).toBe(1);
  });

  it("refuses an endless redirect chain at the hop budget, without fetching past it", async () => {
    // Self-redirecting on an ALLOWED origin — so what stops the walk is the
    // budget, not the pin. `assetFetches` proves the loop spent exactly
    // MAX_REDIRECT_HOPS + 1 requests and stopped, not a fetch-following
    // client's default 20 and not forever.
    fake.redirects.set(BINARY, `/asset/${encodeURIComponent(BINARY)}`);
    await expect(fetchArtifact(TARGET)).rejects.toThrow(new RegExp(`redirected more than ${MAX_REDIRECT_HOPS} times`));
    expect(fake.assetFetches.get(BINARY)).toBe(MAX_REDIRECT_HOPS + 1);
    expect(existsSync(artifactPath(TARGET))).toBe(false);
  });
});

describe("superseding", () => {
  it("removes a cached binary from an older release, and only a cached one", async () => {
    // One file we fetched at an old tag, and one the operator published.
    writeFileSync(artifactPath(TARGET), "stale");
    writeFileSync(join(NODE_ARTIFACTS_DIR, "subshell-node-cli-darwin-arm64"), "the operator's own");
    writeFileSync(
      join(NODE_ARTIFACTS_DIR, ".fetched.json"),
      JSON.stringify({ [TARGET]: { tag: "cli-node-v1.0.0", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" } }),
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
      JSON.stringify({
        "darwin-arm64": { tag: "cli-node-v1.0.0", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" },
      }),
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
      JSON.stringify({
        "darwin-arm64": { tag: "cli-node-v9.9.9", digest: "x", fetchedAt: "2026-01-01T00:00:00.000Z" },
      }),
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

  it("re-pins redirect hops too — a 302 off-list never writes the file its caller will EXECUTE", async () => {
    fake.redirects.set(BINARY, "http://169.254.169.254/latest/meta-data/");
    await expect(
      downloadVerified({
        url: assetUrl(BINARY),
        expectedDigest: BINARY_PAYLOAD.digest,
        destDir: NODE_ARTIFACTS_DIR,
        destName: "subshell-server",
      }),
    ).rejects.toThrow(/is neither a GitHub release host nor the configured release source's host/);
    expect(existsSync(join(NODE_ARTIFACTS_DIR, `subshell-server.download-${process.pid}`))).toBe(false);
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
