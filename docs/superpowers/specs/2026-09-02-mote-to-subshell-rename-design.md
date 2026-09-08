# Design: Rename project "mote" → "subshell"

Date: 2026-09-02
Status: approved (owner delegated all decisions; away during execution)

## Goal

Rename the whole project from **mote** to **subshell**:

- The control plane (backend + host service) is branded **subshell-server** where a
  service-level name is needed; the product/UI brand is **Subshell**.
- The node agent binary is **`subshell`** (was `mote-agent`), so its MCP subcommand is
  `subshell mcp`.
- The backend's sibling MCP binary is **`subshell-mcp`** (was `mote-mcp`).

**Clean cut, no backwards compatibility.** The owner is the only user. No aliases, no
dual-read fallbacks, no data migration in code. Deployed-state migration is a rollout
checklist (see end) — executed by the owner, not by this change (see "Why rollout is
deferred").

## Scope inventory (verified 2026-09-02)

~413 files contain case-insensitive `mote`; ~390 are brand-sense. 582 matches are inside
unrelated words (`remote`, `promote`, `remove`) — every sweep must use word-boundary-anchored
patterns, never a bare `s/mote/subshell/g`. The npm scope is `@internal/*` (no brand — no
workspace/dependency renames). Full inventory highlights are folded into the naming map.

## Naming map

| Old | New | Notes |
|---|---|---|
| `mote` (word, project/product) | `subshell` | `\bMote\b` → `Subshell`, `\bMOTE\b` → `SUBSHELL` |
| `mote-agent` (binary, artifacts, prose) | `subshell` | artifacts `mote-agent-<triple>` → `subshell-<triple>`; `mcp__mote__*` tool ids update automatically via server name |
| `mote-mcp` (binary) | `subshell-mcp` | compile outfile, sibling lookup, `MCP_LAUNCH_PLACEHOLDER`, docs |
| `MOTE_*` (26 env vars) | `SUBSHELL_*` | plain `s/MOTE_/SUBSHELL_/g` — the `_` cannot occur inside English words |
| `mote_` API-key prefix | `subshell_` | `apps/backend/src/auth.ts` `defaultPrefix`; `nsk_` node setup keys **unchanged** |
| MCP tool names `mote_<verb>` | `<verb>` (prefix dropped) | e.g. `mote_list_channels` → `list_channels`; server name already namespaces them in `mcp__subshell__*` |
| MCP server name / harness config key `mote` | `subshell` | `server.ts`, `mcpServers: { subshell: … }` |
| `mote-internal` (identity harness string) | `subshell-internal` | generated stores regenerated, not sed'd |
| `mote.db`, `~/.config/mote/` | `subshell.db`, `~/.config/subshell/` | defaults + Docker + svc.sh |
| `~/.config/mote-agent/` | `~/.config/subshell-agent/` | **deliberate exception** to the `mote-agent`→`subshell` rule: plain `~/.config/subshell` would collide with the server's data dir when both run as the same user. Env override: `SUBSHELL_AGENT_HOME` |
| tmux socket base `mote-` | `subshell-` | `tmuxSocketFor()` — live panes orphan on upgrade; accepted (clean cut) |
| systemd `mote.service` | `subshell-server.service` | svc.sh `SERVICE=subshell-server` |
| agent unit `mote-agent.service`, launchd `dev.mote.agent` | `subshell.service`, `dev.subshell.agent` | log `~/Library/Logs/subshell.log` |
| Docker service/image/user `mote` | `subshell` | incl. OS user/group, `/home/subshell` mounts |
| `system@mote.local`, `mailto:mote@localhost`, push title `"mote"`, passkey `rpName` | `system@subshell.local`, `subshell@localhost`, `"subshell"`, `"subshell"` | |
| `MoteXxx` identifiers | `SubshellXxx` | `MoteApi`, `MoteClient`, `MoteSw`, `runMoteMcp`, `MoteMcp`, `useMote` (→ `useSubshell`), `mote-provider` (→ `subshell-provider`), `moteEnv` → `subshellEnv`, `MOTE_DIR` → `SUBSHELL_DIR` |
| `mote_` localStorage/SW keys | `subshell.*` | `subshell.sidebarCollapsed`, `subshell.termFontSize`, event `subshell:term-font`; **no migration** (silent pref reset accepted) |
| `.mote/` uploads subdir | `.subshell/` | incl. `.git/info/exclude` writer |
| `.claude` hooks `mote-hook.sh`, `MOTE_HOOK_*`, `MOTE_*` hook env | `subshell-hook.sh`, `SUBSHELL_*` | |
| e2e accounts `mote_dev1`/`mote_nodes1` | `subshell_dev1`/`subshell_nodes1` | |
| mobile: name/slug/scheme `mote`/`mote-mobile`/deep-link `mote`, bundle `nu.suteki.mote` | `subshell`/`subshell-mobile`/`subshell`, `nu.suteki.subshell` | dev builds only; owner reinstalls. Includes `ios/` + `android/` native project dirs/paths |
| `mote-mcp` tmpdir, `mote-e2e-`, `mote-identity-`, `mote-` temp prefixes | `subshell-*` | |
| temp test DBs `mote-test-*` | `subshell-test-*` | |
| icons `mote-source.svg`, `mote-maskable.svg` | `subshell-source.svg`, `subshell-maskable.svg` | file renames + `gen-icons.ts` refs |
| `mote-static` Elysia plugin name, `.idea/mote.iml` | `subshell-static`, `subshell.iml` | cosmetic but brand-sense |
| `~/.config/mote-mobile-env.sh` (docs) | `~/.config/subshell-mobile-env.sh` | |
| `Mote Gravity` / `MOTE_GRAVITY` (test fixture identities) | `Subshell Gravity` / `SUBSHELL_GRAVITY` | brand wordplay; rename mechanically |
| GitHub remote `disaresta-org/mote` | `disaresta-org/subshell` | renamed via `gh` during rollout step; local `remote set-url` |
| Working dir `/home/theo/projects/mote` | `/home/theo/projects/subshell` | **last step, run by owner** (renaming my own cwd kills the session — see below) |

## Explicit non-renames

- `@internal/*` package names, `turbo.json` — no brand.
- `nsk_` node setup-key prefix, `DATABASE_PATH`/`SESSION_DATA_DIR` env names.
- better-auth cookie names (derived from baseURL, brand-free).
- `/install.sh` URL slug (brand-free).
- `docs/superpowers/{plans,specs}/**` and `.sdd/**` **historical records — frozen**.
  Past specs/plans describe the world as it was named; rewriting them is erasure, not
  rename. They are excluded from every sweep (the one exception: this spec itself).
- `CHANGELOG.md` historical entries — frozen; a new entry documents the rename.
- Words containing `mote` (`remote`, `promote`, …), `motej` (e2e password), `@mote.dev`
  admin email (instance config data in docs only — leave).

## Execution design (approach A: scripted waves on a branch)

Branch `rename/subshell`; commit per wave. **After every wave**:
`bun run verify-types && bun run lint:check && bun run test` — a wave that can't be
made green is fixed before the next wave starts. (Playwright e2e is not part of this
gate, per AGENTS.md; its references are renamed by the waves and type-checked.)

- **Wave 0 — baseline.** Confirm the three verification commands pass unmodified.
- **Wave 1 — special-case tokens, longest-first**, where the generic rule would be
  wrong: drop the `mote_` prefix from the 14 MCP tool names + doc text;
  `~/.config/mote-agent` → `~/.config/subshell-agent`; `mote.service` →
  `subshell-server.service`; `mote-agent.service` → `subshell.service`; artifact
  names; `Mote Gravity`/`MOTE_GRAVITY`; mobile bundle id/paths; anything else where
  context differs from the table's generic row.
- **Wave 2 — generic anchored sweep** over all non-frozen files:
  `MOTE_`→`SUBSHELL_`, `mote_`→`subshell_` (key prefix, accounts, localStorage),
  `mote-internal`→`subshell-internal`, `\bmote\b`→`subshell`, `\bMote\b`→`Subshell`,
  `\bMOTE\b`→`SUBSHELL`, `Mote([A-Z])`→`Subshell\1`, `\.mote\b`→`.subshell`.
- **Wave 3 — generated artifacts: delete and regenerate, never sed** (opaque base64
  identity chains embed `mote-internal` and HMAC-named filenames; corrupting them is
  worse than any typo): `packages/mcp-core/src/__tests__/env/workflow-ids.json`,
  identity-chain fixtures in `apps/backend/__tests__/env`, pin stores in
  `apps/backend/.dev/auth/`, test env files under `apps/agent` test home. Regenerate
  by running the provisioning path (test-preload) with the stores removed.
- **Wave 4 — file/dir renames** (`git mv`): icon SVGs, `subshell-hook.sh`, mobile
  provider files, `ios/mote*` tree, `android/.../nu/suteki/mote` package dirs,
  `.idea` module; then fix all references (pbxproj, gradle, entitlements).
- **Wave 5 — prose & branding pass**: README/AGENTS/CLAUDE/docs re-read for
  post-sweep grammar ("the subshell subshell" style artifacts, headings), frontend
  user-visible strings, manifest/SW, install-script shell text.
- **Wave 6 — sweep verification**: case-insensitive grep for `mote` outside frozen
  paths must yield only unrelated-word false positives (`remote`, `promote`, `remove`,
  `motej`, `@mote.dev`, "RemoteMuxError"). Fix stragglers.
- **Wave 7 — ship state**: new CHANGELOG entry, commit, merge branch to local `main`
  (repo convention: linear trunk; owner pushes). `gh repo rename subshell` + local
  `git remote set-url` (explicitly approved by owner).

## Live-host rollout — prepared, NOT executed by this change

**Why deferred:** (1) this Claude session is itself a mote-managed pane, and the
backend holds the tmux sockets and stores being mutated — executing the rollout from
inside would sever the session mid-migration; (2) the final repo-directory rename
removes the cwd of every running tool. The change therefore ships
`docs/subshell-rollout.md`: an ordered, copy-pasteable checklist covering — stop all
sessions (panes die at the tmux socket rename; accepted); stop old units
(`mote.service`, `mote-agent.service`); `mv ~/.config/mote → subshell` + `mote.db` →
`subshell.db`; sed-rename `MOTE_*` vars inside env files; SQL-fix `working_dir` paths
pointing at the old repo dir; rebuild (`bun install`, `turbo build`); install new unit
via `svc.sh`; daemon-reload + start; re-mint system API keys (`mote_` prefix invalid);
delete stale api-key rows; re-enroll nodes with the new install script; then — from
outside the repo — `mv ~/projects/mote ~/projects/subshell` and migrate the Claude
memory dir (`~/.claude/projects/-home-theo-projects-mote` → `…-subshell`).

## Testing

The rename's correctness gate is the standard trio (types/lint/unit tests across all
packages) after every wave, plus the Wave-6 residue sweep as a rename-specific check.
Existing tests already pin the renamed surfaces (tool list in `server.test.ts`, prefix
checks in `mcp-core/src/__tests__/env.test.ts`, `release.test.ts` artifact names,
`cli-help.test.ts`, Playwright `getByText("Subshell")`) — they are updated by the waves,
not replaced.

## Decision log (owner delegated)

1. Freeze historical plans/specs/.sdd/CHANGELOG entries rather than rewrite them.
2. Rename mobile bundle IDs (dev builds only).
3. No localStorage/SecureStore migration — preferences reset silently, accepted.
4. Agent config home gets `-agent` suffix to avoid server-dir collision.
5. Control-plane service name `subshell-server.service` per owner's "subshell-server".
6. Tool-name prefix dropped (server name namespaces already).
7. Rollout doc prepared but not executed from inside the live system; local merge to
   `main`, no push; GitHub repo rename + remote URL are pre-approved.
