# Update: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Update (`src/update.ts`, `src/commands/update.ts`, spec 2026-09-15 §5)

This node can replace its own binary (from `subshell update` at the keyboard
or from a signed `update` command the plane sends), and both run one
`applyUpdate`, so the download, the verification and the marker have one
implementation rather than two that drift.

**Every install is a transaction the NEXT PROCESS completes.** The updater
cannot see the future boot; the booting node can see the past update. So
whoever swaps writes `<dataDir>/update-pending.json` and keeps the old file as
`<binary>.previous`, and the node that comes up settles it:

- **Accepted** → delete both. The node has no database, so there is nothing
  else to clean up.
- **Refused with 4406** → rename `.previous` back, write `update-failed.json`,
  exit 1. The service manager respawns the version that worked, on a machine
  nobody had to visit. That swap-back IS the node's whole rollback.

Without a marker, 4406 behaves exactly as it always did (log and exit): a plane
refusing a node nobody just updated is the ordinary "your node is too old"
case, and swapping files there would invent a rollback for an update that never
happened.

**A forced downgrade the plane will not accept is HELD, then reverted**: the
dashboard's force option (and `update --force`) can install a version the
plane's protocol or floor refuses, and the node then boots it, sits offline
for everything but `update` through the plane's ten-minute hold budget, and
takes the 4406 that ends the hold, which runs the revert above and has the
manager respawn the version that worked; the card states this beside the
checkbox because it cannot check the plane's floor from here.

**The rollback copy is made ATOMICALLY and PROBED before it goes back**
(round-3 review, finding 2). `<binary>.previous` is a BOOT target, so
`keepPrevious` hardlinks the running binary, and where links are refused the
copy goes temp + fsync + ONE rename; a truncated `.previous` can never land
as the rollback file (the old plain copy left exactly that shape on ENOSPC, and
the rename-back paths trusted it on a mere regular-file stat). And every path
that would rename it back onto the live path first runs `<previous> version`
and requires exit 0, the same ladder question every install asks, WITH the
server twin's bounds ported (`ROLLBACK_PROBE_TIMEOUT_MS` = 10 s, the server's
`spawnSync` `timeout: 10_000`; stdin ignored, stdout piped AND drained): a
`.previous` that never exits answers FALSE at the bound, because on the
automatic 4406 path an unbounded probe would hang the very `exit(1)` the
service manager is waiting to act on; a bounded refusal (record-and-keep)
beats a hang wherever termination is mandatory (round-3 review, finding 4).
The two
surfaces diverge on the refusal, deliberately: the OPERATOR's `update
--rollback` (and the dashboard rollback, which is the keyboard act at one hop)
REFUSES outright, leaving the running binary and the copy exactly where they
are; the AUTOMATIC 4406 revert cannot refuse into a rescue nobody is coming to
run, so it records the failure in `update-failed.json`, consumes the pending
marker (the next boot converges on the ordinary "too old" behaviour), and LEAVES
the refused-but-bootable new binary in place: renaming an unbootable copy onto
the path the manager EXECs buys a respawn that dies at exec with no log line,
and the revert logic a later boot would need lives inside that copy.

**What counts as "accepted", and why the number is what it is.** There is no
accepted frame. Two things count: any frame the plane sends after `ready`, or
the socket staying open past `UPDATE_ACCEPTED_MS`. The spec put that timer at
30 seconds on the reasoning that a refusal is immediate, which was true when a
refused node was CLOSED and is **not true now**: §5.3 made the plane HOLD a
refused socket, open and silent, until its own ten-minute idle budget expires.
At 30 s the two rules together delete `.previous` on exactly the machine about
to need it. So the timer is **15 minutes**, strictly beyond the plane's hold
budget, and it is a belt: the plane pushes `set_allowed_dirs` on every accepted
`ready`, so an accepted node settles on a FRAME within milliseconds. The cost
of the timer never firing is a stale ~70 MB `.previous`; the cost of it firing
early is the rollback.

**Refusals are the WIRE CONSTANTS, never sentences.** The plane matches
`NodeRpcError.detail` by equality, so `applyUpdate` throws `UpdateRefused`
carrying a `NODE_RESULT_*` string alongside the human message, and the executor
answers the constant. `execUpdate` applies `service restart`'s two refusals
first (not supervised, and a definition that would take live panes down
without `force`, failing closed on `unknown` AND on no report at all), because
an update is a restart with a file swap in front of it, and a refusal arriving
after 70 MB has crossed the wire is worse for having been late.

**No network path installs anything the publisher did not sign (spec
2026-09-17).** `applyUpdate`'s url source carries `manifest: {bytes, sig} |
null`; `verifySignedManifest` runs before the swap: `null` (a command with no
manifest, or a resolve with nothing to verify) is
`NODE_RESULT_MANIFEST_UNVERIFIED`, and so is a signature that does not verify
against `RELEASE_PUBKEY` (the protocol package's compiled-in publisher key)
with the payload bound to component `cli-node` + the version being installed.
The digest the bytes are compared against comes from the SIGNED `assets` map
keyed by the exact published filename, never from a `.sha256` sidecar or the
command's own `sha256` field alone. `resolveNodeRelease` (the CLI's own
`--check`/`--to`) fetches manifest+sig and verifies BEFORE the 70 MB download,
so an unsigned release costs two small reads; the plane-commanded path cannot
pre-verify (the bytes come from the plane's tokened route) and re-verifies
against the actual digest instead. `--from` and `--rollback` stay
signature-free: a file the operator named IS their decision, already verified
as far as it can be (it must say it is the node at the expected version).
The CLI's refusals name `--from` only where it is the answer. Three end
with "install a file with `--from`": an empty release source, a release
with no `release-manifest.json` ("cannot be verified"), and a release with
no `release-manifest.json.sig` ("is not signed"). Two deliberately do not:
a signature that does not verify answers `<tag> is not installable:
<reason>`, and a manifest that cannot be read answers `could not read the
release manifest from <tag>: …`; "the publisher did not sign this" is not
answered by hand-installing some other file; the test suite pins the first
of these two sentences verbatim.

**The `update` command's wire shape is FROZEN across protocol bumps**
(`node-frames.ts`). It is the one command the plane sends to a node whose
protocol it does NOT share (§5.3 holds such a socket precisely so this can
reach it), so the parser on this side may be any older build. A test pins the
shape as a literal rather than deriving it from the same source as the code.
Protocol 12 (spec 2026-09-17 §6) grew it by exactly two fields,
`manifest` (base64 of the verified manifest bytes) and `manifestSig`,
OPTIONAL at the frozen parser and enforced in the executor, and,
deliberately, NOT for everyone: a pre-12 node would parse such a command and
IGNORE both fields, installing on the old trust rule, so a 12 PLANE refuses
to send `update` to a pre-12 node at all
(`NODE_SIGNED_UPDATES_PROTOCOL_VERSION`; the route's 409 and the Updates
page's row say "node predates signed updates"). A held old-protocol socket
therefore keeps everything it was held for except this: the machine that most
needs updating is the one told, in a sentence, to update by hand.

The release source is `SUBSHELL_RELEASE_URL` (unset = the project's API, EMPTY
= air-gapped and every network read refuses pointing at `--from`), and the CLI
prints one line it cannot answer itself: **this binary holds no REST
credential**, so it cannot ask its own plane which version that plane can talk
to. `Settings → Updates` knows; `--to` is how a person acts on having read it.

`status --json` gains `paths.binary` (null under an interpreter, where there is
no single file to name) and `update: { pending, lastFailure }`.

`test:cli`'s `node-update.sh` is what proves the swap with two REAL binaries:
it installs this build, compiles a `99.0.0` one from the same source with a
patched `package.json` (restored from a trap), and drives `--check`, the
`--from` swap, the "already at" refusal, `--rollback`, a rollback with nothing
to roll back to, and a file that cannot say what it is. Against a local fake
release source it also carries the compiled signature story end to end: a
bogus armor refuses (step 10); a release signed by a throwaway keypair
(patched into `RELEASE_PUBKEY` and compiled in the way the version is patched,
restored from a byte copy, never an env override) INSTALLS on the signed
manifest's digest while the sidecar beside it lies, and refuses after one
hex character of the signed bytes is tampered (step 11). It boots no server
and dials no plane: a node has no database and no boot-time transaction,
so the only state `update` reads is `config.json`'s `dataDir`, which the
script writes by hand. The **4406 revert** is deliberately not compiled there: it
needs a control plane built on a different protocol constant, a second ~110 MB
build to exercise a close handler `daemon.test.ts` already drives directly.
