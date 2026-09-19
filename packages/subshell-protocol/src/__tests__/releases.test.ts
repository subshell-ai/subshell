import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION } from "../node-frames.js";
import {
  DEFAULT_RELEASE_API,
  hostReleaseTarget,
  newestRelease,
  parseReleaseManifest,
  parseReleaseTag,
  parseSidecarDigest,
  RELEASE_COMPONENTS,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_TAG_PREFIX,
  type ReleaseComponent,
  type ReleaseManifest,
  releaseAssetNames,
  SUBSHELL_REPO_SLUG,
} from "../releases.js";
import { MIN_AGENT_VERSION } from "../versions.js";

describe("parseReleaseTag", () => {
  it("takes the version out of each component's own tag", () => {
    expect(parseReleaseTag("cli-node", "cli-node-v0.2.0")).toBe("0.2.0");
    expect(parseReleaseTag("cli-server", "cli-server-v10.20.30")).toBe("10.20.30");
    expect(parseReleaseTag("desktop-server", "desktop-server-v0.6.0")).toBe("0.6.0");
    expect(parseReleaseTag("desktop-client", "desktop-client-v0.4.0")).toBe("0.4.0");
  });

  it("ignores every other component's tags", () => {
    // The four apps share one Releases page, and so do the seven npm
    // packages. A prefix test that also matched `desktop-client-v…` would
    // hand a node a desktop bundle.
    const foreign: Record<ReleaseComponent, string[]> = {
      "cli-node": ["cli-server-v0.2.0", "desktop-server-v0.2.0", "desktop-client-v0.1.3", "v0.2.0", "cli-node-v"],
      "cli-server": [
        "cli-node-v0.2.0",
        "desktop-server-v0.2.0",
        "desktop-client-v0.1.3",
        "@subshell-ai/plugin-api@1.0.0",
      ],
      "desktop-server": ["cli-server-v0.2.0", "desktop-client-v0.2.0", "cli-node-v0.2.0"],
      "desktop-client": ["cli-server-v0.2.0", "desktop-server-v0.2.0", "cli-node-v0.2.0"],
    };
    for (const component of RELEASE_COMPONENTS) {
      for (const tag of foreign[component]) expect(parseReleaseTag(component, tag), `${component}/${tag}`).toBeNull();
    }
  });

  it("no longer answers to the retired `server-v`/`node-v` prefixes", () => {
    // The hard cutover of 2026-09-18: every release published before it stays
    // on the Releases page, and no current build may treat one as its own.
    expect(parseReleaseTag("cli-server", "server-v1.2.3")).toBeNull();
    expect(parseReleaseTag("cli-node", "node-v1.2.3")).toBeNull();
  });

  it("refuses a prerelease or build-metadata suffix", () => {
    // An updater would otherwise hand a machine a build the release pipeline
    // does not smoke the same way.
    expect(parseReleaseTag("cli-node", "cli-node-v1.0.0-rc.1")).toBeNull();
    expect(parseReleaseTag("cli-server", "cli-server-v1.0.0+build7")).toBeNull();
    expect(parseReleaseTag("cli-server", "cli-server-v1.0")).toBeNull();
  });

  it("every component has its own prefix, and no prefix is another's prefix or suffix", () => {
    // Prefix: `parseReleaseTag` is a plain `startsWith`, and the release
    // workflow's publish job globs `<id>-*`. Suffix: not load-bearing, but
    // true since every prefix reads `<form>-<role>-v`, and asserting it is
    // what keeps the comment on RELEASE_TAG_PREFIX honest.
    const prefixes = RELEASE_COMPONENTS.map((c) => RELEASE_TAG_PREFIX[c]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(b.startsWith(a), `${b} starts with ${a}`).toBe(false);
        expect(b.endsWith(a), `${b} ends with ${a}`).toBe(false);
      }
    }
  });
});

describe("newestRelease", () => {
  it("picks by semver, not by the order given", () => {
    const tags = ["cli-node-v0.2.0", "cli-node-v0.10.0", "cli-node-v0.9.0"];
    expect(newestRelease("cli-node", tags)).toEqual({ tag: "cli-node-v0.10.0", version: "0.10.0" });
    expect(newestRelease("cli-node", [...tags].reverse())).toEqual({ tag: "cli-node-v0.10.0", version: "0.10.0" });
  });

  it("is not fooled by a re-cut publishing after a newer version", () => {
    // GitHub returns releases newest-FIRST by date. A date-ordered pick would
    // hand every machine a downgrade the day an old version is re-cut.
    expect(newestRelease("cli-node", ["cli-node-v0.1.9", "cli-node-v0.3.0"])?.version).toBe("0.3.0");
  });

  it("ignores another component's tag even when it parses as newer", () => {
    // The whole point of taking a component rather than inferring one.
    const mixed = ["cli-server-v0.6.0", "desktop-server-v9.9.9", "cli-node-v0.8.0", "desktop-client-v0.4.0"];
    expect(newestRelease("cli-server", mixed)).toEqual({ tag: "cli-server-v0.6.0", version: "0.6.0" });
    expect(newestRelease("cli-node", mixed)).toEqual({ tag: "cli-node-v0.8.0", version: "0.8.0" });
    expect(newestRelease("desktop-server", mixed)).toEqual({ tag: "desktop-server-v9.9.9", version: "9.9.9" });
  });

  it("answers null when the repository has no release of that component", () => {
    expect(newestRelease("cli-node", [])).toBeNull();
    expect(newestRelease("cli-node", ["cli-server-v1.0.0", "desktop-client-v1.0.0"])).toBeNull();
  });
});

describe("releaseAssetNames", () => {
  it("names exactly what each CLI release publishes", () => {
    // The artifact names are unchanged by the 2026-09-18 tag rename: they
    // already carried `cli`, just in the trailing position.
    expect(releaseAssetNames("cli-node", "darwin-arm64")).toEqual({
      binary: "subshell-node-cli-darwin-arm64",
      sidecar: "subshell-node-cli-darwin-arm64.sha256",
    });
    expect(releaseAssetNames("cli-server", "linux-x64")).toEqual({
      binary: "subshell-server-cli-linux-x64",
      sidecar: "subshell-server-cli-linux-x64.sha256",
    });
  });
});

describe("parseSidecarDigest", () => {
  const digest = "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e0";

  it("reads this repo's bare-digest sidecar", () => {
    expect(parseSidecarDigest(`${digest}\n`)).toBe(digest);
  });

  it("also reads `sha256sum` output, which a release could carry instead", () => {
    expect(parseSidecarDigest(`${digest}  subshell-node-cli-darwin-arm64\n`)).toBe(digest);
  });

  it("refuses anything that is not a digest", () => {
    // An HTML error page or a truncated download must never become the thing
    // a binary is verified against.
    expect(parseSidecarDigest("")).toBeNull();
    expect(parseSidecarDigest("<!doctype html>")).toBeNull();
    expect(parseSidecarDigest(digest.slice(0, 63))).toBeNull();
    expect(parseSidecarDigest(digest.toUpperCase())).toBeNull();
  });
});

describe("parseReleaseManifest", () => {
  const good: ReleaseManifest = {
    component: "cli-node",
    version: "0.9.0",
    nodeProtocol: NODE_PROTOCOL_VERSION,
    minAgentVersion: MIN_AGENT_VERSION,
    commit: "0123456789abcdef0123456789abcdef01234567",
    assets: { "subshell-node-cli-linux-x64": "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e0" },
  };
  /** A manifest with one field spoiled — the shape a hand-edit or a future pipeline could produce. */
  const spoiled = (over: Record<string, unknown>): string => JSON.stringify({ ...good, ...over });

  it("reads a manifest a release script wrote", () => {
    expect(parseReleaseManifest(JSON.stringify(good))).toEqual(good);
    // Pretty-printed with a trailing newline is what the writer emits.
    expect(parseReleaseManifest(`${JSON.stringify(good, null, 2)}\n`)).toEqual(good);
  });

  it("answers null rather than throwing on anything unexpected", () => {
    // "No manifest" and "an unreadable manifest" have the same answer — do not
    // offer this release — so neither may be a throw on a page that is only
    // asking what is available.
    expect(parseReleaseManifest("")).toBeNull();
    expect(parseReleaseManifest("not json")).toBeNull();
    expect(parseReleaseManifest("null")).toBeNull();
    expect(parseReleaseManifest("[]")).toBeNull();
    expect(parseReleaseManifest(spoiled({ component: "agent" }))).toBeNull();
    // The retired ids (2026-09-18). A manifest from a pre-rename release must
    // read as unknown, exactly as a manifest from some future pipeline does.
    expect(parseReleaseManifest(spoiled({ component: "server" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ component: "node" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ version: "0.9" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ nodeProtocol: "10" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ nodeProtocol: 9.5 }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ minAgentVersion: "" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ commit: "" }))).toBeNull();
  });

  it("requires the assets map — the trust anchor of spec 2026-09-17 D2", () => {
    // A pre-change release (no `assets`) must read as UNKNOWN, not as a
    // manifest whose digests live somewhere else: the sidecar stops being a
    // trust anchor the day the manifest is, and half a trust is none.
    expect(parseReleaseManifest(spoiled({ assets: undefined }))).toBeNull();
    const { assets: _gone, ...preChange } = good;
    expect(parseReleaseManifest(JSON.stringify(preChange))).toBeNull();
    // An empty map is a signer that forgot the digests, not a real release.
    expect(parseReleaseManifest(spoiled({ assets: {} }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ assets: [] }))).toBeNull();
    expect(
      parseReleaseManifest(spoiled({ assets: "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e0" })),
    ).toBeNull();
    // Values are LOWERCASE hex digests — a typo or an uppercase digest is a
    // digest nothing will ever match, so it is a broken manifest.
    expect(parseReleaseManifest(spoiled({ assets: { a: "not-a-digest" } }))).toBeNull();
    expect(
      parseReleaseManifest(
        spoiled({ assets: { a: "84B7F6AB0D7FC1242440131AA86E26707B187860E94BE68B83EF2698E93319E0" } }),
      ),
    ).toBeNull();
    expect(
      parseReleaseManifest(
        spoiled({ assets: { a: "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e" } }),
      ),
    ).toBeNull();
    expect(
      parseReleaseManifest(
        spoiled({ assets: { "": "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e0" } }),
      ),
    ).toBeNull();
  });

  it("names the assets it parses", () => {
    expect(RELEASE_MANIFEST_NAME).toBe("release-manifest.json");
    expect(RELEASE_MANIFEST_SIG_NAME).toBe("release-manifest.json.sig");
  });
});

describe("hostReleaseTarget", () => {
  it("maps the three published platforms", () => {
    expect(hostReleaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostReleaseTarget("linux", "x64")).toBe("linux-x64");
    expect(hostReleaseTarget("linux", "arm64")).toBe("linux-arm64");
  });

  it("answers null for every platform this repo does not publish", () => {
    // An Intel Mac is the real population here, and the answer has to be
    // "there is no artifact for you", never a nearby triple.
    expect(hostReleaseTarget("darwin", "x64")).toBeNull();
    expect(hostReleaseTarget("linux", "ia32")).toBeNull();
    expect(hostReleaseTarget("win32", "x64")).toBeNull();
    expect(hostReleaseTarget("freebsd", "x64")).toBeNull();
    expect(hostReleaseTarget("", "")).toBeNull();
  });
});

describe("the release source", () => {
  it("reads the LIST endpoint, not /releases/latest", () => {
    // "Latest" is a property of the whole repository, and this one publishes
    // four apps plus a release per npm package — the newest release is very
    // often not the one a caller wants.
    expect(DEFAULT_RELEASE_API).toBe(`https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases?per_page=100`);
    expect(DEFAULT_RELEASE_API).not.toContain("/latest");
  });

  it("asks for 100 per page", () => {
    // One version-PR merge can publish four app releases plus seven npm ones,
    // so the API's default of 30 can miss a component entirely — and a missing
    // component reads as "no update available", not as a truncated list.
    expect(DEFAULT_RELEASE_API).toContain("per_page=100");
  });
});
