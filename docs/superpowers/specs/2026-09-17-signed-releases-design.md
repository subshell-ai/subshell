# Signed releases: the CLI update paths stop trusting the release source

Date: 2026-09-17
Status: approved (operator: "we should make sure they are signed and that signature
is verified"; both structural calls confirmed by the same conversation)
Supersedes: the honesty line in `docs/security.md` §11.12 and the matching bullet in
`.claude/rules/security-context.md` — "authenticity is that host's TLS plus the
repository's access controls" — which describes the posture this change ends.

## 1. The problem, precisely

Every install of a binary in this system reduces to: fetch bytes from
`SUBSHELL_RELEASE_URL` (default: this repo's GitHub Releases), hash them, and
compare that hash against a `.sha256` **published beside the bytes, by the same
source**. Integrity is therefore "these are the bytes the release source served";
authenticity is that host's TLS plus the repository's write access. Four paths
share that chain:

1. **The node agent's update** (`subshell update` / the `update` command from the
   plane, `apps/node/agent/src/update.ts`) — downloads `subshell-node-cli-<triple>`
   plus the sidecar, verifies, swaps, re-execs.
2. **The server's own update** (`POST /api/admin/server/update` → the download
   service in `apps/server/api/src/services/`) — same shape, `subshell-server-cli-…`.
3. **The server's lazy agent-artifact fetch** (`GET /api/downloads/node/*`,
   spec 2026-09-12) — streams the bytes through while hashing against the
   release's `.sha256`, then serves them to nodes.
4. **The Updates page's `canUpdate` gate** (`admin-updates.route.ts` +
   `@internal/subshell-protocol/releases.ts`) — decides which releases the plane
   will offer, reading the same unsigned release list.

So a compromised `subshell-ai` org account, a malicious release maintainer, or a
broken `SUBSHELL_RELEASE_URL` mirror can push arbitrary code to every node whose
operator presses Update — and the plane that *orders* the update verifies nothing
the release source did not also produce. The desktop apps already sit outside
this problem (`tauri-plugin-updater` checks a minisign signature against a
pubkey compiled into the app), and the docs call that key "the publisher's
identity" (root `AGENTS.md`, "Updater signing"). This spec gives the CLI paths
the same guarantee, using that same identity.

## 2. The two decisions (operator's call, 2026-09-17)

**D1 — one keypair.** The CLI artifacts are signed by the *existing* desktop
updater minisign keypair (`~/.tauri/subshell-desktop.key`; pubkey already
committed as `plugins.updater.pubkey` in both `tauri.conf.json`s). That key is
already documented as the publisher's identity rather than an app's; a separate
CLI key would split that identity and double the backup ceremony for a benefit
(ceiling on blast radius) the design achieves instead by *scoping what the key
signs* (§3: version+target binding), not by holding a second key.

**D2 — one manifest signature.** The signature covers the release's
`release-manifest.json` (already shipped since 2026-09-15), extended with an
`assets` map: `{ "<published file>": "<sha256>" }`. One signature per release
covers the manifest's identity claims *and* every artifact digest, so per-asset
`.sig` files add nothing. The `.sha256` sidecars stay (they serve pre-change
consumers and `install.sh`), but they stop being a trust anchor: verification
always compares bytes to the **signed manifest's** digest, never to the sidecar.
The manifest is extended, not replaced: `parseReleaseManifest` returns null for a
manifest without a valid `assets` map, so pre-change releases (no `assets`, no
`.sig`) fall into the existing "unknown, not offered" rule (§4) rather than
trusting either half of a half-trust.

## 3. The format: a detached signature bound to what matters

Minisign, Ed25519, detached — the same format `tauri signer` already produces,
so CI's existing key works unchanged and the signature can be verified by stock
tools (`minisign -V -m release-manifest.json -x release-manifest.json.sig -P
<pubkey>`).

- Published beside each CLI release: `release-manifest.json.sig` (minisign's
  armored text format — comment line + base64 — so it is inspectable and
  tool-compatible; not raw 64-byte signatures).
- **The signed payload binds the claim** (corrected during build-out:
  `tauri signer sign` has no comment flag, and the binding it would have added
  is already inside the bytes — the manifest carries `component`, `version`,
  and the full `assets` map, and every verifier must assert
  `manifest.component === expected` and its version against what it was asked
  for. A `node` release's signature therefore can never validate as a `server`
  release's: replay requires the payload to match, and the payload says what it
  is). The untrusted comment inside the armor is parsed leniently and ignored;
  the pubkey's key ID pins the publisher.
- **Canonical bytes**: the signature covers `release-manifest.json`'s exact
  published bytes. Verifiers hash the bytes they verified — parse-then-verify
  on canonicalized JSON is forbidden; the parse happens *after* verification,
  from the same buffer.

## 4. The verification rule

One sentence, enforced at every one of the four paths:

> **Bytes are installable iff they hash to the digest the signed manifest names
> for the exact published filename, and the manifest's minisign signature
> verifies against the compiled-in publisher pubkey with a binding comment that
> matches the manifest itself.**

Consequences, each intended:

- **The release source alone can no longer push code.** An attacker with write
  access to the repo, or full MITM of `SUBSHELL_RELEASE_URL`, must also hold the
  minisign key. (The desktop apps have had this property since 2026-09-15; the
  CLI paths catch up.)
- **The control plane alone can no longer push code.** Today a plane holding the
  node signing keypair commands an update and its URL+digest go unchallenged.
  After this, the node still verifies the *publisher* signature on the manifest
  whose digest the command names; a rogue/compromised plane can withhold updates
  and offer ones the release source published, but cannot make a node accept a
  manifest the publisher did not sign. This splits the two keypairs' power:
  node-signing key ⇒ ordering, publisher key ⇒ payload. (A plane compromise
  remains total for everything the command channel already reaches — arbitrary
  commands, pane I/O — this narrows *update*, not the trust model wholesale;
  say so in docs rather than overclaiming.)
- **Unsigned releases become invisible.** `releases.ts`'s candidate selection
  (already: "a release without a manifest is treated as unknown and is not
  offered") extends to "…or without a signature that verifies." The Updates page
  Node/Server rows say so with the existing `endOnce(reason)` grammar; a fresh
  instance pointed at the current, wholly-unsigned release set shows *no
  available updates*, which is correct, and every release cut after this lands is
  signed.
- **Air-gap posture unchanged**: empty `SUBSHELL_RELEASE_URL` still refuses all
  four paths by name, before any crypto happens.
- `install.sh` stays digest-only, unchanged: its threat model is the
  already-authenticated `/api/downloads` route with a setup key, and its threat
  *source* is the compromised publisher — which cannot forge the artifact list
  the server will serve, because §5 makes the server refuse to fetch/caching an
  unsigned manifest's bytes in the first place. Path 3's fix IS install.sh's fix.
- `subshell update --from <path>` stays signature-free (local operator names the
  file) — same carve-out as the desktop reset's named paths.

## 5. Code shape

**New module, `@internal/subshell-protocol`:**

- `release-signature.ts` — exports:
  `signReleaseManifestArtifacts(minisignSk, manifestBytes, manifest): Promise<string>`
  (used by the release scripts, shells to `tauri signer sign` — same tool, same
  key env vars, same behavior as desktop `.deb.sig` creation; NOT re-implemented
  in TS: hand-rolled Ed25519/minisign armor is exactly how publisher keys come to
  be mis-verified), and
  `verifyReleaseManifest(manifestBytes, sigText, pubkeyBase64, expected: {component, version}):
  Promise<{ ok: true; manifest: ReleaseManifest } | { ok: false; reason: string }>`
  — pure TS: parse the armor, verify the signature over the raw manifest bytes,
  check the binding comment, then parse the manifest, then return it. Tauri's
  updater signs `Ed` (Ed25519) over the file bytes with a `global signature`
  over the same bytes; the verifier checks the signature, and the format's own
  global-sig cross-check comes for free from the same public key. **Fail-closed
  on every shape anomaly**: bad armor, wrong key ID, comment mismatch,
  unparseable manifest → `{ ok: false, reason }` with a human-readable reason,
  never a throw at call sites.
  - **Crypto primitive, decided, not deferred**: `node:crypto` ed25519
    (`createPublicKey` from the raw 32-byte key via an SPKI DER prefix +
    `crypto.verify(null, manifestBytes, key, sig)`), NOT WebCrypto — WebCrypto's
    Ed25519 support is runtime-version-gated and Bun's `crypto.subtle` parity
    with Node was not measured, while every consumer of this verifier (agent,
    server) is a Bun *server* runtime. Consequently `release-signature.ts` is a
    **subpath export** (`@internal/subshell-protocol/release-signature`), the
    same node-builtin discipline `release-artifacts` follows for Metro's sake —
    it must NOT join `src/index.ts`, or the mobile bundle breaks and nothing
    local says so (`.claude/rules/verification.md`, measured 2026-09-15).
  - **Pin the toolchain**: a checked-in fixture trio (manifest bytes +
    `tauri signer sign`-produced `.sig` + pubkey), signed by a **throwaway
    fixture key generated for the tests** — the fixture's job is to pin tauri's
    armor/format against our verifier, which any key does; the publisher key
    never enters a test fixture (its real interop moment is the
    `published-release.sh` smoke after the next real cut, §9, and CI already
    holds the secret). Tests: (a) our verifier accepts the fixture, (b) any byte
    flip rejects, (c) the armor/key-ID shapes reject as specified, (d) a sig
    made for component `node` fails verification when `expected.component` is
    `server` — the payload-binding claim, tested. If a future `tauri signer`
    changes armor or hashing, (a) fails in CI rather than every installed
    binary silently losing update ability at its next check.
- `ReleaseManifest` gains `assets: Record<string, string>` (published filename →
  lowercase-hex sha256); `parseReleaseManifest` requires the field and its shape;
  `writeReleaseManifest`'s callers pass the digests they already computed (both
  `release.ts` files already hash every artifact for the sidecars — the map is
  assembled from those existing values, not new digesting).
- The pubkey itself: one new constant `RELEASE_PUBKEY` in the protocol package,
  value = the existing `plugins.updater.pubkey` string (single source of truth
  becomes the protocol module; both `tauri.conf.json`s keep their copies because
  Tauri reads its config at bundle time — a test asserts the three spellings are
  identical, so a key rotation edits all three knowingly or fails).
  Empty/placeholder here ⇒ every verify call fails closed with "this build ships
  no publisher pubkey" — the desktop pipeline's `REPLACE_ME_` refusal, same spirit.

**Path 1 — `apps/node/agent`:** the update source shape gains
`manifest: { bytes, sig }` (or, for the plane-commanded path, the command
carries manifest+sig as command payload — see §6). Before the swap, after
download: `verifyReleaseManifest` → require `assets[the exact file fetched]` →
compare against the computed hash. Any failure: abort, `.previous` untouched,
result `ok:false` with the reason (the existing failure surface).

**Path 2 — server update service:** same call before its swap.

**Path 3 — `GET /api/downloads/node/*` lazy fetch:** the fetcher already
streams while hashing; on completion it now additionally fetches
`release-manifest.json` + `.sig` for the tag, verifies, and confirms its own
computed digest appears in the signed `assets` for the requested filename.
Mismatch/refusal ⇒ the response errors mid-flight and **nothing is cached**
(unchanged contract, stronger gate). `.fetched.json` records the manifest's
`commit` alongside its existing `tag` so the lazy-fetch audit trail says what was
verified.

**Path 4 — `releases.ts`/`admin-updates.route.ts` selection:** a release becomes
a candidate only when its manifest+sig fetched and verified successfully at
index-read time (the existing 15-min-TTL service fetches one extra asset per
candidate component — bounded, cached with the rest). The route's response types
gain nothing new; a release that fails verification is simply *not in the list*,
with today's "no node-v\* release" reason wording extended to name why
("…or its signature failed to verify" phrasing carried as `reason`, same grammar
the page already renders).

**Tests** (each where the module lives): fixture manifest+sig trios (valid,
tampered-bytes, tampered-digest, sig-for-other-component, comment-mismatch,
unsigned, garbage armor, wrong-key-ID); `assets` strictness in
`parseReleaseManifest`; the three-pubkey-spelling equality test; node/server
update-path tests for abort-on-failure; downloads-route test that an unsigned
manifest blocks caching; selection test that unsigned releases are unoffered.
Update `e2e/tests/17-server-updates.spec.ts` copy where strings change.

## 6. Wire format: what the plane sends a node

The node's `update` command today carries `{ url, sha256 }` (signed command
envelope). It gains `manifest` (base64 of the exact bytes) and `manifestSig`
(minisign armor text). The node verifies the manifest signature against
`RELEASE_PUBKEY` and requires `manifest.component === "node"`, its `version` to
equal the `to` the operator asked for, and the downloaded bytes' hash to equal
`assets[filename]`. The envelope's own signature (§ command signing) still gates
*who ordered it*; the publisher signature gates *what runs*. Both are checked;
neither implies the other, which is the point of D1's note in §4.

`NODE_PROTOCOL_VERSION` bumps to 12 (skipping 11 deliberately: the concurrent
zero-touch branch bumps 10→11 for its `ready` fields, and 12 keeps this bump
valid in either merge order — no build ever spoke 11 on main): the new command
payload is additive, but an
old agent would silently ignore `manifest`/`manifestSig` and accept payload-only
— which is exactly the silent-downgrade this change exists to close, so the
plane treats protocol <12 agents as update-incapable (they surface under the
existing held/below-floor grammar with `reason: "agent predates signed updates"`
rather than receiving an unsigned-command update). Bump `MIN_AGENT_VERSION`
in the same change so the floor and the protocol tell the same story once the
next node release publishes; until then held-node copy explains it.

## 7. CI (`.github/workflows/release.yml`)

- `build` shards: after writing manifest with `assets`, run the signing step:
  `tauri signer sign -f <manifest-path> -k "$TAURI_SIGNING_PRIVATE_KEY" [-p …] -x
  "<binding comment>"` (the desktop shards already prove the secret exists and
  the CLI works; desktop's own flow unchanged — this adds the same step to
  `server` and `node` shards). Missing `TAURI_SIGNING_PRIVATE_KEY` ⇒ shard fails
  (the desktop shards' existing refusal rule extended to the CLI shards; "a shard
  without the key publishes nothing").
- `publish` job's `files:` globs gain `release-manifest.json.sig` (per-app glob
  already sweeps `dist/$APP-*/*`; the sig lives beside its manifest — verify the
  glob catches it, the desktop `latest.json` precedent says it does).
  **Amended during build-out (the one real spec deviation):** the `assets` map
  made per-shard manifests *content-different* (each names only its own
  triple), so uploading three same-basename files would have let softprops'
  last-one-win silently publish a three-platform release whose signed manifest
  offers one — a release every other machine's nodes refuse. The publish job
  now MERGES the shard manifests (`scripts/merge-release-manifest.ts`: refuses
  disagreements, duplicate digests, missing expected triples, and a missing
  signing key), re-signs the merged bytes with the same publisher key, and
  DELETES the per-shard copies so the asset glob cannot collide; the merged
  pair is listed explicitly beside `latest.json`, same shape as that existing
  precedent. §4's verification rule is unchanged; only the manifest's
  production moved from shard to publish.
- `published-release.sh` post-cut smoke gains one check: download a release's
  manifest + sig and verify offline against `RELEASE_PUBKEY`.
- No new secrets, no key ceremony changes. The docs' loss warning
  ("every installed app can never auto-update again") grows to "…every installed
  component" in root AGENTS' Updater-signing section, `docs/security.md` §11.12
  (replacing the TLS sentence this spec supersedes), and the §5 note here.

## 8. Out of scope, on purpose

- Detached per-asset `.sig`s (D2). `cosign`/Sigstore/provenance attestations —
  heavier key infra for a publisher identity the repo already holds in minisign.
- Rotating or re-issuing the keypair.
- Trusting the sidecars: `.sha256` files stay published for compatibility but no
  code path treats them as verification.
- Mobile: no self-update path exists for `apps/client/mobile` (PWA/OTA untouched).
- The desktop apps' flow: unchanged except the pubkey single-source test.

## 9. Verification

`bun run verify-types` + `bun run lint:check` + `bun run test` +
`bunx turbo build` — the last one is not optional: `@internal/subshell-protocol`
changes and the mobile barrel trap is the failure this package is famous for
(§5: `release-signature` stays a subpath export precisely so Metro never sees
`node:crypto`). Then `bun run test:cli` — its two update scenarios
(`server-update.sh`, `node-update.sh`) rebuild patched-version binaries, so they
must gain a throwaway signing key + signed local manifests (the scenarios use
`--from <path>`, which is signature-free by §4 — confirm they genuinely exercise
only that path, and add one new scenario line that exercises a signed
manifest-fetch refusal). Finally, `published-release.sh` by hand after the next
real cut — first end-to-end proof against a live signed release.
