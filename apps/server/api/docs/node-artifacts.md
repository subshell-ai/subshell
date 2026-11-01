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
first time a machine asks for it (`modules/updates/releases.ts`). Binary bytes are
still lazy in the sense that mattered: served on request, no admin button, no
poll, no boot-time sweep, so a plane whose nodes are all one platform never
spends a byte on the others. One act fetches ahead of a request: since
2026-10-31 `POST /api/nodes/:id/update` fetches the bytes IT is about to
authorize a download of before the command goes out, because a whole fleet
pressing that button at once used to have every machine's download stall on
the plane's own cold first fetch, and on the serve-past arm pay for it again
node by node. That is the fan-out incident the same section of this doc
records from below. That fetch is bounded by the same deadline the node's own
download gets, and it is VISIBLE: the update tracker opens the row's entry as
`preparing` before the fetch starts (never deriving `stalled`, which would
blame the machine for the plane's wait), ends it `failed` with the refusal's
sentence if the fetch or a late gate refuses, and flips it to `working` the
moment the command goes out, when the stall clock starts counting node
silence. One hand-back rule sits under all of that: a press that replaces a
STILL-LIVE order (the row went `stalled` and its button came back, or a
second tab pressed) and then refuses before dispatching does not get to
terminalize that order: the node from the first press may still boot onto
the new version, and a terminal entry drops its `ready`. The refusal belongs
to its own tab's 409; the tracker hands the interrupted order's entry back.
Since 2026-10-09 the tiny index/manifest reads behind the serve decision run
on EVERY authenticated download request (TTL-cached; a failed read is backed
off a minute), not just on the branch that ends in a fetch. The bytes are
downloaded IN FULL and hashed against the digest from the release's
SIGNED manifest `assets` map before anything is served; the manifest and its
signature are verified before the first binary byte, and the `.sha256` sidecar
is never fetched on this path. A mismatch never reaches a response at all: the
fetch itself fails, the partial temp is deleted, and nothing unverified is
cached (since the 2026-10-23 fan-out fix; the streaming-through shape shared
one dead stream with every concurrent caller). The node's own digest check
before `chmod +x` still decides.
`SUBSHELL_RELEASE_URL` configures it and EMPTY disables it (the
air-gapped configuration, and the default under `IS_TEST` so no suite reaches
the network by accident). (It was `SUBSHELL_NODE_RELEASE_URL` until spec
2026-09-15 §3.3; the same list now answers for the server's own `update` too,
so the name stopped being the node CLI's. No alias; there is no installed
base to keep compatible.) **The release a node is offered is the newest one
whose SIGNED `release-manifest.json` says it speaks THIS server's
`NODE_PROTOCOL_VERSION`** (`compatibleNodeRelease`), not merely the newest
above `MIN_NODE_VERSION`: the
old rule could install a node this plane cannot talk to. Since spec 2026-10-13
such an agent (a pinned row, dials through the handshake binding) enrolls and is
HELD: the link stands and it answers nothing but the frozen `update`, and the
4406 arrives at the idle close, terminal for the daemon, which the service
manager brings back to redial into the hold again. A release carrying no manifest, which is every
cut before 2026-09-15, is refused BY NAME rather than guessed at, and since
spec 2026-09-17 so is an UNSIGNED or unverifiable one (every cut before
2026-09-17): `release-manifest.json.sig` must minisign-verify against
`RELEASE_PUBKEY`, and the digest an install is told comes from the signed
`assets` map, never from the release source's `.sha256` sidecar (the sidecars
stay published for `install.sh` alone). `modules/updates/releases.ts`'s
`checkReleaseManifest`/`signedAssetDigest` are that one gate, shared by the
lazy fetch, `fetchDigest` (so the `update` command's digest), the server's own
`update`, and the Updates page; the three-way refusal grammar
("no manifest" / "unsigned" / "failed verification") is what lets the page
tell those stories apart. On the installer path (cookie or setup key) the
disk copy wins only while it can answer for itself as the newest build this
server can talk to (the serve-time rule of spec 2026-10-09,
`resolveNodeServe` above). Only
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
present-but-different file is served from a temp copy and never overwritten
(the hand-published-binary rule holds; the shared temp goes when the last
reader finishes and its brief hold window expires; see the serve-past lease
below).
A download killed outright strands its uniquely-named temp, because no
in-process path cleans what a SIGKILL interrupted, so each download sweeps
strays older than an hour first; the age bound is what makes that safe beside
a concurrent fetch's live copy, whose mtime stays fresh while it is written.
Since the 2026-10-23 fan-out fix the fetch lands COMPLETE and verified on disk
before the route hands anything out: the release-vs-token digest comparison
therefore runs with no byte served, a mismatch answers 409, and an
update that ordered a release the source has moved past learns it before its
download rather than after it. When the disk had nothing, the fetched release
stays cached: it is what the next installer gets, and the retry fast-paths
onto it. A plane that cannot fetch refuses a token
download whose disk copy is stale with a 409 naming the remedy, and the
narrowed guard in `update-node.route.ts` is that case's backstop at the update
route itself. The coalescer shares the settled download, not a stream:
concurrent same-target fetches (an "Update all" fan-out) each open their own
read of it. The serve-past arm (`cache: false`, taken whenever the disk holds
a copy that is NOT the release) is coalesced too as of 2026-10-31: it had
never been, so an "Update all" against an operator-published shelf fired one
full release fetch PER node: N × ~80 MB racing the command deadline, most of
the batch's single-use tokens burning while the plane refetched what the
first download already proved it could reach, and the same node updated one
at a time always worked. That shape is the incident this paragraph's date
closes. Those fetches now share one verified temp copy (the serve-past lease
in `releases.ts`); each caller gets its own read, the file is held until the
last handle finishes plus a short window for downloads still in transit, and
the operator's shelf file is still never touched.

Three surfaces still report what is on disk, so the air-gapped case is visible
instead of being discovered: the published set (`modules/updates/node-artifacts.ts:publishedNodeTargets`,
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
and `modules/nodes/control-keys.ts` holds the command-signing keypair at
`<SUBSHELL_SERVER_DATA_DIR>/node-signing.json` (0600); whoever holds it commands
every enrolled node.
