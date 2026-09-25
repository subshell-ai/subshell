# Node artifacts: the download routes, the lazy release fetch, and release integrity. Moved verbatim from `apps/server/api/AGENTS.md` ("Architecture"); AGENTS.md keeps the summary and routes here.

The Nodes plane adds two files outside the DB: `GET /api/downloads/node/*`
(`src/api/downloads.route.ts`) serves the prebuilt `subshell` binaries
(published as `subshell-node-cli-<triple>` + `.sha256`) from `NODE_ARTIFACTS_DIR`
(`SUBSHELL_NODE_ARTIFACTS_DIR`, default
`<SUBSHELL_SERVER_DATA_DIR>/node-artifacts`; populated by `bun run release:cli-node`,
see root `AGENTS.md`), gated cookie-or-unconsumed-setup-key-or-a-still-valid
one-time `?update_token=` (minted inside a node's signed `update` command;
see the release-coherent rule below), never anonymous.
A binary-only server install ships that dir EMPTY. That used to mean the
install one-liner 404ed until someone published; since 2026-09-12 the server
FETCHES a missing binary from the project's own `cli-node-v*` GitHub release the
first time a machine asks for it (`services/releases.ts`). Lazily, on the
download route's 404 branch: no warm-up, no admin button, no poll, so a plane
whose nodes are all one platform never spends a byte on the others. The bytes
stream THROUGH while being hashed against the digest from the release's
SIGNED manifest `assets` map; the manifest and its signature are
verified before the first binary byte, and the `.sha256` sidecar is never
fetched on this path; a mismatch errors the response mid-flight, so
nothing unverified is cached and the node's own digest check before
`chmod +x` still decides.
`SUBSHELL_RELEASE_URL` configures it and EMPTY disables it (the
air-gapped configuration, and the default under `IS_TEST` so no suite reaches
the network by accident). (It was `SUBSHELL_NODE_RELEASE_URL` until spec
2026-09-15 §3.3; the same list now answers for the server's own `update` too,
so the name stopped being the node CLI's. No alias; there is no installed
base to keep compatible.) **The release a node is offered is the newest one
whose SIGNED `release-manifest.json` says it speaks THIS server's
`NODE_PROTOCOL_VERSION`** (`compatibleNodeRelease`), not merely the newest
above `MIN_NODE_VERSION`: the
old rule could install a node this plane cannot talk to, which enrolls,
reconnects and is closed 4406 forever. A release carrying no manifest, which is every
cut before 2026-09-15, is refused BY NAME rather than guessed at, and since
spec 2026-09-17 so is an UNSIGNED or unverifiable one (every cut before
2026-09-17): `release-manifest.json.sig` must minisign-verify against
`RELEASE_PUBKEY`, and the digest an install is told comes from the signed
`assets` map, never from the release source's `.sha256` sidecar (the sidecars
stay published for `install.sh` alone). `services/releases.ts`'s
`checkReleaseManifest`/`signedAssetDigest` are that one gate, shared by the
lazy fetch, `fetchDigest` (so the `update` command's digest), the server's own
`update`, and the Updates page; the three-way refusal grammar
("no manifest" / "unsigned" / "failed verification") is what lets the page
tell those stories apart. A file on disk always wins over a fetch **for the
installer path** (cookie or setup key), and only
what this instance fetched (recorded in `<node-artifacts>/.fetched.json` with
its release tag) is ever superseded when a newer tag appears; a hand-published
binary has no entry and is never touched. Superseded platforms are DELETED
rather than refreshed: the file comes back when a machine of that platform next
enrolls, which is the same laziness the rest of the path keeps.

**A download carrying a valid `update` token is served RELEASE-COHERENTLY
instead** (2026-09-21, the live-incident follow-up). The token binds the digest
the update command named from the signed manifest, so the disk file is served
only when it hashes to it, and anything else is fetched around: an absent disk
file is cached exactly as the installer lazy fetch always did, while a
present-but-different file is streamed through and never overwritten (the
hand-published-binary rule holds). A plane that cannot fetch refuses a token
download whose disk copy is stale with a 409 naming the remedy, and the
narrowed guard in `update-node.route.ts` is that case's backstop at the update
route itself.

Three surfaces still report what is on disk, so the air-gapped case is visible
instead of being discovered: the published set (`lib/node-artifacts.ts:publishedNodeTargets`,
the same regular-non-empty-file rule the download routes 404 on) rides
`GET /api/settings/public → nodeArtifactTargets` for the dialog (beside
`nodeArtifactsAutoFetch`, which is what tells the dialog whether an absent
binary is a problem or a cache miss), prints as
`node artifacts = N/4 published` in `subshell-server status`, and the
rendered `install.sh` downloads to a temp path, inspects the HTTP code
(404 → publish guidance naming the GitHub Release asset; 401 → mint a fresh
key; network → says so), verifies the digest BEFORE the temp file may
`mv`-replace `$DEST`, and can therefore never clobber an installed node on
a failed download;
and `services/nodes/control-keys.ts` holds the command-signing keypair at
`<SUBSHELL_SERVER_DATA_DIR>/node-signing.json` (0600); whoever holds it commands
every enrolled node.
