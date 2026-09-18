/**
 * The publisher signature on a release manifest (spec 2026-09-17).
 *
 * **The rule this module enforces** (§4): bytes are installable iff they hash
 * to the digest the signed manifest names for the exact published filename,
 * and the manifest's minisign signature verifies against the compiled-in
 * publisher pubkey (`RELEASE_PUBKEY`) whose payload says which component and
 * version it is. The `.sha256` sidecars stay published — `install.sh` and
 * pre-change consumers still read them — but they are no longer a trust
 * anchor: nothing here consults one.
 *
 * Two halves, and they deliberately have different implementations:
 *
 * - **{@link verifyReleaseManifest} is pure TypeScript over `node:crypto`.**
 *   It runs inside the compiled agent and server binaries, where the only
 *   runtime is Bun's — no CLI to shell to, and a verifier we control is what
 *   the fail-closed promises below can actually mean.
 * - **{@link signReleaseManifestArtifacts} shells to `tauri signer sign`.**
 *   Same tool, same key, same behavior as the desktop `.app.tar.gz.sig`
 *   creation that already ships; hand-rolled Ed25519/minisign armor on the
 *   SIGN side is exactly how publisher keys come to be mis-verified (§5).
 *   The signing half therefore only ever runs from a checkout (the release
 *   pipelines), never from an installed binary.
 *
 * ## The armor, as `tauri signer` 2.11.4 actually writes it (measured)
 *
 * Detached minisign, four lines: an untrusted comment (parsed leniently,
 * ignored — it is attacker-chosen text), `base64(alg(2) ‖ keyId(8) ‖
 * sig(64))`, a `trusted comment: ` line, and `base64(globalSig(64))`. Tauri's
 * `.sig` FILE wraps those four lines in one more base64 layer; the stock
 * `minisign` tool does not — {@link unwrapArmor} accepts both, and the
 * checked-in fixture trio pins whichever one the repo's CLI emits.
 *
 * The spec (§5) said the signature is Ed25519 "over the file bytes". What it
 * is, measured against the real tool, is the minisign **pre-hashed** scheme
 * (`alg = "ED"`): Ed25519 over `BLAKE2b-512(file bytes)` — which is why a
 * fixture produced by the real CLI, not prose, decides this format, and why
 * the legacy `alg = "Ed"` (raw bytes) is REFUSED here: `minisign-verify`
 * (what every installed desktop app uses) rejects legacy signatures unless a
 * caller opts in, and this verifier refuses to be the weaker of the two.
 * The global signature's preimage is `sig(64) ‖ trustedComment[17..]` (the
 * comment with its 17-character `trusted comment: ` prefix, no trailing
 * newline) — the same bytes `minisign-verify` reconstructs, so a signature
 * this module accepts is a signature a stock tool accepts.
 *
 * ## Fail-closed on every shape anomaly
 *
 * Bad armor, wrong lengths, unsupported alg, foreign key ID, failed
 * signature, unparseable manifest, and a component/version the manifest does
 * not name — each returns `{ ok: false, reason }` with a human-readable
 * sentence. NOTHING here throws at a call site: "this release is not
 * installable" is an answer every caller already renders, not an error.
 *
 * ## Metro discipline
 *
 * This module imports `node:crypto`, so it is a SUBPATH export
 * (`@internal/subshell-protocol/release-signature`), exactly like
 * `release-artifacts`: it must NOT join `src/index.ts`, or the mobile bundle
 * breaks and nothing local says so (`.claude/rules/verification.md`).
 */

import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  type ReleaseComponent,
  type ReleaseManifest,
} from "./releases.js";

/**
 * The SPKI DER prefix that turns a raw 32-byte Ed25519 public key into a key
 * `node:crypto` will load: `SEQUENCE { SEQUENCE { OID Ed25519 }, BIT STRING
 * (32 bytes) }`. The decided primitive (spec §5) — WebCrypto's Ed25519 is
 * runtime-version-gated, and every consumer of this verifier is a Bun server
 * runtime where `node:crypto` is unconditional.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Standard base64, strictly: Bun's decoder tolerates junk, this one must not. */
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/;

/** minisign's legacy (raw-message) alg marker. Accepted in a PUBLIC key, refused in a SIGNATURE. */
const ALG_LEGACY = "Ed";
/** minisign's pre-hashed alg marker: Ed25519 over BLAKE2b-512(message). */
const ALG_PREHASHED = "ED";

const _UNTRUSTED_PREFIX = "untrusted comment: ";
const TRUSTED_PREFIX = "trusted comment: ";

/** A successful verification: the manifest parsed FROM the verified bytes. */
export interface VerifiedReleaseManifest {
  readonly ok: true;
  /** Parsed after verification, from the same buffer that was verified (canonical-bytes rule, §3). */
  readonly manifest: ReleaseManifest;
}

/** A refused release, with one sentence for whoever is rendering it. */
export interface UnverifiedReleaseManifest {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Verify a release manifest's detached minisign signature.
 *
 * The ORDER is the contract: parse the armor, check the key ID, verify the
 * signature over the RAW manifest bytes, verify the format's own global
 * cross-check, and only THEN parse the manifest and assert its
 * component/version against what the caller was asked to install. Verifying
 * a canonicalized re-serialization instead of the bytes themselves would let
 * whitespace carry the bytes past a signature that never covered them — so
 * `manifestBytes` must be the exact published bytes, and the parse happens
 * after verification, never before (§3).
 *
 * @param manifestBytes - the exact published `release-manifest.json` bytes
 * @param sigText - the armor: `release-manifest.json.sig`'s text, raw or
 *   base64-wrapped (both are in the wild; Tauri's own `.sig` files are the
 *   latter)
 * @param pubkeyBase64 - the publisher's armor (`RELEASE_PUBKEY` in production)
 * @param expected - the component and version the CALLER is being told to
 *   install; the payload must name exactly these. A `node` release's
 *   signature can therefore never validate as a `server` release's: replay
 *   requires the payload to match, and the payload says what it is.
 */
export async function verifyReleaseManifest(
  manifestBytes: Uint8Array | string,
  sigText: string,
  pubkeyBase64: string,
  expected: { component: ReleaseComponent; version: string },
): Promise<VerifiedReleaseManifest | UnverifiedReleaseManifest> {
  try {
    return verifyInner(manifestBytes, sigText, pubkeyBase64, expected);
  } catch (error) {
    // The promise is "never a throw at call sites" — a crypto failure nobody
    // anticipated still lands as a refusal, named.
    return {
      ok: false,
      reason: `signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function verifyInner(
  manifestBytes: Uint8Array | string,
  sigText: string,
  pubkeyBase64: string,
  expected: { component: ReleaseComponent; version: string },
): VerifiedReleaseManifest | UnverifiedReleaseManifest {
  const refuse = (reason: string): UnverifiedReleaseManifest => ({ ok: false, reason });
  const bytes = typeof manifestBytes === "string" ? Buffer.from(manifestBytes, "utf8") : Buffer.from(manifestBytes);

  // 0. A build with no publisher identity verifies NOTHING. The desktop
  //    pipeline's `REPLACE_ME_` refusal in constant form (§5).
  const pubkey = pubkeyBase64.trim();
  if (pubkey === "" || pubkey.startsWith("REPLACE_ME")) {
    return refuse("this build ships no publisher pubkey, so no release can be verified against it");
  }
  if (sigText.trim() === "") {
    return refuse("the release carries no publisher signature");
  }

  // 1. Armor shape, both spellings (raw four-line armor; Tauri's base64 of it).
  const lines = unwrapArmor(sigText)
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length < 4) return refuse("the signature is not minisign armor");
  const blob = decodeStrict(lines[1] as string);
  if (blob === null || blob.length !== 74) return refuse("the signature's encoding is malformed");
  const trustedLine = lines[2] as string;
  if (!trustedLine.startsWith(TRUSTED_PREFIX)) return refuse("the signature is not minisign armor");
  const globalSig = decodeStrict(lines[3] as string);
  if (globalSig === null || globalSig.length !== 64) return refuse("the signature's encoding is malformed");

  const alg = blob.subarray(0, 2).toString("latin1");
  if (alg === ALG_LEGACY) {
    // Legacy means the signature covers the raw bytes with no hash. Refused
    // rather than honoured: minisign-verify (the desktop apps' verifier)
    // rejects these by default, and the two verifiers must not disagree about
    // what is installable.
    return refuse("the signature uses the legacy minisign format; only pre-hashed signatures are accepted");
  }
  if (alg !== ALG_PREHASHED) return refuse("the signature uses an unsupported algorithm");
  const keyId = blob.subarray(2, 10);
  const sig = blob.subarray(10);

  // 2. The publisher pubkey: same armor question (comment line + b64, or a
  //    bare b64 line), then alg ∈ {Ed, ED}, key ID, and the raw 32 bytes.
  const pubLines = unwrapArmor(pubkey)
    .split("\n")
    .filter((line) => line.length > 0);
  const pubBlob = decodeStrict(pubLines.at(-1) ?? "");
  if (pubBlob === null || pubBlob.length !== 42) return refuse("the publisher public key is malformed");
  const pubAlg = pubBlob.subarray(0, 2).toString("latin1");
  if (pubAlg !== ALG_LEGACY && pubAlg !== ALG_PREHASHED) return refuse("the publisher public key is malformed");
  if (!pubBlob.subarray(2, 10).equals(keyId)) {
    return refuse("the signature was made by a different key than this build's publisher pubkey");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubBlob.subarray(10)]),
    format: "der",
    type: "spki",
  });

  // 3. The file signature: Ed25519 over BLAKE2b-512 of the EXACT bytes.
  if (!ed25519Verify(null, blake2b512(bytes), key, sig)) {
    return refuse("the publisher signature does not cover these manifest bytes");
  }
  // 4. The format's own cross-check, same key: sig ‖ trusted comment (the
  //    line minus its 17-character prefix, no trailing newline).
  if (
    !ed25519Verify(null, Buffer.concat([sig, Buffer.from(trustedLine.slice(TRUSTED_PREFIX.length))]), key, globalSig)
  ) {
    return refuse("the signature's global check failed");
  }

  // 5. Only now: parse the verified buffer, and bind the payload's claims.
  const manifest = parseReleaseManifest(bytes.toString("utf8"));
  if (manifest === null) return refuse("the signed bytes are not a release manifest");
  if (manifest.component !== expected.component) {
    return refuse(
      `the signed manifest names component "${manifest.component}", not the "${expected.component}" release being installed`,
    );
  }
  if (manifest.version !== expected.version) {
    return refuse(`the signed manifest names version ${manifest.version}, not ${expected.version}`);
  }
  return { ok: true, manifest };
}

/**
 * Sign `manifestBytes` with the publisher key and return the armor.
 *
 * Shells to `tauri signer sign` (the repo's own CLI, the same invocation the
 * desktop shards run, the key arriving the same way — through
 * `TAURI_SIGNING_PRIVATE_KEY`, never argv, so a private key cannot appear in
 * `ps` output). NOT re-implemented in TS: whatever this returns, the stock
 * tools verify, because the stock tools made it.
 *
 * @param minisignSk - the private key's CONTENTS (the CI secret's shape, not
 *   a path)
 * @param manifestBytes - the exact published `release-manifest.json` bytes
 * @param manifest - what the caller believes those bytes are; they must parse
 *   to it (component + version), so a pipeline can never sign a payload that
 *   contradicts the release it is naming
 * @param deps - CLI argv + spawn seams (tests run nothing; the desktop
 *   precedent resolves the CLI from the workspace)
 * @throws when no key is given, the bytes do not match `manifest`, or the
 *   signer fails — a refusal at release time is the whole point, nothing
 *   unsigned must ever be published by a shard that had the key
 */
export async function signReleaseManifestArtifacts(
  minisignSk: string,
  manifestBytes: string | Uint8Array,
  manifest: ReleaseManifest,
  deps: {
    /** argv prefix for the tauri CLI (default: the workspace's `bunx @tauri-apps/cli`). */
    tauriCli?: string[];
    /** The key's passphrase, passed through `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. */
    password?: string;
    /** Spawn seam. Resolves with the exit code and captured streams. */
    run?: (argv: string[], env: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;
  } = {},
): Promise<string> {
  if (minisignSk.trim() === "") throw new Error("signReleaseManifestArtifacts: no private key given");
  const text = typeof manifestBytes === "string" ? manifestBytes : Buffer.from(manifestBytes).toString("utf8");
  const parsed = parseReleaseManifest(text);
  if (parsed === null) {
    throw new Error("signReleaseManifestArtifacts: the bytes to sign are not a valid release manifest");
  }
  if (parsed.component !== manifest.component || parsed.version !== manifest.version) {
    throw new Error(
      `signReleaseManifestArtifacts: the bytes name ${parsed.component} ${parsed.version}, not ${manifest.component} ${manifest.version}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "subshell-sign-"));
  try {
    const path = join(dir, RELEASE_MANIFEST_NAME);
    await writeFile(path, text);
    const cli = deps.tauriCli ?? ["bunx", "@tauri-apps/cli"];
    const run = deps.run ?? defaultRun;
    const res = await run([...cli, "signer", "sign", path], {
      TAURI_SIGNING_PRIVATE_KEY: minisignSk,
      // SET-BUT-EMPTY is what the CLI accepts for a passphrase-less key;
      // UNSET makes it prompt on a terminal it does not have (release.yml
      // comment, measured 2026-09-15) — so the empty string is deliberate.
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: deps.password ?? "",
    });
    if (res.code !== 0) {
      throw new Error(`signReleaseManifestArtifacts: tauri signer sign failed (exit ${res.code}): ${res.err.trim()}`);
    }
    return await Bun.file(`${path}.sig`).text();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Sign the manifest ALREADY published into `destDir`, writing the armor
 * beside it as {@link RELEASE_MANIFEST_SIG_NAME} (spec 2026-09-17 §7).
 *
 * Reads the manifest back from disk rather than re-serializing it: the
 * signature must cover the EXACT published bytes, and the one writer of those
 * bytes is `writeReleaseManifest`.
 *
 * The key arrives through `TAURI_SIGNING_PRIVATE_KEY` (the desktop shards'
 * secret, reused per D1). Absent key ⇒ `"unsigned-no-key"` and NOTHING is
 * written: a local `release:node` publish-to-your-own-instance stays legal
 * unsigned — those artifacts are served by digest through the authenticated
 * downloads route — while an operator sees on the pipeline's own output that
 * the release will not be offered for update by any plane. The CI shards
 * refuse the key-less case before ever reaching this function; a shard with
 * the key never lands here unsigned.
 *
 * @returns which half of the deal happened, so the pipeline can print it
 * @throws when the key is present but the signer fails — a failed signature
 *   must fail the shard, never publish an unsigned manifest from a pipeline
 *   that had the key
 */
export async function signPublishedReleaseManifest(
  destDir: string,
  manifest: ReleaseManifest,
  env: Record<string, string | undefined> = process.env,
  deps: {
    tauriCli?: string[];
    run?: (argv: string[], env: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;
  } = {},
): Promise<"signed" | "unsigned-no-key"> {
  const sk = (env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
  if (sk === "") return "unsigned-no-key";
  const bytes = await Bun.file(join(destDir, RELEASE_MANIFEST_NAME)).text();
  const sig = await signReleaseManifestArtifacts(sk, bytes, manifest, {
    password: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    tauriCli: deps.tauriCli,
    run: deps.run,
  });
  await writeFile(join(destDir, RELEASE_MANIFEST_SIG_NAME), sig);
  return "signed";
}

/** Default spawn: inherited env plus the two signer vars; streams captured. */
async function defaultRun(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, out, err };
}

/**
 * Accept both armor spellings: the raw four-line block the stock `minisign`
 * tool writes, and the single base64 line the tauri CLI's `.sig` FILE wraps
 * around it. The pubkey armor (`RELEASE_PUBKEY`, the `tauri.conf.json` value)
 * is the wrapped shape too.
 */
function unwrapArmor(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes("\n")) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("comment: ")) return decoded;
  } catch {
    /* not base64 — fall through and let the caller's shape check refuse it */
  }
  return trimmed;
}

/** Strict base64 → bytes, or null. Bun's `Buffer.from` tolerates junk; this gate does not. */
function decodeStrict(line: string): Buffer | null {
  const value = line.trim();
  if (value === "" || !BASE64_STRICT.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, "base64");
}

/** BLAKE2b-512 — minisign's pre-hash. Available in both Node and Bun's `node:crypto`. */
function blake2b512(data: Buffer): Buffer {
  return createHash("blake2b512").update(data).digest();
}
