# "mote" → "subshell" Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the project from "mote" to "subshell" everywhere in tracked code/docs — control plane branded subshell-server, node agent binary `subshell`, MCP server `subshell` with un-prefixed tool names — as a clean cut with no backwards compatibility.

**Architecture:** Scripted, word-boundary-anchored find/replace applied to **tracked files only**, in ordered waves (special-case tokens → bulk sweep → file renames → prose → residue audit). Verification (types/lint/tests) after every wave. Generated/untracked state (identity chains, pin stores, DBs) is deleted and re-provisioned, never edited. Live-host migration is a **prepared but unexecuted** checklist (`docs/subshell-rollout.md`) because this session runs inside the live mote control plane and the repo dir is the working directory.

**Tech Stack:** git (tracked-file enumeration), sed/ugrep under bash, bun (verify-types, lint:check, test), Expo prebuild projects (ios/, android/ directory renames), `gh` CLI (repo rename).

**Spec:** `docs/superpowers/specs/2026-09-02-mote-to-subshell-rename-design.md` — the naming map there is the source of truth; this plan operationalizes it.

## Global Constraints

- Clean cut: NO aliases, NO dual-read fallbacks, NO data migrations in code.
- Work happens on branch `rename/subshell` (already created; spec commit `1a30f20`). Do not switch branches. Do not push. Do not touch the live systemd service, tmux sessions, `~/.config/mote*`, or `apps/backend/data/*.db`.
- **Never edit** (frozen history / non-brand): `docs/superpowers/**`, `.sdd/**`, `.agents/**`, `CHANGELOG.md` historical lines, `bun.lock`, binary files (`*.png`, `*.ico`, `*.jpg`, `*.webp`, `*.woff*`, `*.db*`).
- All content sweeps run over **tracked files only** (`git ls-files`) with the exclusion set above; blind `s/mote/subshell/g` is FORBIDDEN — 582 matches are inside `remote`/`promote`/`remove`.
- Keep `@mote.dev` (real domain in e2e fixtures) and the password `motej` and the literal `RemoteMuxError` unchanged.
- After every task: `bun run verify-types && bun run lint:check && bun run test` must pass (repo trio; matches pre-push). Playwright e2e is NOT run (needs tmux+chromium; per AGENTS.md it's outside the gate) — but `verify-types` covers `e2e/`.
- No new dependencies. Pinned versions only (none change).

**TDD note (plan-wide deviation):** a rename is a refactor — the existing suites ARE the tests. Where a wave is testable-first (tool-name strip, Task 2), do it test-first; bulk content waves update code and tests together, then run the trio.

---

### Task 1: Baseline green

**Files:** none (verification only)

- [ ] **Step 1: Confirm the tree is clean and on the branch**

```bash
git status --short && git branch --show-current
```
Expected: empty status output; `rename/subshell`.

- [ ] **Step 2: Run the full trio on unmodified code**

```bash
bun install
bun run verify-types && bun run lint:check && bun run test
```
Expected: all pass. If baseline is RED, stop — fix or report before renaming anything (a rename can't be blamed for pre-existing failures).

---

### Task 2: Wave 1 — special-case tokens (test-first for tool names)

Context differs from the generic rule in exactly these places; do them BEFORE any bulk sweep.

- [ ] **Step 1: Update the tool-name assertions first (failing tests)**

In `packages/mcp-core/src/__tests__/server.test.ts` (asserts the 14 registered tool names) and `packages/mcp-core/src/__tests__/tools.test.ts` (dispatch tests using `tool: "mote_..."`):

```bash
for n in list_channels create_channel join_channel channel_members post_channel read_channel list_sessions get_session list_profiles create_session restart_session terminate_session delete_session update_session_notes; do
  git ls-files -z 'packages' 'apps' 'e2e' | xargs -0 sed -i "s/mote_${n}/${n}/g"
done
```
This also touches `packages/mcp-core/src/server.ts` registration strings and doc text ("call `mote_list_profiles`…") — that is fine and desired; the test-first order still shows the RED step because `server.test.ts` also asserts tool-list shape assembled from `server.ts` names… if the single sed pass turns the suite GREEN immediately (code+tests changed together), accept it — record which happened.

- [ ] **Step 2: Run mcp-core tests to observe state**

```bash
cd packages/mcp-core && bun test && cd ../..
```
Expected: PASS (names changed on both sides). If any other suite asserted tool names, fix it the same way.

- [ ] **Step 3: Agent config home — `subshell-agent` (NOT plain `subshell`; collision with the server's `~/.config/subshell`)**

In `apps/agent/src/config.ts`, the default home is built from `.config` + `mote-agent`; change the segment to `subshell-agent`. Same for any doc string containing `.config/mote-agent`:

```bash
git ls-files -z | xargs -0 grep -ln "config/mote-agent\|\"mote-agent\"" | head
```
Hand-edit those matches so the agent config-home becomes `subshell-agent` while every OTHER `mote-agent` string (binary/prose/artifacts) stays for the generic rule.

- [ ] **Step 4: Service-unit special cases, in this order**

```bash
git ls-files -z | grep -zv -E '^(docs/superpowers/|\.sdd/|\.agents/|CHANGELOG\.md|bun\.lock)' | xargs -0 \
  sed -e 's/mote-agent\.service/subshell.service/g' \
      -e 's/mote\.service/subshell-server.service/g' \
      -e 's/mote-agent/subshell/g' -i
```
In `svc.sh` additionally: `SERVICE=mote` → `SERVICE=subshell-server`, and its unit `Description=` line should read `subshell-server — agent harness manager (host service)`.

- [ ] **Step 5: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add -A && git commit -m "refactor(rename): wave 1 — tool-name prefix drop, agent home, service units (special cases)"
```

---

### Task 3: Wave 2 — bulk anchored sweep

- [ ] **Step 1: Protect `@mote.dev` via placeholder, run the ordered sweep, restore**

```bash
EXCL='^(docs/superpowers/|\.sdd/|\.agents/|CHANGELOG\.md|bun\.lock)'
BINF='.(png|ico|jpg|jpeg|webp|gif|woff2?|db|db-wal|db-shm|lock)$'
git ls-files -z | grep -zv -E "$EXCL" | grep -zv -E "$BINF" > /tmp/rename-files.z
xargs -0 -a /tmp/rename-files.z sed -i \
  -e 's/@mote\.dev/@MOTEDOTPLACEHOLDER@/g' \
  -e 's/MOTE_/SUBSHELL_/g' \
  -e 's/mote_/subshell_/g' \
  -e 's/Mote\([A-Z]\)/Subshell\1/g' \
  -e 's/mote\([A-Z]\)/subshell\1/g' \
  -e 's/\bMOTE\b/SUBSHELL/g' \
  -e 's/\bMote\b/Subshell/g' \
  -e 's/\bmote\b/subshell/g' \
  -e 's/@MOTEDOTPLACEHOLDER@/@mote.dev/g'
```
Rule order is load-bearing (env prefix before word rule; camel identifiers before/after word rules are order-independent but must run). Do NOT add any rule matching bare `mote` without boundaries.

- [ ] **Step 2: Sanity-check the classic false positives survived**

```bash
grep -rn "RemoteMuxError\|remote-launcher\|0003-remote-ops" --include='*.ts' apps | head -3
grep -rn "motej" e2e | head -2
grep -rn "@mote.dev" e2e apps | head -3
```
Expected: all still present and unchanged (remote/promote/remove words untouched; `motej` intact; domain intact).

- [ ] **Step 3: Verify**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: PASS. **Exception:** if mcp-core pin/identity-store tests fail citing malformed stored chains, stale UNTRACKED fixtures are the cause — purge and let them regenerate, then re-run:

```bash
rm -rf packages/mcp-core/src/__tests__/env apps/backend/.dev/auth /tmp/subshell-* /tmp/mote-*
bun run test
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(rename): wave 2 — bulk anchored mote→subshell sweep (env vars, identifiers, prose)"
```

---

### Task 4: Wave 3 — rename files and directories (git mv)

Content references were already rewritten by Task 3 (paths appear in importers as `subshell-*`); this task makes the filesystem match.

```bash
# shell vars used by this and later tasks — re-declare after a new shell
EXCL='^(docs/superpowers/|\.sdd/|\.agents/|CHANGELOG\.md|bun\.lock)'
BINF='.(png|ico|jpg|jpeg|webp|gif|woff2?|db|db-wal|db-shm|lock)$'
```

- [ ] **Step 1: Rename tracked files/dirs**

```bash
git mv apps/frontend/public/icons/mote-source.svg   apps/frontend/public/icons/subshell-source.svg
git mv apps/frontend/public/icons/mote-maskable.svg apps/frontend/public/icons/subshell-maskable.svg
git mv apps/mobile/src/providers/mote-provider.tsx      apps/mobile/src/providers/subshell-provider.tsx
git mv apps/mobile/src/native/mote-client-factory.ts    apps/mobile/src/native/subshell-client-factory.ts
git mv .idea/mote.iml .idea/subshell.iml
git mv apps/mobile/ios/mote apps/mobile/ios/subshell
git mv "apps/mobile/ios/mote.xcodeproj" "apps/mobile/ios/subshell.xcodeproj"
git mv apps/mobile/ios/subshell/mote-Bridging-Header.h apps/mobile/ios/subshell/subshell-Bridging-Header.h
git mv apps/mobile/ios/subshell/mote.entitlements       apps/mobile/ios/subshell/subshell.entitlements
git mv "apps/mobile/ios/subshell.xcodeproj/xcshareddata/xcschemes/mote.xcscheme" \
       "apps/mobile/ios/subshell.xcodeproj/xcshareddata/xcschemes/subshell.xcscheme"
git mv apps/mobile/android/app/src/main/java/nu/suteki/mote apps/mobile/android/app/src/main/java/nu/suteki/subshell
```
If the hook script exists at `.claude/hooks/mote-hook.sh` (tracked), `git mv` it to `subshell-hook.sh` — then fix the reference in `.claude/settings*.json` if Task 3's sweep missed it (it rewrites string `mote-hook.sh` → `subshell-hook.sh` via \bmote\b, so it should already match).

- [ ] **Step 2: Audit dangling old paths**

```bash
git ls-files | grep -i "/mote\|mote-\|mote\." ; echo ---
git ls-files -z | grep -zv -E "$EXCL|$BINF" | xargs -0 grep -ln "ios/mote\|nu/suteki/mote\|mote-source\|mote-maskable\|mote-hook\|xcschemes/mote"
```
Expected: first command empty except docs/superpowers (frozen) and this plan/spec; second command empty. Fix any hit by hand.

- [ ] **Step 3: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add -A && git commit -m "refactor(rename): wave 3 — git mv icons, mobile sources/provider, ios/android project paths"
```

---

### Task 5: Wave 4 — prose, branding, and generated-icon audit

- [ ] **Step 1: Human-readable pass over the heaviest brand docs/UI**

Read each file top-to-bottom and fix grammar/brand artifacts left by the sweep (e.g. double words, "the subshell subshell", stale headings like "mote's", manifest/`index.html` title now `Subshell`, sidebar wordmark `◆ Subshell`, `apps/frontend/public/icons/subshell-*.svg` `<title>Subshell</title>`, push title "subshell", passkey rpName "subshell", `system@subshell.local`, install-script shell echoes):

```
README.md AGENTS.md apps/agent/AGENTS.md apps/backend/AGENTS.md apps/mobile/AGENTS.md
e2e/AGENTS.md docs/architecture.md docs/overview.md TODO.md
apps/frontend/index.html apps/frontend/public/manifest.webmanifest
apps/frontend/src/components/app-sidebar.tsx apps/frontend/src/components/offline-banner.tsx
apps/backend/src/api/install-script.ts apps/agent/src/cli.ts packages/mcp-core/src/server.ts
```
Control-plane prose uses "subshell-server" where a service-level name is meant (units, svc.sh description); the product/UI brand is "Subshell". Root `AGENTS.md` "Project Overview" must describe binaries as `subshell` (agent) and `subshell-mcp`.

- [ ] **Step 2: Frontend icon regeneration check**

`scripts/gen-icons.ts` references the renamed source SVGs; regenerate to confirm it runs (do not commit dist changes beyond what git tracks):

```bash
cd apps/frontend && bun run scripts/gen-icons.ts && cd ../..
git status --short   # expect: no tracked output changes (outputs are generated pngs, tracked ones identical apart from any brand text)
```
If tracked PNG outputs change (they embed no text, but verify), commit them.

- [ ] **Step 3: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add -A && git commit -m "docs(rename): wave 4 — prose and branding polish for Subshell"
```

---

### Task 6: Wave 5 — residue sweep (the rename-specific gate)

- [ ] **Step 1: Prove nothing brand-sense is left in non-frozen tracked files**

```bash
git ls-files -z | grep -zv -E "$EXCL|$BINF" | xargs -0 grep -in "mote" \
  | grep -viE "remote|promote|remove|demote|automotive|emote|motej|@mote\.dev|subshell"
```
Expected: NO output. (Trailing `subshell` filter kills lines that merely mention the new name next to a false positive; eyeball anything unexpected.) Any hit → fix it, re-run the trio, amend nothing (new commit).

- [ ] **Step 2: Confirm frozen files were NOT touched**

```bash
git diff main --stat -- docs/superpowers .sdd .agents CHANGELOG.md | grep -v "specs/2026-09-02-mote-to-subshell\|plans/2026-09-02-mote-to-subshell" || true
```
Expected: only the spec/plan files added this rename; zero modifications.

- [ ] **Step 3: Commit if step 1 required fixes**

```bash
git add -A && git commit -m "refactor(rename): wave 5 — residue sweep fixes"
```

---

### Task 7: Rollout checklist doc (prepared, NOT executed)

- [ ] **Step 1: Create `docs/subshell-rollout.md`** with exactly this content shape (fill paths from the naming map; every command copy-pasteable):

1. Premise notes: clean cut; running panes die at the tmux socket rename; owner runs this while NOT inside a mote-managed pane (use a plain SSH/shell session).
2. `bun install && bunx turbo build` (fresh dists incl. `subshell`/`subshell-mcp` binaries).
3. Stop the control plane: `systemctl --user stop mote.service`; stop any host agent: `systemctl --user stop mote-agent.service 2>/dev/null || launchctl remove dev.mote.agent 2>/dev/null || true`.
4. Kill orphaned tmux sockets: `tmux -L '' ls 2>/dev/null; pkill -f 'tmux.*mote-' || true` (document that all harness panes end here — accepted).
5. Data migration: `mv ~/.config/mote ~/.config/subshell && mv ~/.config/subshell/mote.db ~/.config/subshell/subshell.db` (+ `-wal`/`-shm` sidecars); `rm -rf ~/.local/share/mote ~/.config/subshell/../mote* 2>/dev/null` (pin/identity stores re-mint; channel E2EE history for old identities is unrecoverable — accepted).
6. Env-file rewrite wherever the service reads them (svc.sh-generated unit + any EnvironmentFile): `sed -i -e 's/MOTE_/SUBSHELL_/g' -e 's|mote\.db|subshell.db|g' -e 's|\.config/mote|/.config/subshell|g' -e 's/mote\.service/subshell-server.service/g' <files>`.
7. Fix DB paths pointing at the old repo dir (after the dir rename below, or with the chosen final path now):
   `sqlite3 ~/.config/subshell/subshell.db "UPDATE sessions SET working_dir=replace(working_dir,'/home/theo/projects/mote','/home/theo/projects/subshell') WHERE working_dir LIKE '/home/theo/projects/mote%';"`
8. Invalidate old-prefix credentials: `sqlite3 ~/.config/subshell/subshell.db "DELETE FROM apiKey WHERE referenceId IS NOT NULL;"` — consult the better-auth api-key table columns first (`.schema apiKey`) and delete the rows whose stored key/start field carries the `mote_` prefix; then re-mint system keys in Settings after boot (session keys re-mint on session start automatically).
9. Install + start the new unit via `svc.sh` (now writes `subshell-server.service`); `systemctl --user daemon-reload && systemctl --user enable --now subshell-server.service`; `systemctl --user disable --now mote.service && rm ~/.config/systemd/user/mote.service` (old unit).
10. Node hosts: re-enroll with the new `/install.sh` output (old `mote-agent` binaries keep dialing but their identities/stores are gone from the server's expected set — delete old node rows in the Nodes page after new enrollments work).
11. Repo dir (last, from outside): `cd ~ && mv projects/mote projects/subshell`; migrate the Claude memory dir `mv ~/.claude/projects/-home-theo-projects-mote ~/.claude/projects/-home-theo-projects-subshell`; reopen the session in the new path.
12. Smoke: sign in (existing session cookie survives — better-auth cookies are baseURL-derived), create a session, verify terminal pane, `mcp__subshell__*` tools listed in a new Claude pane, push notification title "subshell".
13. Rollback note: restore old unit + `mv` dirs back; there is no in-code compat.

- [ ] **Step 2: Verify the doc contradicts nothing (read spec alongside) + commit**

```bash
git add docs/subshell-rollout.md && git commit -m "docs(rollout): live-host rename checklist for subshell (clean cut)"
```

---

### Task 8: Ship — changelog, merge, repo rename

- [ ] **Step 1: CHANGELOG entry (append only; historical lines frozen)**

Add under a new `## [Unreleased]` / next-version heading:
`- **Breaking:** renamed the project from "mote" to "subshell" (clean cut): binaries subshell (was mote-agent) and subshell-mcp (was mote-mcp); all MOTE_* env vars are now SUBSHELL_*; bearer API keys now use the subshell_ prefix (old keys rejected — re-mint); MCP server "subshell" with un-prefixed tool names; systemd units subshell-server.service / subshell.service. See docs/subshell-rollout.md. Followed by a `git log --oneline main..HEAD` skim to write it truthfully.`

- [ ] **Step 2: Final full verification**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: PASS.

- [ ] **Step 3: Merge to local main (repo convention: linear trunk; owner pushes)**

```bash
git checkout main && git merge --ff-only rename/subshell
```

- [ ] **Step 4: Rename the GitHub repo and local remote URL (owner pre-approved)**

```bash
gh repo rename subshell --repo disaresta-org/mote
git remote set-url origin git@github.com:disaresta-org/subshell.git
git remote -v   # expect the new URL
```
If `gh` auth fails, leave remote as-is and append a step to docs/subshell-rollout.md instead.

---

## Self-review notes (author, 2026-09-02)

- Spec coverage: naming map rows → Task 2 (specials), Task 3 (bulk incl. env vars, key prefix, tools docs, mobile ids, tmux socket, localStorage/SW, Docker, system email, VAPID, passkey), Task 4 (file/dir renames incl. icons/ios/android/hook/iml), Task 5 (branding prose + manifest + install script), Task 6 (residue gate + frozen-file audit), Task 7 (rollout incl. tmux orphan handling, DB path fixes, key re-mint, memory-dir migration), Task 8 (changelog, gh rename, merge). Workspace scope `@internal/*` intentionally untouched (spec non-rename).
- Deviation from spec, adopted deliberately: `@mote.dev` kept via placeholder-protection exactly as spec's non-rename list requires; `bun.lock` never touched (no package renames → stays valid).
- Stale-state nuance: `workflow-ids.json`/identity/pin stores are UNTRACKED — verified absent from `git ls-files`; hence "delete and regenerate" (Task 3 step 3, Task 7 step 5), no fixture editing anywhere.
