# Node-to-node archive transfer over the plane

Date: 2026-10-01. Status: approved by the operator in dialogue (the rulings
below are quoted at their decision points). Pairs with
`2026-10-01-mcp-terminal-sessions-design.md`; the two ship in that order and
share no protocol surface. This one bumps the node protocol 14 -> 15.

## Summary

An agent that wants a tree of many small files moved from one enrolled machine
to another has no structured path: the terminal pane is the only thing that
runs commands, and piping an archive through a PTY (base64 into a pane log)
mangles bytes under terminal translation and dumps hundreds of megabytes into
artifacts that have a retention policy and a security rule against being
copied around. So this spec adds five signed node commands, executed entirely
inside the compiled agent binary (no host `tar`, no `rsync`, nothing to
install), and a plane-orchestrated relay: the source node builds a `.tar.gz`
into its own staging area, the plane streams it window by window to the
destination node over the existing encrypted, serialized link, and the
destination extracts it with the registry extractor's guard doctrine. One MCP
tool, `transfer_files`, exposes copy and diff-sync (`sync: true`), where the
diff is computed by the plane from per-file SHA-256 manifests that the agents
produce themselves.

Reaching a node is not widened: the caller must own both endpoint machines,
bearer reach stays the strict-owner-only rule, the node's operator directory
allowlist is honored on both endpoints, and a new `transfers` key gates pane
tokens. Transfers are agent-node to agent-node; `local` and the browser are
out. v1 never deletes at the destination and does not resume an interrupted
transfer.

## Operator rulings (2026-10-01)

1. Scope: agent node to agent node as the core, with incremental sync in v1,
   under an explicit condition: "My concern with #4 is software availability.
   Not all systems will have rsync installed. If we can't guarantee we'd have
   the software we'd need, we cant do #4." The condition is met by construction:
   the agent is a self-contained compiled Bun binary, so hashing, tarring, and
   gzipping run in-process. The plane computes the diff itself; no foreign
   binary is ever asked for. Browser and plane-host endpoints were offered and
   left out.
2. Path policy: "Honor node allowlist." Both endpoints pass the node's
   operator directory allowlist when configured, with today's semantics
   unchanged (empty = unrestricted). Terminal panes already reach anywhere the
   OS user can after launch; the structured path honors the one lever
   operators actually set.
3. Permission: a new `transfers` key in the subshell token map rather than
   riding `subshells:write`, with no legacy pass. The known consequence is
   accepted: self-extension keeps the map frozen, so panes launched before this
   feature are refused transfers until they restart.
4. Shape: the five-verb, plane-relay design ("F1") over terminal-piping (byte
   corruption, log pollution) and node-to-node direct transport (breaks the
   star topology every key and gate assumes), with sync built in from the
   first bump so the protocol bumps once.

## 1. The probe gates the writer (task zero)

Everything measured in compiled agent binaries so far is SYNC and
whole-buffer: `Bun.gzipSync` / `gunzipSync` (pinned by the tar-vendor header
note) and streaming `fetch` + `Bun.file().writer()` + `Bun.CryptoHasher`
(pinned by `update.ts`). A sync-gzip writer means the full uncompressed tar in
RAM, which dies at GB scale. Before any archive code is committed, a checked-in
probe (`scripts/`, compiled with `bun build --compile`, run against a
synthetic ~500 MB tree) measures in the compiled binary:

- streaming `node:zlib` `createGzip` piped to a file writer, and
  `createGunzip` reading back,
- `Bun.CryptoHasher("sha256")` fed in the same loop.

Pass: the writer and extractor stream. Fail: the writer falls back to
multi-member gzip (concatenated `Bun.gzipSync` members, legal per RFC 1952)
with the probe ALSO verifying Bun's gunzip and the system `tar` accept the
result; the extractor follows the probe's verdict. The chosen verdict is
recorded in the format module's header in the tar-vendor "PRIMITIVES OK"
style. This is the only item that can change the internals, so it runs first.

## 2. Protocol (one bump, additive arms)

`packages/subshell-protocol/src/node-frames.ts`: `NODE_PROTOCOL_VERSION = 15`
and a bump-history paragraph in house style ("Additive, and breaking anyway,
because the gate is exact-match"), noting what it does not do: a lagging agent
answers `{ ok: false, error: "unsupported" }` for the new verbs, which the
plane maps to an update remedy. Five arms join `NodeCommandBody` and
`parseNodeCommandBody`, with result validators in `node-results.ts` (all
exports stay node-import-free, per the Metro barrel trap):

| verb | args | answer | plane deadline |
| --- | --- | --- | --- |
| `archive_create` | `{ root, files?, stagingPath }` | `{ size, sha256 }` | 300 s |
| `file_read` | `{ path, fromByte, maxBytes }` | `{ bytes_b64, next, size }` | 10 s |
| `transfer_write` | `{ path, chunkB64, chunk, eof }` | the `write_file` result shape | 30 s per chunk |
| `archive_extract` | `{ archivePath, destRoot }` | `{ files, bytes }` | 300 s |
| `tree_manifest` | `{ root, cursor?, maxBytes }` | `{ entries, nextCursor }`, entries `{ relPath, size, mtime, sha256 }` | 60 s |

Named constants live in the protocol package so agent and plane cannot drift
(they are the wire contract): `MAX_TRANSFER_WINDOW_BYTES = 512 * 1024`,
`MAX_ARCHIVE_BYTES` (4 GiB default), max entries per manifest page and total,
and a cap on the `files` list length.

Window math, learned the expensive way once already (the uploads errata):
512 KiB raw becomes about 699 KiB of base64 plus envelope, inside the 1 MiB
`NODE_MAX_FRAME_BYTES` both directions enforce. Do not enlarge windows. The
link's per-node serialization (commands strictly sequential per connection,
one serial executor on the agent) means throughput is RTT-bound, roughly
5 MiB/s at 80 ms round trip, and a minute-long `archive_create` or
`archive_extract` briefly queues behind pane input on that node. v1 accepts
both, bounded by `MAX_ARCHIVE_BYTES`; resume and async job semantics are
non-goals. `archive_create` with a `files` list whose JSON would exceed the
frame cap falls back, plane-side, to a listless whole-tree create.

## 3. The archive format

One module owns writer + parser together, beside `packages/pane-runtime/src/
tar-vendor.ts` (the agent already imports pane-runtime; format code lives in
exactly one place, decided by the probe). Rules:

- ustar records, with pax extended headers for names over the 100-byte field
  (the vendored parser already reads pax `path=`; the writer emits what the
  parser accepts, so the pair is coherent). The npm archives' `package/`-strip
  rule is tar-vendor's business only and does NOT apply here.
- Extraction doctrine copied from the registry extractor: links and devices
  refused outright, traversal and absolute paths refused, caps enforced during
  parse with the shared constants (the 20 MiB / 1024 plugin-install caps are
  wrong for transfers and are not reused). Guards run AFTER pax substitution:
  a pax-supplied path is exactly as policed as a name-field one.
- The archive rides the link as an opaque file; the plane never parses it.
  `archive_extract` re-verifies the digest `archive_create` reported before
  touching the destination tree.

## 4. Agent side

New executors under `apps/node/agent/src/commands/` (`archive-create.ts`,
`archive-extract.ts`, `file-read.ts`, `transfer-write.ts`,
`tree-manifest.ts`), wired into the `dispatchCommand` switch, tests beside the
existing tmpdir pattern, every answer routed through the wire validators.

- **Policy is the operator allowlist, not the upload roots.** A new guard
  reuses `pathAllowed`'s `..`/symlink discipline against the node's local copy
  of the directory allowlist (`allowed-dirs-sync.ts` already keeps it fresh; no
  change needed). Empty allowlist means unrestricted absolute paths, the same
  posture launches already have; this spec EXTENDS that posture to structured
  writes, which is a wider blast radius than a launch dir, and `docs/
  security.md` says so plainly. `write_file` (the uploads path, gated to the
  data dir plus tracked working dirs, twice-gated and pinned by tests) is NOT
  widened; the new verb is deliberately named `transfer_write`, word order
  apart, and the header comment keeps the next reviewer from merging them.
- `file_read` is a generalized `log_read` with its own policy check.
  `log_read` stays confined to `<dataDir>/subshells/<id>.log`; the two never
  share a code path or a name.
- Staging: `archive_create` writes under the node's data dir (a plane-minted
  unique name, so a timed-out retry cannot double-write), a single regular
  file so the existing `remove_paths` root set can clean it. Destination
  writes reuse `write_file`'s discipline verbatim: `.part` beside the final
  path, mode 0600, strict chunk sequencing, the policy re-checked at eof,
  one rename to land, and the stale-temp sweep to catch the rest. A half
  transfer is therefore one file, not half a tree.
- `tree_manifest` walks deterministically (sorted), hashes with
  `Bun.CryptoHasher("sha256")` streamed, never whole-file reads, and pages by
  both entry count and byte budget. The cursor resumes strictly after the
  last returned `relPath`. Trees that mutate mid-sync can dup or skip across
  pages: sync is documented as eventual-convergent, and re-running it is the
  remedy. SHA-256 is the diff key; mtime is a hint and cross-machine clock
  skew is why.

## 5. Plane side

- Route: a new `api/transfers/` directory, `POST /api/transfers` with body
  `{ from: { nodeId, path }, to: { nodeId, path }, sync? }`,
  `requirePerm("transfers", "write")`. `LOCAL_NODE_ID` on either endpoint is
  a 400 naming the reason (agent-node to agent-node, by ruling; no
  half-implemented plane-filesystem endpoint). Both nodes resolve under the
  strict-owner-only posture `resolveLaunchNode` uses for machine actors: the
  caller's account must OWN both. Offline or maintenance on either side is a
  409 up front, the same codes the launch path answers.
- Token map: `services/subshell-tokens.ts` mints `transfers: ["read",
  "write"]` from now on; `auth-guard.ts`'s `requirePerm` union gains the key.
  NO legacy pass: the `prompts` missing-key concession is a one-off historical
  carve-out, and grandfathering old tokens into a file-move grant is exactly
  the mistake it would be to copy.
- Service: a new `transfers.service.ts` owns the relay. Copy: `archive_create`
  on the source, then loop `file_read` window / `transfer_write` window, then
  eof, `archive_extract` on the destination, then `remove_paths` the staging
  file. Exactly one decoded window is held at a time; the uploads service's
  whole-buffer posture is the anti-pattern this path must not meet. Sync: page
  both `tree_manifest`s, diff plane-side on SHA-256, ship the changed set in
  the create's `files` list (listless fallback per section 2), extract.
  Additive always: extra files at the destination are left alone; deletion is
  a separate future ruling. Mid-flight failure (node drop, deadline, client
  abort): abort, clean staging and the destination `.part`, answer the error;
  no transfer row, no resume.
- Audit: a new `transfer.create` / `transfer.complete` family naming the two
  node ids, the two paths, the byte and entry counts, sync flag, and outcome.
  Never file contents. `docs/security.md` section 10 and the working summary in
  `.claude/rules/security-context.md` both gain the family; the route also
  refuses an agent below protocol 15 with a code that names the remedy
  ("update the node" through `describeToolError`), since an old agent's
  `unsupported` answer is otherwise cryptic.

## 6. MCP surface

One new tool, the 21st on the wire (both pinned test sets updated
deliberately): `transfer_files { from: { node, path }, to: { node, path },
sync? }`, node addressing reusing the exact-id-first / name grammar the other
tools share. The handler lives in a new `src/transfer-tools.ts` (subshell-tools
is already at the file-size limit) with an exported named schema constant, per
the code-style rule. The call is synchronous in v1 and `MAX_ARCHIVE_BYTES` is
sized so it finishes inside a sane tool-call window; the description says what
a refusal to restart an old pane means, and that a large first transfer is
measured in RTTs, not bandwidth.

## 7. Bump and release choreography

SERVER FIRST, per the node-frames header rule. The signed release manifests
auto-stamp `nodeProtocol` from the constant, and the plane only OFFERS releases
whose `nodeProtocol` equals its own, so a protocol-15 server holds protocol-14
agents as HELD (the 4406 path) rather than confusing them, and the frozen-shape
`update` command crosses the bump to bring them up. Order: cut `cli-server`,
verify a still-14 node shows the honest update remedy and updates cleanly, cut
`cli-node`, let `updateInternalDependents` carry the desktops; the docs train
carries `reference/node-protocol.mdx` (version line, a transfer row in the
command-families table, the caps and window limits) independently. `apps/docs`
mcp/tools page and `subshells.mdx` follow the 21st tool and the presetless
launch from the sibling spec.

## 8. Non-goals

- Any host-binary dependency (`rsync`, `tar`, `gzip`): none is asked for, ever.
- `local` or browser endpoints; plane-host transfers stay the uploads path.
- Destination deletion (`mirror`), transfer resume, async transfer jobs,
  resumable manifest diffing beyond re-running.
- Watching or continuous sync: sync is an act, not a state.
- Moving this data through `write_file`/uploads: the roots differ on purpose.

## 9. Tests

- Protocol: the version pin, a parse census per new arm (good shapes, hostile
  shapes: negative offsets, oversized windows, `..` paths, non-absolute
  paths, list-length cap), `node-results` validators.
- Agent: `commands-archive-create/extract`, `commands-file-transfer`,
  `commands-tree-manifest` suites on real tmpdirs, traversal/symlink/cap
  refusals, pax long paths, digest mismatch at extract, the multi-member
  case if the probe chose it, and the compiled-binary probe script itself as
  the R4 gate.
- Plane: `scripted-node` relay suite asserting the exact command census
  (create, read/write alternation with eof last, extract, `remove_paths` on
  abort), the both-owner gate, `local` 400, offline/maintenance 409, the
  `transfers` token shape (new mints carry it; an old map refuses until
  restart), and sync's diff deciding what enters `files`.
- MCP: fakeApi cases for the tool, the update-remedy error branch, and the
  deliberate 21-name pin.
