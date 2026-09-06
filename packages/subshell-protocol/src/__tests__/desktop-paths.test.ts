import { describe, expect, test } from "bun:test";
import {
  BUNDLED_SIDECAR_NAME,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  rustTargetTriple,
  SERVER_TARGETS,
} from "../paths.js";

/**
 * These names are a contract between four places that never import each other:
 * the release script that writes the staged sidecar, `tauri.conf.json` which
 * declares its stem, the CI smoke that greps inside the built bundle, and the
 * Rust that resolves the copy source at runtime. Drift is invisible until
 * `cargo build` says "binary not found" — or, worse, until the smoke greps for
 * a name that can never be there and reports a pass.
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
    expect(desktopSidecarFileName("darwin-arm64")).toBe("subshell-server-bundled-aarch64-apple-darwin");
    expect(desktopSidecarFileName("linux-x64")).toBe("subshell-server-bundled-x86_64-unknown-linux-gnu");
    expect(BUNDLED_SIDECAR_NAME).toBe("subshell-server-bundled");
    for (const target of DESKTOP_TARGETS) {
      expect(desktopSidecarFileName(target).startsWith(`${BUNDLED_SIDECAR_NAME}-`)).toBe(true);
      expect(desktopSidecarFileName(target)).not.toBe(BUNDLED_SIDECAR_NAME);
    }
  });

  // Tauri puts externalBin in /usr/bin on Debian. A sidecar named
  // `subshell-server` would own a system-wide binary on every user's PATH.
  test("the sidecar never claims the plain server name", () => {
    expect(BUNDLED_SIDECAR_NAME).not.toBe("subshell-server");
    expect(BUNDLED_SIDECAR_NAME.startsWith("subshell-server-")).toBe(true);
  });
});

describe("published artifacts", () => {
  test("macOS ships a tarball, Linux a versioned deb", () => {
    expect(desktopArtifactFileName("darwin-arm64", "1.2.3")).toBe("Subshell.app.tar.gz");
    expect(desktopArtifactFileName("linux-x64", "1.2.3")).toBe("Subshell_1.2.3_amd64.deb");
  });

  test("an unknown target has no artifact name", () => {
    expect(() => desktopArtifactFileName("windows-x64", "1.0.0")).toThrow(/no desktop artifact name/);
  });
});
