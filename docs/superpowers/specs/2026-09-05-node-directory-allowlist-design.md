# Node directory allowlist — design

**Date:** 2026-09-05
**Status:** approved, implementing

## Problem

A node grants **arbitrary command execution under its OS user** to whoever can
launch subshells on it — and any node share, even `view`, confers that. Today
the only limit on *where* a subshell may be launched is that the path exists
and is a directory (`validateWorkingDir`). `SUBSHELL_FS_ROOT` narrows browsing,
but it is server-side, local-only, and unset by default.

A node owner needs to say: on **this** machine, subshells may only be created
under these directories.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Enforcement scope | Creation + restart, **and** the folder picker | Gating creation alone lets a user browse to `/etc`, pick it, and get a refusal they cannot explain |
| Who may edit | **Node owner only** (`nodeCanManage`) | Any node share lets the grantee launch there. If an `edit` grantee can widen the list to `/`, it is not a boundary against the people it exists to constrain |
| Existing subshells outside a new list | Restart is **blocked** | A restart spawns a fresh pane in that directory — it is a launch, and gets the launch gate. Running panes are untouched |
| Empty list | **Unrestricted** | Backwards compatible; every existing node starts empty and nothing changes. Mirrors `SUBSHELL_FS_ROOT` unset |
| Where truth lives | Control plane, **pushed** to the node | The user edits it in the node's config UI; the node persists and independently enforces |

## Why the node must persist it

Node-side validation is the point: command signing proves *who*, not *whether*
(`path-policy.ts` already reasons this way for `write_file`/`remove_paths`).
An allowlist handed over inside the `launch` command proves nothing — a
compromised control plane would simply send a permissive one. So the node must
hold the list out-of-band and check every launch against its own copy.

That requires a new command, which requires a protocol bump.

## Cost: protocol v4 → v5

`NODE_PROTOCOL_VERSION` is matched **exactly** in both directions, so **every
enrolled node must be updated in lockstep or it is refused at connect**. Server
and client release together. `MIN_AGENT_VERSION` rises in the same commit, per
the rule in `versions.ts`, so the refusal names the version to install.

The exact-match gate is also what makes this safe: no node can be online
holding an unknown policy contract. A node that has not learned about
allowlists cannot connect at all, rather than connecting and silently ignoring
one.

## Architecture

### Shared — `packages/subshell-protocol/src/dir-allowlist.ts`

- `normalizeAllowedDir(raw): string | null` — absolute only; rejects `..`
  segments; collapses `//`; strips the trailing slash (except root).
- `normalizeAllowedDirs(raw[]): string[]` — normalizes, dedupes, and drops
  entries already covered by a broader entry (`/a/b` under `/a`).
- `dirAllowed(candidate, roots): boolean` — **lexical** subtree test; empty
  `roots` means unrestricted.

Lexical is necessary but not sufficient, and this is the trap to respect:
`resolve()`-collapse is symlink-blind. Callers must test the **resolved** path.
The server has it already (`validateWorkingDir` returns `realpathSync`); the
node uses its existing fs-aware `pathAllowed()` from `path-policy.ts`, which
handles `..`, symlinked ancestors and dangling leaves, as the authority.

### Protocol

New command:

```ts
| { type: "set_allowed_dirs"; dirs: string[] }
```

Pushed at two points:

1. When the owner edits the list — to that node, if online.
2. After every `ready` — the reconciliation that heals an edit made while the
   node was offline.

### Node (`apps/client`)

Persists to `<dataDir>/allowed-dirs.json` (0600, inside the 0700 data dir).
Enforces in:

- `execLaunch` — `cwd` must pass `pathAllowed`, else
  `{ok:false, error:"cwd is outside this node's allowed directories"}`.
- `execStatDir` — same gate, so the control plane's pre-launch probe agrees.
- `execFsLs` — listings are filtered to allowed subtrees. An empty `path`
  normally means "the agent's home"; when home is outside the list, the node
  answers with the allowlist roots instead, so the picker opens on what is
  usable.

### Server (`apps/server`)

- `createSubshell` / `restartSubshell`: check the **resolved** cwd against the
  node's list → 403 `DIR_NOT_ALLOWED`.
- `/api/files/explore` (local) and `files-remote-browse.service` (`fs_ls`)
  filter to allowed subtrees. On `local`, `SUBSHELL_FS_ROOT` applies **on top** —
  both must pass.
- Storage: `node_allowed_dirs` (`id`, `nodeId`, `path`, `createdAt`),
  cascade-deleted with the node, replace-whole-set semantics mirroring
  `SubshellSharesRepository.replaceForSubshell`. Migration `0021`, registered in
  the static provider map in `db/migrate.ts`.

### API

- `NodeView` gains `allowedDirs: string[]` — readable by anyone who can see the
  node, because a refusal is unexplainable without it.
- `PUT /api/nodes/:id/allowed-dirs` `{dirs}` — owner-only (`nodeCanManage`),
  cookie-only, audited `node.allowed_dirs.update`, capped at 64 entries to
  bound the push payload.

### UI (`apps/frontend`)

An "Allowed directories" card on the node detail page. Empty state reads
"Any directory — this node is unrestricted". Owners add (via the folder
picker, itself unscoped while editing — you must be able to pick a directory in
order to allow it) and remove; everyone else sees it read-only. Copy states
that it governs new subshells and restarts, not running panes.

## Failure modes

| Situation | Behaviour |
|---|---|
| Node offline when the list changes | Push fails; healed by the `ready` push on reconnect. Server enforcement holds meanwhile |
| Node on protocol v4 | Refused at connect by the version gate — it cannot be online with a stale contract |
| Listed directory absent on the node | Never matches. `stat_dir` at add time surfaces "not found on this node" rather than leaving a rule that looks effective |
| List emptied | Node returns to unrestricted — the same meaning as never having had one |

## Testing

- Protocol: `dir-allowlist` units — normalization, subtree, `..`, trailing
  slash, root, nested-entry collapse, empty = unrestricted.
- Node: `set_allowed_dirs` persistence round-trip; `launch`/`stat_dir`/`fs_ls`
  refusals; symlink escape denied (the fs-aware path, not the lexical one).
- Server: repository replace semantics; route gate (owner vs edit vs admin);
  create and restart rejection; picker filtering; `SUBSHELL_FS_ROOT` layering.
- Frontend: card render, owner-editable vs read-only.

## Out of scope

- Renaming the `agent` wire/DB value or `agentVersion` API field (see the
  terminology pass — deliberately left; breaking).
- Narrowing `write_file`/`remove_paths` to the allowlist: `path-policy.ts`
  already confines those to the data dir and tracked subshell cwds.
