# release-signature fixtures

Pins the `release-signature.ts` verifier against REAL `tauri signer` output —
the exact armor format the publisher key produces. If a future `tauri signer`
changes its armor or hashing, `release-signature.test.ts` fails HERE rather
than every installed binary silently losing update ability at its next check
(spec 2026-09-17 §5).

| file | what it is |
|---|---|
| `release-manifest.json` | fixture `release-manifest.json` bytes (component `node`, version `9.9.9`) — exactly what `writeReleaseManifest` emits |
| `release-manifest.sig` | its `release-manifest.json.sig` — produced by `bunx @tauri-apps/cli` 2.11.4 `signer sign` |
| `publisher-pubkey.txt` | the fixture key's `*.pub` (armor, as committed in `tauri.conf.json`) |
| `other-pubkey.txt` | a SECOND throwaway key's pubkey — the wrong-key-ID test |

**The private keys are NOT in this repository and never were.** The fixture
key exists only to pin the FORMAT; the publisher key never enters a test
fixture (its interop moment is `scripts/cli-e2e/published-release.sh` after a
real signed cut).

Regenerate (never with the publisher key):

```bash
G=$(mktemp -d)
bunx @tauri-apps/cli signer generate -w "$G/publisher.key" -p fixturepass --ci
bunx @tauri-apps/cli signer generate -w "$G/other.key" -p fixturepass --ci
# write the manifest bytes exactly as writeReleaseManifest does, then:
bunx @tauri-apps/cli signer sign release-manifest.json -f "$G/publisher.key" -p fixturepass
# copy manifest + .sig + both *.pub into this directory (names as above)
```
