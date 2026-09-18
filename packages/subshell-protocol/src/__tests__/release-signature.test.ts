/**
 * Pins the verifier against REAL `tauri signer` output, and the sign half
 * against the CLI contract, without ever touching a private key that matters
 * (spec 2026-09-17 §5). The fixture trio in `fixtures/release-signature/` was
 * produced once by the repo's own `@tauri-apps/cli`; if a future signer
 * changes armor or hashing, the first test fails in CI rather than every
 * installed binary silently losing update ability at its next check.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signPublishedReleaseManifest,
  signReleaseManifestArtifacts,
  verifyReleaseManifest,
} from "../release-signature.js";
import { parseReleaseManifest, RELEASE_PUBKEY, type ReleaseManifest } from "../releases.js";

const FIX = join(import.meta.dir, "fixtures/release-signature");
const manifestBytes = (): Promise<Buffer> =>
  Bun.file(join(FIX, "release-manifest.json")).arrayBuffer().then(Buffer.from);
const sigText = (): Promise<string> => Bun.file(join(FIX, "release-manifest.sig")).text();
const publisherPubkey = (): Promise<string> => Bun.file(join(FIX, "publisher-pubkey.txt")).text();
const otherPubkey = (): Promise<string> => Bun.file(join(FIX, "other-pubkey.txt")).text();

const EXPECTED = { component: "node", version: "9.9.9" } as const;

describe("the fixture trio is well-formed", () => {
  it("parses with the production parser, and its digests are digests", async () => {
    // Cheap guard on the committed bytes: a fixture the strict parser rejects
    // would make "the verifier accepts the fixture" test the wrong thing.
    const parsed = parseReleaseManifest((await manifestBytes()).toString("utf8"));
    expect(parsed).not.toBeNull();
    expect(parsed?.component).toBe("node");
    expect(parsed?.version).toBe("9.9.9");
    for (const digest of Object.values(parsed?.assets ?? {})) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyReleaseManifest", () => {
  it("accepts the fixture — the toolchain interop pin", async () => {
    const res = await verifyReleaseManifest(await manifestBytes(), await sigText(), await publisherPubkey(), EXPECTED);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.assets["subshell-node-cli-linux-x64"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the raw (unwrapped) armor the stock minisign tool writes", async () => {
    // Tauri's `.sig` FILE is base64 of the four-line block; `minisign -S`
    // writes the block itself. Both spellings are in the wild (§3).
    const wrapped = await sigText();
    const raw = Buffer.from(wrapped.trim(), "base64").toString("utf8");
    expect(raw).toContain("untrusted comment:");
    const res = await verifyReleaseManifest(await manifestBytes(), raw, await publisherPubkey(), EXPECTED);
    expect(res.ok).toBe(true);
  });

  it("rejects any byte flip in the manifest", async () => {
    const bytes = await manifestBytes();
    bytes[5] ^= 0xff;
    const res = await verifyReleaseManifest(bytes, await sigText(), await publisherPubkey(), EXPECTED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("does not cover");
  });

  it("rejects a digest edited inside the manifest, re-serialized to look normal", async () => {
    // The canonical-bytes rule (§3) in test: parse-then-re-verify of the same
    // DATA at different BYTES must fail, because the signature covers bytes,
    // not values.
    const text = (await manifestBytes()).toString("utf8");
    const touched = text.replace(
      /"subshell-node-cli-linux-x64": "([0-9a-f]{4})/,
      '"subshell-node-cli-linux-x64": "ffff',
    );
    expect(touched).not.toBe(text);
    const res = await verifyReleaseManifest(touched, await sigText(), await publisherPubkey(), EXPECTED);
    expect(res.ok).toBe(false);
  });

  it("refuses a node release's signature when asked to install a server release — the payload-binding claim", async () => {
    // The signature is VALID and the key is right; the payload just does not
    // say what the caller was told to install. This is the cross-component
    // replay refusal, tested (§5 d).
    const res = await verifyReleaseManifest(await manifestBytes(), await sigText(), await publisherPubkey(), {
      component: "server",
      version: "9.9.9",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('"server"');
  });

  it("refuses a version other than the one the manifest names", async () => {
    const res = await verifyReleaseManifest(await manifestBytes(), await sigText(), await publisherPubkey(), {
      component: "node",
      version: "9.9.8",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("9.9.8");
  });

  it("refuses a signature made under a different key id", async () => {
    const res = await verifyReleaseManifest(await manifestBytes(), await sigText(), await otherPubkey(), EXPECTED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("different key");
  });

  it("fails closed on every armor shape anomaly", async () => {
    const bytes = await manifestBytes();
    const sig = await sigText();
    const pub = await publisherPubkey();
    // Garbage and empty are the two operators will actually hit (a 404 body,
    // a truncated upload); the rest are hand-edit territory.
    for (const bad of ["", "   ", "not a signature", "dGF0aGE=", Buffer.alloc(32).toString("base64")]) {
      const res = await verifyReleaseManifest(bytes, bad, pub, EXPECTED);
      expect(res.ok).toBe(false);
    }
    // Three lines instead of four.
    const three = sig.length > 40 ? sig.slice(0, Math.floor(sig.length / 2)) : sig;
    expect((await verifyReleaseManifest(bytes, three, pub, EXPECTED)).ok).toBe(false);
    // A forged LEGACY ("Ed") sig line — the alg byte of the blob, flipped
    // back from "ED". minisign-verify rejects legacy by default; so do we.
    const raw = Buffer.from(sig.trim(), "base64").toString("utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const blob = Buffer.from(lines[1]!, "base64");
    blob[1] = 0x64; // "ED" -> "Ed"
    lines[1] = blob.toString("base64");
    const legacy = Buffer.from(`${lines.join("\n")}\n`).toString("base64");
    const res = await verifyReleaseManifest(bytes, legacy, pub, EXPECTED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("legacy");
  });

  it("fails closed on the global signature (the format's cross-check)", async () => {
    // Flip the global sig's first byte; the main signature still covers the
    // bytes, so only the global check can catch a comments-vs-signature
    // mismatch — the check that "comes for free from the same public key".
    const raw = Buffer.from((await sigText()).trim(), "base64").toString("utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const global = Buffer.from(lines[3]!, "base64");
    global[0] ^= 0xff;
    lines[3] = global.toString("base64");
    const res = await verifyReleaseManifest(
      await manifestBytes(),
      Buffer.from(`${lines.join("\n")}\n`).toString("base64"),
      await publisherPubkey(),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("global");
  });

  it("refuses before any crypto when the build ships no publisher pubkey", async () => {
    for (const pub of ["", "   ", "REPLACE_ME_from_tauri_signer_generate"]) {
      const res = await verifyReleaseManifest(await manifestBytes(), await sigText(), pub, EXPECTED);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("no publisher pubkey");
    }
  });

  it("never throws, whatever the inputs", async () => {
    // Every branch must be an answer, not a surprise — the call sites render
    // `reason`, they do not try/catch.
    for (const bytes of ["", "x", "{}", (await manifestBytes()).subarray(0, 3)]) {
      for (const sig of ["", "junk", "a\nb\nc\nd"]) {
        const res = await verifyReleaseManifest(bytes, sig, await publisherPubkey(), EXPECTED);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(typeof res.reason).toBe("string");
      }
    }
  });
});

describe("signReleaseManifestArtifacts", () => {
  it("refuses without a key, and refuses bytes that contradict the manifest", async () => {
    await expect(signReleaseManifestArtifacts("", "{}", {} as ReleaseManifest)).rejects.toThrow(/no private key/);
    const manifest = parseReleaseManifest((await manifestBytes()).toString("utf8"))!;
    await expect(signReleaseManifestArtifacts("sk", "not json", manifest)).rejects.toThrow(
      /not a valid release manifest/,
    );
    await expect(
      signReleaseManifestArtifacts("sk", (await manifestBytes()).toString("utf8"), {
        ...manifest,
        component: "server",
      }),
    ).rejects.toThrow(/not server 9.9.9/);
  });

  it("shells to the CLI with the key in the ENVIRONMENT only, and returns the .sig beside the file", async () => {
    // The end-to-end sign is proven once by the committed fixture (produced
    // by this very CLI) and again by `published-release.sh` against a live
    // cut; this pins the plumbing without needing the fixture PRIVATE key —
    // the argv never carries key material, and what the CLI writes next to
    // the file is what the function returns.
    const manifest = parseReleaseManifest((await manifestBytes()).toString("utf8"))!;
    const bytes = (await manifestBytes()).toString("utf8");
    let seenArgv: string[] | undefined;
    let seenEnv: Record<string, string> | undefined;
    const sig = await signReleaseManifestArtifacts("SECRET-KEY-CONTENTS", bytes, manifest, {
      tauriCli: ["fake-tauri"],
      password: "pw",
      run: async (argv, env) => {
        seenArgv = argv;
        seenEnv = env;
        // Real contract: the CLI writes `<file>.sig` beside its argument.
        await Bun.write(`${argv.at(-1)}.sig`, "ARMOR-BYTES");
        return { code: 0, out: "", err: "" };
      },
    });
    expect(sig).toBe("ARMOR-BYTES");
    expect(seenArgv?.slice(0, 3)).toEqual(["fake-tauri", "signer", "sign"]);
    expect(seenArgv?.at(-1)?.endsWith("release-manifest.json")).toBe(true);
    expect(seenArgv?.join(" ")).not.toContain("SECRET-KEY-CONTENTS");
    expect(seenEnv?.TAURI_SIGNING_PRIVATE_KEY).toBe("SECRET-KEY-CONTENTS");
    expect(seenEnv?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("pw");
  });

  it("throws when the CLI fails — a shard with the key never publishes unsigned", async () => {
    const manifest = parseReleaseManifest((await manifestBytes()).toString("utf8"))!;
    await expect(
      signReleaseManifestArtifacts("sk", (await manifestBytes()).toString("utf8"), manifest, {
        run: async () => ({ code: 2, out: "", err: "could not read key" }),
      }),
    ).rejects.toThrow(/tauri signer sign failed \(exit 2\): could not read key/);
  });
});

describe("signPublishedReleaseManifest", () => {
  it("answers unsigned-no-key when the environment holds no key (a local publish)", async () => {
    const res = await signPublishedReleaseManifest("/nonexistent", {} as ReleaseManifest, {});
    expect(res).toBe("unsigned-no-key");
  });

  it("signs the manifest AS PUBLISHED — reading the file back, not re-serializing", async () => {
    const dir = await mkTemp();
    const manifest = parseReleaseManifest((await manifestBytes()).toString("utf8"))!;
    await Bun.write(join(dir, "release-manifest.json"), await manifestBytes());
    const res = await signPublishedReleaseManifest(
      dir,
      manifest,
      { TAURI_SIGNING_PRIVATE_KEY: "sk" },
      {
        run: async (argv) => {
          // The file the signer received is byte-identical to what was written.
          expect(await Bun.file(argv.at(-1)!).text()).toBe(await Bun.file(join(FIX, "release-manifest.json")).text());
          await Bun.write(`${argv.at(-1)}.sig`, "ARMOR");
          return { code: 0, out: "", err: "" };
        },
      },
    );
    expect(res).toBe("signed");
    expect(await Bun.file(join(dir, "release-manifest.json.sig")).text()).toBe("ARMOR");
  });
});

describe("RELEASE_PUBKEY", () => {
  it("is a real publisher armor string, never a placeholder", () => {
    expect(RELEASE_PUBKEY.length).toBeGreaterThan(40);
    expect(RELEASE_PUBKEY.startsWith("REPLACE_ME")).toBe(false);
  });
});

async function mkTemp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sig-test-"));
}
