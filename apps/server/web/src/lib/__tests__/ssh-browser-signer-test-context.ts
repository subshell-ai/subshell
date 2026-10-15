import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSshSigner } from "../ssh-browser-signer-core";
import { type Fixture, generateFixture, hostFixture, PASSWORD } from "./ssh-browser-signer-fixtures";

export const variants = [
  ["ed25519", "ed25519", undefined],
  ["rsa", "rsa", 2048],
  ["p256", "ecdsa", 256],
  ["p384", "ecdsa", 384],
  ["p521", "ecdsa", 521],
] as const;

export function browserSignerFixtures() {
  const host = hostFixture();
  const fixtures = new Map<string, Fixture>();
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "subshell-browser-signer-"));
    for (const [name, type, bits] of variants) {
      fixtures.set(name, generateFixture(directory, name, type, bits));
      fixtures.set(`${name}-encrypted`, generateFixture(directory, `${name}-encrypted`, type, bits, true));
    }
    fixtures.set("rsa-small", generateFixture(directory, "rsa-small", "rsa", 1024));
  });

  afterAll(() => {
    for (const fixture of fixtures.values()) fixture.bytes.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(name = "ed25519"): Fixture {
    const found = fixtures.get(name);
    if (!found) throw new Error("Test fixture wasn't generated.");
    return found;
  }

  function create(
    name = "ed25519",
    options: { hostKey?: string; expiresAt?: number; passphrase?: Uint8Array; bytes?: Uint8Array } = {},
  ) {
    return createBrowserSshSigner({
      user: "alice",
      hostKey: options.hostKey ?? host.encoded,
      expiresAt: options.expiresAt ?? Date.now() + 89_000,
      bytes: options.bytes ?? fixture(name).bytes.slice(),
      passphrase: options.passphrase ?? (name.endsWith("-encrypted") ? new TextEncoder().encode(PASSWORD) : undefined),
    });
  }

  return { host, fixture, create, directory: () => directory };
}
