# Phase 3 Design: Plugins from the Registry

Date: 2026-09-09
Status: approved design (brainstorm 2026-09-09), pending implementation plan
Parent: `2026-09-09-plugin-architecture-design.md` §8 (Distribution), §13 (Security), §15 (Phases)

This document decides the things the master spec left open for phase 3. It does
not restate what §8 already settled: registry install verifies the tarball
against the registry's own `integrity` hash, extraction uses a vendored tar
reader (no `tar(1)`, the agent is a compiled binary in minimal containers),
built-ins ship embedded and prefer the embedded copy, publishing follows
`~/projects/loglayer`'s OIDC trusted publishing with self-hosted runners, and
§13's setup-route guard (the anonymous first-run window stays built-in-ids-only)
is load-bearing and unchanged.

## 1. Scope

In: the registry client, the install/update/repair it enables, the agent CLI
verbs that drive it (`subshell plugin list|install|uninstall|update`), protocol
the protocol bump (1 → 2), the control-plane passthrough, the npm publishing workflow, docs.

Out (each named so nobody drifts into it): web UI for third-party names (phase
4), plugin settings schemas (phase 5), anything like dependency installation
(a plugin bundle is self-contained by contract, §4.1), signature or
provenance verification beyond the registry's integrity hash, an operator
name allowlist (decided against, §2.3).

## 2. Decisions

Four from the brainstorm (2026-09-09), plus the interface decisions they force.

### 2.1 Transport: protocol v2 with an optional `spec`

`plugin_install` gains an optional `spec` field, and `NODE_PROTOCOL_VERSION`
bumps 1 to 2 — the first real bump after the 2026-09-09 numbering restart. The
exact-match gate makes the bump cheap and honest: server and
agent ship together, a mismatch is a deployment out of step.

- `spec` is an npm package name, optionally with `@version` or a dist-tag
  (`@scope/pkg`, `@scope/pkg@1.2.3`, `@scope/pkg@latest`).
- **Absent `spec` means the embedded copy**, exactly as today. Every existing
  caller (both cards, local installs, migrations) keeps working with no change
  in meaning: `id` alone names a built-in of this build.
- `plugin_uninstall` is unchanged: it removes a directory, and it never needed
  to know where the bytes came from.
- `MIN_AGENT_VERSION` is NOT bumped. It is the operator-facing floor, bumped on
  its own schedule; the protocol gate is what refuses a v1 agent, and the
  refusal message already names both numbers.

The control-plane route `POST /api/nodes/:id/plugins` accepts an optional
`spec` string in the body and forwards it verbatim inside the signed command.
There is deliberately no web UI that sends one yet: the node window's card and
the Plugins card gain their text input in phase 4. Shipping the passthrough
now is not dead weight, it is the "same two routes" promise held, and it makes
third-party install scriptable today (curl with an owner cookie) the way the
directory allowlist is.

The `local` host goes through the same shape: `installLocalPlugin(pluginId,
spec?)`, admin-only route unchanged, built-in ids still embedded-first (§2.5).

### 2.2 Where the code lives: `@internal/pane-runtime`

The registry client lives in pane-runtime beside `plugins-dir.ts`, not in the
agent. That is the phase-2b lesson applied one layer down: the fetch/install
mechanism is written ONCE and both hosts call it, so `local` and an agent
cannot drift in how integrity is checked or how a tarball lands on disk. The
agent adds only CLI and command-handler glue.

Module boundaries inside pane-runtime:

| module | owns | knows |
|---|---|---|
| `registry.ts` | packument resolution, tarball fetch, integrity verification, timeouts and size caps | a registry base URL, nothing about plugins |
| `tar-vendor.ts` | unpacking one `.tgz` byte buffer into validated entries | gzip + ustar/pax, nothing about npm or plugins |
| `plugins-dir.ts` (extended) | `installFromRegistry(dataDir, spec, opts)`: compose the two above with the existing staging/rename/restore machinery, manifest validation, and the sidecar | npm's layout (`package/` prefix), our manifest contract |

`installFromRegistry` returns the same `InstalledPlugin` as `installEmbedded`
and shares its failure discipline: any throw leaves the previous state intact
(staging removed, nothing renamed).

### 2.3 Name policy: any name, owner-only

Decided explicitly, recorded so it is not relitigated: the control plane does
not keep an allowlist of installable package names. §13's posture already
covers this install: explicit act, named source, owner-only, integrity-verified
before anything is written, and the trust decision is the same one installing
the harness CLI itself makes. An allowlist would be a second security control
no complaint asked for, and it fights the goal (third-party plugins) that
started the revamp. The anonymous setup window stays built-in-only forever or
gains auth first, per §13; that guard is what makes "any name" safe to say
only of the authenticated owner-only routes.

### 2.4 Identity: package name, plugin id, and the sidecar

The npm package name and the plugin id are two different strings, and the
manifest's `subshell.id` is the authority for the directory. `@subshell-ai/
plugin-codex` installs to `<dataDir>/plugins/codex/` because its manifest says
`id: "codex"`. The id must match the existing `SAFE_PLUGIN_ID` rule or the
install is refused (same refusal, same message, before anything is written).

A sidecar `install.json` inside the plugin directory records what the registry
install actually resolved:

```json
{ "name": "@subshell-ai/plugin-codex", "version": "1.2.3", "integrity": "sha512-...", "installedAt": "..." }
```

- It is the source for `subshell plugin list` (package column) and for `update`
  ("is `latest` newer than what?").
- Its ABSENCE means embedded: seeded built-ins and `installEmbedded` writes do
  not carry one. A registry install of a built-in id writes one, which is also
  how `update` learns not to touch the embedded copies it did not choose.
- It is NOT part of `PluginReportWire`. The report's `version` field is and
  stays the PROGRAM's version (the node-page card documents that distinction);
  a `pluginVersion` on the wire belongs to the phase that renders one.
- A registry install whose manifest id collides with an existing directory
  whose `install.json` names a DIFFERENT package is refused. Two packages
  must not fight over one directory; the operator uninstalls first and sees
  why in the refusal message.

### 2.5 Embedded-first rule, made exact

From §8.2, made testable. `plugin install claude-code` (or a signed command
with `spec` naming a built-in id):

1. id in `builtInIds()` AND the spec pins no version (absent spec, bare id, or
   bare package name) → embedded copy. The registry is never contacted. This
   is what keeps first-run setup offline.
2. id in `builtInIds()` AND the spec pins a version equal to the embedded
   package's version → embedded copy (no pointless byte churn).
3. id in `builtInIds()` AND the spec pins a DIFFERENT version → registry copy,
   and the network is real. A pinned version the registry cannot answer is an
   ERROR, not a silent fallback to embedded: asking for 1.3.0 and quietly
   getting the embedded 1.2.0 is the kind of lie this design keeps refusing to
   tell. (This is also the only way an operator gets a non-embedded version of
   a built-in onto a host, which is exactly why it must never fall back.)
4. unknown id → registry, always. Unreachable registry is an error that names
   the URL it tried.

### 2.6 Update semantics

`subshell plugin update [<id>]`: for each installed plugin WITH an
`install.json` (id omitted: all of them), resolve `latest`, compare with the
recorded version by semver, reinstall only where newer. Plugins without a
sidecar (embedded) are reported as skipped, never upgraded from the registry
behind their operator's back. The result flows through the machinery phase 2
already built: the new bytes sit on disk, `IMPORTED` fingerprints mark the
loaded copy `stale`, the report carries `restartRequired`, and the card says
restart. `update` with a pinned `install.json` that is NEWER than `latest`
(downgrade or a removed version) does nothing and says so.

### 2.7 Registry URL config

- Agent: `registryUrl?: string` in `AgentConfig` (config.json, 0600). A
  corporate mirror (verdaccio) is the motivating case. `subshell configure`
  grows the flag; unset means `https://registry.npmjs.org`.
- Server (`local` host): `SUBSHELL_PLUGIN_REGISTRY_URL` in constants/config.env
  (same SETDEFAULT ladder as every other server setting; `subshell-server
  status` will report it in the plan's docs step).
- Both accept http or https with an optional path prefix (mirrors under
  `/registry/` are real), validated by component like `TRUSTED_ORIGINS`, stored
  used-as-is minus trailing slash. Integrity checking makes a plain-http
  mirror survivable on this posture: the hash comes from the same host as the
  bytes, which is weaker than npm-over-TLS, and it is the operator's own
  mirror on their own network.

### 2.8 The vendored tar reader, bounded

Extraction hard rules, all testable against fixture `.tgz` buffers:

- Accept regular files and directories only. **Symlinks, hard links, and
  device entries are refused outright** (an entry whose type is not file/dir
  fails the whole install): npm `pack` never produces them, so accepting them
  would only add an attack surface for zero function.
- Entry paths must stay under the extraction root: reject absolute paths and
  any `..` segment after normalization.
- The `package/` prefix npm wraps everything in is stripped; an archive whose
  single top-level directory is not `package` is accepted anyway (some mirrors
  repack), everything else normalizes under it.
- Size caps: tarball ≤ 20 MB uncompressed-and-compressed both, entry count ≤
  1024, checked during parse, not after full expansion. Timeouts: packument
  fetch 15 s, tarball fetch 60 s, both abortable via `AbortSignal.timeout`.
- pax extended headers are honored for long names/sizes; GNU extensions are
  not parsed (npm never writes them; a tarball using them fails clean).

## 3. Failure behavior, stated once

| failure | outcome |
|---|---|
| registry unreachable / timeout | error naming the URL tried; nothing written; built-in-without-pin case falls back to embedded (§2.5 rule 1 never touched the network anyway) |
| integrity mismatch | error naming the version; staging removed; the existing install untouched |
| tarball unreadable / hostile (links, traversal, oversize) | error; nothing written |
| manifest missing/invalid/`apiVersion` unsupported | error (the existing load-time refusals, reached BEFORE any rename) |
| module load throws after extraction | install refused, staging removed, previous state intact |
| id collision with a different package | refusal naming both packages (§2.4) |
| pinned version absent from registry | error; NO embedded fallback (§2.5) |

## 4. Publishing (§8.3, as specced, with the fleet rules)

`changesets/action` gains the publish script (`changeset publish`), `id-token:
write`, `~/.npmrc` removed pre-publish, `publishConfig.access: public` on the
five plugin packages (and `@subshell-ai/plugin-api`), the packages leave the
changeset `ignore` list, and the job runs on `[self-hosted, Linux, X64]` with
`timeout-minutes`. The operational note from §8.3 stands and is the phase's
human step: trusted publishing must be configured per package on npmjs.com
before the first successful publish; until then the publish job 403s, which is
loud, correct, and expected.

Testing before any package is published: pane-runtime and agent tests run
against a FAKE registry (a small Bun.serve fixture serving packuments and
tarballs built from real `bun pack` output of the five plugin packages). The
integrity hashes in fixtures are computed, not hardcoded.

## 5. Security documentation

New paragraph in `docs/security.md` (and a line in `.claude/rules/security-
context.md`) carrying master-spec §13 forward plus the two sentences this
phase makes true:

- The registry URL is operator-configurable, and integrity only proves the
  bytes match the hash the SAME server published (§2.7). Over the default
  https URL that is npm's own assurance; over an http mirror it is the
  operator's own network. The security doc must say so rather than implying
  registry-agnostic verification.
- A plugin id is claimed by the manifest inside the tarball, so id collisions
  are refused against what is installed (§2.4). Across an uninstall there is
  nothing to collide with, and that is honest: removing the directory is the
  operator saying the slot is free. An id switch is not a privilege hop,
  though: both old and new code run as the node's OS user with the same
  visibility.

## 6. Testing

- **pane-runtime, fake registry**: §2.5's four rules each get their own case;
  §3's table is a test list, row by row; the tar reader gets the hostile-
  archive fixtures (absolute path, `..`, symlink entry, oversize, truncated,
  pax long name) verified-red-then-green per house rule (each guard proven by
  reverting it).
- **protocol**: v2 parse cases (`spec` optional string, wrong types rejected),
  bump test (v1 now refused).
- **agent**: `execPluginInstall` with spec routes to `installFromRegistry`
  against the fake registry; CLI verbs' output is stable (`--json` too);
  `update` skip/upgrade/unchanged paths; sidecar read/write.
- **server**: route accepts and forwards `spec` (owner cookie only; setup route
  UNCHANGED and its built-in-only test still green), `installLocalPlugin`
  with spec, local page reports the third-party plugin like any other.
- **e2e**: spec 14 against a fake registry started by `stack.ts` with
  `SUBSHELL_PLUGIN_REGISTRY_URL` pointed at it: `POST /api/nodes/local/plugins
  {pluginId, spec}` installs a tarball the fake registry serves, the node page
  row appears, the picker gains it, uninstall removes it. No web input exists
  yet (phase 4), so this spec drives the API with admin state, same idiom as
  spec 13's `finally`.
- **publish workflow**: script-level test like `release.test.ts` (no real
  publish).

## 7. Landmines carried into the plan

- `bun build --compile` must still see everything: the registry client uses
  only `fetch` (global), `node:crypto` (createHash), and the vendored reader.
  No new runtime dependencies anywhere.
- bun's `AbortSignal.timeout` and `Bun.gunzipSync` availability: the plan's
  first task verifies both in the COMPILED binary, not just under `bun run`
  (measured-not-assumed, and this repo has been bitten by that difference
  before).
- The compiled-binary path where a plugin's bare specifier cannot resolve
  (§2.1 measured facts) means a third-party plugin that violated the inline-
  everything contract fails LOAD, and the load-check inside install turns that
  into install-refused rather than a broken row. Good; keep the check.
- Protocol v2 touches the census: a new command or field must appear in the
  agent's endpoint/command coverage test the same commit it appears in the
  parser.
