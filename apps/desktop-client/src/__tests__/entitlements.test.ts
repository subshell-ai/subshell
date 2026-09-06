import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The entitlements file is the sharpest edge in this app, and it is one line
 * of config with no runtime signal when it is wrong.
 *
 * Tauri has exactly ONE entitlements slot and applies it to every sign target
 * in the bundle — the sidecar, the GUI binary and any framework alike. There
 * is no per-binary key and no macOS custom-sign hook. So every entitlement the
 * Bun-compiled node agent needs is also granted to the GUI process, which is
 * the one that drives the CLI, writes the node config and installs a service.
 *
 * Which makes the SHORT list a security property rather than tidiness, and
 * worth a test: a future "just add the key Bun's docs mention" would otherwise
 * be invisible in review.
 */
const PLIST = join(import.meta.dir, "../../src-tauri/entitlements.plist");
/** The bare-binary download channel's plist — deliberately a much wider set. */
const BARE_BINARY_PLIST = join(import.meta.dir, "../../../../scripts/macos-entitlements.plist");
/** The other desktop app's plist — same two keys today, separate file by design. */
const DESKTOP_SERVER_PLIST = join(import.meta.dir, "../../../desktop-server/src-tauri/entitlements.plist");

/** The keys the bundle grants. */
function entitlementKeys(): string[] {
  const text = readFileSync(PLIST, "utf8");
  return [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => (m[1] as string).trim());
}

describe("macOS entitlements", () => {
  // The same two `apps/desktop-server` pins, and for the same measured reason:
  // a `bun build --compile` binary signed ad-hoc with `--options runtime` and
  // ONLY these two runs. See apps/desktop-server/AGENTS.md for the caveat that
  // this was ad-hoc rather than Developer ID.
  test("grants exactly the two keys Bun's JIT needs", () => {
    expect(entitlementKeys().sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ]);
  });

  // These are the three that would otherwise ride along onto the GUI process.
  // `disable-library-validation` + `allow-dyld-environment-variables` in
  // particular is the pair that turns a signed app into a code-injection host.
  test("grants none of the dangerous keys the bare-binary channel carries", () => {
    const keys = entitlementKeys();
    for (const forbidden of [
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-executable-page-protection",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // AMFI's plist parser is strict and rejects comments outright — a commented
  // entitlements file fails at LAUNCH, after notarization has passed.
  test("carries no XML comments", () => {
    expect(readFileSync(PLIST, "utf8")).not.toContain("<!--");
  });

  // The app bundle and the bare-binary download channel are signed by
  // different pipelines and must be free to diverge; sharing one file would
  // silently widen whichever one was not being edited.
  test("is a separate file from the bare-binary channel's", () => {
    expect(readFileSync(BARE_BINARY_PLIST, "utf8")).not.toEqual(readFileSync(PLIST, "utf8"));
  });

  // The two desktop apps' plists have the SAME CONTENT today, so content is no
  // evidence at all here — the property is that they are two files. A symlink
  // or a hard link would be the tidy-looking way to share one, and then a key
  // added for the server app's bundled server would silently widen the node
  // app's GUI (and vice versa) in a pipeline nobody was editing.
  test("is a separate file from the desktop-server app's", () => {
    expect(realpathSync(PLIST)).not.toEqual(realpathSync(DESKTOP_SERVER_PLIST));
    expect(lstatSync(PLIST).isSymbolicLink()).toBe(false);
    const [mine, theirs] = [statSync(PLIST), statSync(DESKTOP_SERVER_PLIST)];
    expect([mine.dev, mine.ino]).not.toEqual([theirs.dev, theirs.ino]);
  });
});
