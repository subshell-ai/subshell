import { describe, expect, test } from "bun:test";
import {
  AGENT_SIDECAR_NAME,
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  NODE_TARGETS,
  nodeArtifactFileName,
  rustTargetTriple,
  SERVER_SIDECAR_NAME,
  SERVER_TARGETS,
  serverArtifactFileName,
} from "../paths.js";

/**
 * These names are a contract between four places that never import each other:
 * the release script that writes the staged sidecar, `tauri.conf.json` which
 * declares its stem, the CI smoke that greps inside the built bundle, and the
 * Rust that resolves the copy source at runtime. Drift is invisible until
 * `cargo build` says "binary not found" — or, worse, until the smoke greps for
 * a name that can never be there and reports a pass.
 *
 * The PUBLISHED artifact name is no longer part of that contract with Tauri:
 * the pipelines glob the bundle directory for whatever the bundler wrote and
 * rename it, so `desktopArtifactFileName` is this repo's own choice and the
 * product names are free to contain spaces.
 */
describe("desktop targets", () => {
  // A desktop build BUNDLES a server, so a triple with no server binary to
  // bundle cannot be built at all.
  test("every desktop target is also a server target", () => {
    for (const target of DESKTOP_TARGETS) {
      expect(SERVER_TARGETS).toContain(target);
    }
  });

  // Excluded deliberately: there is no native arm64 Linux runner, and a
  // `file(1)` magic check cannot see the characteristic GUI failure, which is
  // an invisible window.
  test("linux-arm64 is not a desktop target", () => {
    expect(DESKTOP_TARGETS).not.toContain("linux-arm64" as never);
  });

  test("every target maps to a Rust triple", () => {
    expect(rustTargetTriple("linux-x64")).toBe("x86_64-unknown-linux-gnu");
    expect(rustTargetTriple("darwin-arm64")).toBe("aarch64-apple-darwin");
    for (const target of DESKTOP_TARGETS) {
      expect(rustTargetTriple(target)).toMatch(/^[a-z0-9_]+-[a-z-]+$/);
    }
  });

  test("an unknown triple is refused, never guessed", () => {
    expect(() => rustTargetTriple("linux-arm64")).toThrow(/no Rust target triple/);
    expect(() => rustTargetTriple("")).toThrow();
  });
});

describe("sidecar naming", () => {
  // The staged file carries the Rust triple; Tauri strips it on copy. Two
  // different strings, both needed.
  test("the staged name carries the Rust triple and the in-bundle name does not", () => {
    expect(desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-arm64")).toBe(
      "subshell-server-bundled-aarch64-apple-darwin",
    );
    expect(desktopSidecarFileName(SERVER_SIDECAR_NAME, "linux-x64")).toBe(
      "subshell-server-bundled-x86_64-unknown-linux-gnu",
    );
    expect(SERVER_SIDECAR_NAME).toBe("subshell-server-bundled");
    for (const target of DESKTOP_TARGETS) {
      expect(desktopSidecarFileName(SERVER_SIDECAR_NAME, target).startsWith(`${SERVER_SIDECAR_NAME}-`)).toBe(true);
      expect(desktopSidecarFileName(SERVER_SIDECAR_NAME, target)).not.toBe(SERVER_SIDECAR_NAME);
    }
  });

  // Tauri puts externalBin in /usr/bin on Debian. A sidecar named
  // `subshell-server` would own a system-wide binary on every user's PATH.
  test("the sidecar never claims the plain server name", () => {
    expect(SERVER_SIDECAR_NAME).not.toBe("subshell-server");
    expect(SERVER_SIDECAR_NAME.startsWith("subshell-server-")).toBe(true);
    // Same rule for the node agent, and for the same reason: Debian puts an
    // externalBin in /usr/bin, so a sidecar named `subshell` would own that
    // name system-wide on every machine the node app is installed on.
    expect(AGENT_SIDECAR_NAME).not.toBe("subshell");
    expect(AGENT_SIDECAR_NAME.startsWith("subshell-")).toBe(true);
    // The two apps can be installed side by side, so nothing they place in
    // /usr/bin may collide.
    expect(AGENT_SIDECAR_NAME).not.toBe(SERVER_SIDECAR_NAME);
    expect(DESKTOP_CLIENT_PRODUCT).not.toBe(DESKTOP_SERVER_PRODUCT);
  });
});

describe("published artifacts", () => {
  test("macOS ships a versioned, tripled DMG, Linux a versioned deb", () => {
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", "1.2.3")).toBe(
      "Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg",
    );
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")).toBe(
      "subshell-server-desktop_1.2.3_amd64.deb",
    );
    expect(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, "darwin-arm64", "0.1.0")).toBe(
      "Subshell-Client-Desktop-0.1.0-darwin-arm64.dmg",
    );
    expect(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, "linux-x64", "0.1.0")).toBe(
      "subshell-client-desktop_0.1.0_amd64.deb",
    );
  });

  // The published name is a download URL and a shell argument, so it is
  // space-free — while the product name it comes from is not, and the `.app`
  // inside the DMG keeps its spaced name. That split is the whole reason
  // the pipelines glob for what the bundler emitted instead of predicting it:
  // the emitted `.deb` name goes through Debian's own sanitizer.
  test("every published name is space-free, whatever the product is called", () => {
    for (const product of [DESKTOP_SERVER_PRODUCT, DESKTOP_CLIENT_PRODUCT]) {
      for (const target of DESKTOP_TARGETS) {
        expect(desktopArtifactFileName(product, target, "1.2.3")).not.toMatch(/\s/);
      }
    }
    // Whitespace collapses to one hyphen rather than being dropped, so two
    // products cannot slug to the same file name.
    expect(desktopArtifactFileName("Two  Words", "darwin-arm64", "1.0.0")).toBe(
      "Two-Words-Desktop-1.0.0-darwin-arm64.dmg",
    );
    expect(desktopArtifactFileName(" Padded ", "linux-x64", "1.0.0")).toBe("padded-desktop_1.0.0_amd64.deb");
  });

  test("the deb is lowercased and the dmg is not", () => {
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")).toBe(
      desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3").toLowerCase(),
    );
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", "1.2.3")).toMatch(
      /^Subshell-Server-Desktop-/,
    );
  });

  // Two apps publish into ONE GitHub release directory per cut.
  test("the two apps never publish the same file name", () => {
    for (const target of DESKTOP_TARGETS) {
      expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, target, "1.2.3")).not.toBe(
        desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, target, "1.2.3"),
      );
    }
  });

  test("an unknown target has no artifact name", () => {
    expect(() => desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "windows-x64", "1.0.0")).toThrow(
      /no desktop artifact name/,
    );
  });
});

/**
 * The property the suffixes exist to buy, pinned across ALL FOUR producers
 * rather than desktop-vs-CLI: whatever lands in one downloads folder must be
 * tellable apart, by a human reading it and by a glob or a tab-completion
 * running over it.
 */
const VERSION = "0.5.0";

/** What the name has to SAY: an app bundle, or the bare CLI binary it wraps. */
type ArtifactKind = "cli" | "desktop";

interface PublishedArtifact {
  /** The name its pipeline publishes it under. */
  name: string;
  /** Which pipeline published it — quoted in a failure so it can be found. */
  producer: string;
  /** The word this name must carry. */
  kind: ArtifactKind;
}

/**
 * Every artifact the four release pipelines publish for ONE version. Each
 * lands as two files — the artifact and its `.sha256` sidecar, derived from
 * the same name by `publishArtifacts` / the desktop `collectArtifact`s — which
 * is why the collision check below expands each entry rather than testing the
 * bare names.
 */
function publishedArtifacts(): PublishedArtifact[] {
  return [
    ...SERVER_TARGETS.map((t) => ({ name: serverArtifactFileName(t), producer: "server CLI", kind: "cli" as const })),
    ...NODE_TARGETS.map((t) => ({ name: nodeArtifactFileName(t), producer: "agent CLI", kind: "cli" as const })),
    ...DESKTOP_TARGETS.flatMap((t) => [
      {
        name: desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, t, VERSION),
        producer: "desktop-server",
        kind: "desktop" as const,
      },
      {
        name: desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, t, VERSION),
        producer: "desktop-client",
        kind: "desktop" as const,
      },
    ]),
  ];
}

/** The files one artifact actually puts on disk. */
function publishedFiles(artifact: PublishedArtifact): string[] {
  return [artifact.name, `${artifact.name}.sha256`];
}

/**
 * A name's words as a reader parses them: `-`, `_` and `.` all separate. The
 * kind check runs on these and NOT on substrings, because
 * `subshell-client-desktop_…` contains "cli" inside "client" — a substring
 * test would read the desktop-client bundle as a CLI artifact.
 */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
}

describe("the published artifact set (all four producers)", () => {
  test("the set is every triple of every producer, and nothing else", () => {
    expect(publishedArtifacts()).toHaveLength(SERVER_TARGETS.length + NODE_TARGETS.length + DESKTOP_TARGETS.length * 2);
  });

  // Equality is the obvious half; PREFIX is the half that bites. A binary
  // legitimately prefixes its OWN sidecar, so the pairing is per-artifact:
  // across two DIFFERENT artifacts, no published file may prefix another, or a
  // `subshell-node-cli-linux-x64*` glob sweeps up a second product's files too.
  //
  // Compared CASE-FOLDED, because the whole argument is about a downloads
  // folder and the default file systems on macOS (APFS) and Windows are
  // case-insensitive: `Subshell-Server-Desktop…` and `subshell-server-desktop…`
  // are two names here and one name there. The raw names go in the violation
  // message so a failure is still readable.
  test("no two artifacts collide, by equality or by prefix — sidecars included", () => {
    const artifacts = publishedArtifacts();
    const violations: string[] = [];
    for (const a of artifacts) {
      for (const b of artifacts) {
        if (a === b) continue;
        for (const fileA of publishedFiles(a)) {
          for (const fileB of publishedFiles(b)) {
            const foldedA = fileA.toLowerCase();
            const foldedB = fileB.toLowerCase();
            if (foldedA === foldedB) violations.push(`${a.producer} and ${b.producer} both publish ${fileA}`);
            else if (foldedB.startsWith(foldedA)) {
              violations.push(`${b.producer}'s ${fileB} starts with ${a.producer}'s ${fileA}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("every name says which kind it is, as a whole token", () => {
    for (const artifact of publishedArtifacts()) {
      const words = tokens(artifact.name);
      expect(words).toContain(artifact.kind);
      expect(words).not.toContain(artifact.kind === "cli" ? "desktop" : "cli");
    }
  });

  // The trap the token split exists for, stated as its own case so nobody
  // "simplifies" it back to a substring check.
  test("'client' is not the token 'cli'", () => {
    const deb = desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, "linux-x64", VERSION);
    expect(deb).toContain("cli"); // inside "client"
    expect(tokens(deb)).not.toContain("cli");
  });

  // The platform triple stays LAST in a CLI name — the thing a human scans a
  // downloads folder for, and what `.sha256` attaches to. The desktop DMG ends
  // with the triple too, extension after it; its `.deb` sibling ends with the
  // Debian arch for the same reason.
  test("every name ends with its platform", () => {
    for (const target of SERVER_TARGETS) expect(serverArtifactFileName(target).endsWith(target)).toBe(true);
    for (const target of NODE_TARGETS) expect(nodeArtifactFileName(target).endsWith(target)).toBe(true);
    for (const product of [DESKTOP_SERVER_PRODUCT, DESKTOP_CLIENT_PRODUCT]) {
      expect(desktopArtifactFileName(product, "darwin-arm64", VERSION).endsWith("-darwin-arm64.dmg")).toBe(true);
      expect(desktopArtifactFileName(product, "linux-x64", VERSION).endsWith("_amd64.deb")).toBe(true);
    }
  });
});
