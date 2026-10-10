# The plane must hand out the newest node build it can talk to

Date: 2026-10-09. Operator ruling, same day: "if I update the server to the latest
version and run the one-liner on another machine, I should get the latest client
version the server supports."

## The incident (measured)

`subshell.ein.disaresta.com` was updated to a protocol-15 server. A machine ran
the rendered `install.sh`; the probe announced "checksum matches" and skipped the
download, enroll answered 200, the systemd unit started, and the agent has since
redialed in a `4410 handshake refused: protocol mismatch (node 14, server 15)`
loop, forever. The node row exists, the page says "no live connection", and the
installer never once told anyone why.

Two causes stacked:

1. The shelf. `GET /api/downloads/node/:target` (and its `.sha256`) answer
   disk-first with the stated doctrine "on disk wins, always ... nothing here
   second-guesses it". The server update replaced the SERVER binary only; the
   `node-artifacts/` directory kept a hand-copied `1.4.2` build (a version that
   was never published; byte-identical to the box's own local build, hence the
   checksum-match skip), and the server kept handing it out with a true digest.
2. The guards all sit on the FETCH path, never on the shelf.
   `compatibleNodeRelease()` exists precisely to stop a plane offering an agent
   it cannot talk to (its docblock names this exact disease: "that node enrolls,
   reconnects, and is closed ... forever"), and it was written for releases, not
   for disk. The 2026-09-21 incident fixed the same shape for the UPDATE route
   ("the disk file is a cache here: served when it IS the release"); the enroll
   path stayed unconditional.

## The rule

For the cookie/setup-key paths of both download routes (binary and `.sha256`),
when a release source is configured, the shelf stops being an oracle and becomes
a claimant. A new shared resolver decides ONCE what the instance would serve for
a target, and both routes answer from that one decision so they can never
disagree (their existing "404 identically" discipline extends to "digest-match
identically", which is what `install.sh`'s checksum-skip now depends on):

- The digest the instance ANNOUNCES for the shelf copy (its bytes, or an
  honest sidecar's, the very number the installer's skip compares) equals the
  compatible release's signed digest → serve disk (fast path; no network
  beyond the TTL-cached index/manifest). A sidecar lying about its bytes
  loses precedence: the release is served instead of being skipped past.
- Release exists and is NOT older than the shelf's own reported semver → serve
  the release: stream it; REPLACE the disk file when `.fetched.json` says this
  instance wrote those exact bytes, stream PAST it (never overwrite) when the
  shelf is operator bytes.
- Shelf reports a NEWER semver than the release, and its protocol matches the
  server → serve disk (the hand-publish/dev loop survives: `release:cli-node`
  from a checkout still wins while it speaks the server's protocol).
- Shelf reports a protocol that is NOT the server's → it is never served while a
  compatible release exists (the disaresta case), and when none exists the
  request 404s with a message that names the shelf's version, the protocol
  mismatch, and the release-side reason. Today's behavior in that cell was to
  hand the machine an agent its own server then refuses forever; that is the bug.
- Shelf version UNKNOWN (exec failed, timeout, unparseable line) → serve disk
  when no compatible release exists; the release wins when one does (unknown is
  not a claim of newness). A warn line logs the unknown; `subshell-server
  status` shows it per target.
- Air-gapped (`SUBSHELL_RELEASE_URL` empty) → disk always wins, as today: the
  shelf is the only source. `status` still reports what the shelf claims and
  what the server speaks, so the operator sees a dead shelf before a fleet hits
  it.

The shelf's identity is read by running the file: `<shelf> version` via
`runBounded` (the shared spawn-core bounds: allowlisted env, capped output,
short timeout), parsing the agent's own line `subshell X.Y.Z (node protocol
vN)` (cli.ts). This is the same discipline the server's self-update applies to a
downloaded binary before trusting its answer. Results memoize per file
path+mtime+size, same cache shape as `artifactSha`, with a test reset.

The update-token path is untouched: it is already release-coherent by the
2026-09-21 rule.

## Why not the alternatives

- Digest-vs-release only: overrides every hand-published or private-mirror
  build, which the docs protect as operator truth. The version comparison is
  what keeps the hand-publish story alive while killing the stale-shelf trap.
- Deploy hygiene only: server-update cannot clean what it did not fetch
  (publishArtifacts is a swapper, not the directory's owner), and hand-copied
  files would still 4410-loop new machines in silence.

## Surfaces changed

`lib/node-artifact-serve.ts` (new: shelf facts + the resolver), both download
routes (they consult it; and with no compatible release there is no fallback
fetch to fail — the resolver already chose disk in that cell, announcement and
bytes the same file), one exported ledger read in `services/releases.ts` (is
this disk file the one we fetched?) plus a one-minute backoff on failed index
reads (the decision now consults the source per request, so a no-egress plane
must not pay the metadata timeout per install), `commands/status.ts` (shelf
claims per target), the doctrine sentences in `docs/security.md`,
`.claude/rules/security-context.md`, `apps/server/api/AGENTS.md` and
`apps/server/api/docs/node-artifacts.md`, the 404 advisory in
`install-script.ts`, this spec, a patch changeset. `release-and-ci.md`'s
publish-dance text stays true untouched. Tests pin every cell of the rule with
fake release servers and planted shelf scripts, the existing `releaseSeams`
armor, including the sidecar-truth cell (the decision measures the ANNOUNCED
digest, because that is what a skip compares against) and the fetch-failure
cell (a release decision never falls back to shelf bytes under a release
announcement).
