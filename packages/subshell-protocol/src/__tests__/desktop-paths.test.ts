import { describe, expect, test } from "bun:test";
import {
  AGENT_SIDECAR_NAME,
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  rustTargetTriple,
  SERVER_SIDECAR_NAME,
  SERVER_TARGETS,
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
  test("macOS ships a tarball, Linux a versioned deb", () => {
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", "1.2.3")).toBe("Subshell-Server.app.tar.gz");
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")).toBe(
      "subshell-server_1.2.3_amd64.deb",
    );
    expect(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, "darwin-arm64", "0.1.0")).toBe("Subshell-Client.app.tar.gz");
    expect(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, "linux-x64", "0.1.0")).toBe(
      "subshell-client_0.1.0_amd64.deb",
    );
  });

  // The published name is a download URL and a shell argument, so it is
  // space-free — while the product name it comes from is not, and the `.app`
  // inside the tarball keeps its spaced name. That split is the whole reason
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
    expect(desktopArtifactFileName("Two  Words", "darwin-arm64", "1.0.0")).toBe("Two-Words.app.tar.gz");
    expect(desktopArtifactFileName(" Padded ", "linux-x64", "1.0.0")).toBe("padded_1.0.0_amd64.deb");
  });

  // A Debian package name must be lowercase; the macOS tarball keeps the
  // product's own capitalization, because that is the name a user downloads.
  test("the deb is lowercased and the tarball is not", () => {
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")).toBe(
      desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3").toLowerCase(),
    );
    expect(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", "1.2.3")).toMatch(/^Subshell-Server\./);
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
