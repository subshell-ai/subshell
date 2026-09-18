/**
 * The three spellings of the publisher's identity are ONE string (spec
 * 2026-09-17 §5): `RELEASE_PUBKEY` (what the CLI update paths verify
 * against), and the two `plugins.updater.pubkey` values (what each desktop
 * app compiles in for `tauri-plugin-updater`). Tauri reads its own config at
 * bundle time, so both copies must exist; this test is what makes a key
 * rotation edit all three knowingly or fail CI.
 *
 * It lives HERE rather than in either desktop app's `release.test.ts` because
 * the protocol constant is the single source of truth the other two must
 * agree with — and because a desktop suite cannot run at all without a
 * staged sidecar (root AGENTS.md, "rust:check"), while this one is three
 * file reads.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { RELEASE_PUBKEY } from "../releases.js";

/** The repo root, walked up from `packages/subshell-protocol/src/__tests__`. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const configs: Record<string, string> = {
  "apps/server/desktop": "apps/server/desktop/src-tauri/tauri.conf.json",
  "apps/client/desktop": "apps/client/desktop/src-tauri/tauri.conf.json",
};

describe("RELEASE_PUBKEY — the three-spelling equality (a rotation edits all three or fails)", () => {
  for (const [app, rel] of Object.entries(configs)) {
    it(`equals the ${app} updater pubkey`, async () => {
      const doc = (await Bun.file(join(REPO_ROOT, rel)).json()) as {
        plugins: { updater: { pubkey: string } };
      };
      expect(doc.plugins.updater.pubkey).toBe(RELEASE_PUBKEY);
    });
  }

  it("is minisign armor, not a placeholder", () => {
    expect(RELEASE_PUBKEY.startsWith("REPLACE_ME")).toBe(false);
    // Base64 armor whose decoded text carries the public-key comment line.
    const decoded = Buffer.from(RELEASE_PUBKEY.trim(), "base64").toString("utf8");
    expect(decoded).toContain("minisign public key:");
  });
});
