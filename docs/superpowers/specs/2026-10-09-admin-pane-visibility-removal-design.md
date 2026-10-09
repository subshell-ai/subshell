# Admins no longer see (or touch) unshared panes

Date: 2026-10-09. Operator ruling: the subshell axis stops reading the admin
role. A pane is visible and operable by its owner and by explicit shares only
— exactly the rule a non-admin already lives under. Supersedes the §3
"admins see everything" arm and the UI signal this started as (an admin's
second account read its admin-wide rail as a leak).

## Why

The reported confusion: a second admin account saw five foreign panes under
an "unknown node" header. The visibility code leaked nothing — the account
was an admin and admins see every subshell by design (§3). But the design
asked the rail to look ordinary while quietly widening it. The operator's
answer is not a caption saying "admin view"; it is to remove the widening.

## Behavior after

For every actor — cookie admin included — a subshell reads:

1. owner → `owner`;
2. else an Everyone grant or a grant naming the viewer → its permission;
3. else → `none`: absent from the list, 404 on detail/log/terminal/input/exec/
   terminate, absent from `/ws/live`, byte-identical to a stranger's answer.

Admin remains instance management exactly where it already lived: users,
roles, settings, providers, plugins, network, status, node approval/config
for `local`. Nothing on other axes changes.

Consequences the operator accepted:

- No UI surface can see, stop or terminate another account's pane. Remedies:
  sign in as that user, the node CLI under the owner's OS user, or node
  `maintenance on` (terminates every pane on the machine — a NODE act,
  owner/admin-gated, unchanged).
- `/api/nodes` was already share-scoped; with `/api/subshells` now share-
  scoped too, the two agree and the "unknown node" header can only mean
  "a machine you cannot see" — which is why the label is renamed, below.

## Server changes (one rule, four sites)

1. `db/repositories/subshells.repository.ts` — `listVisibleTo(viewerId)`:
   drop the `isAdmin` parameter and its WHERE-bypass; the owner/grantee/
   Everyone filter becomes unconditional. Both service callers follow.
   Foreign-private rows keep answering 404 (the probe-defense doc stands).
2. `lib/subshell-access.ts` — `resolveSubshellAccess(viewerId, ownerUserId,
   shares)`: drop the `isAdmin` parameter and the `if (isAdmin) return
   "edit"` arm; order is owner → grants → none. `loadSubshellAccess`'s
   `allowAdminAndShares` option becomes `allowShares` (bearer strictness:
   `false` still means the owner's OWN subshells, shared or not, grants
   never counted); the now-unnecessary
   `getRole` read inside it goes.
3. `services/subshells.service.ts` — `listSubshells` and the second
   `listVisibleTo` caller stop reading `getRole` for visibility; the
   per-row `resolveSubshellAccess` calls drop the flag. Doc-comments at
   the maintenance/terminate notes that cite "the admin boost" are rewritten
   (share-holders at `edit` still reach those 403-not-404 paths).
4. `ws/live-topics.ts` + `ws/live-ws.ts` — `ADMINS_TOPIC` is DELETED.
   `topicsForViewer({ viewerId })` returns `[userTopic, EVERYONE_TOPIC]` for
   everyone; `recipientTopics` drops its admins arm (an admin owner arrives
   via `userTopic`, an admin grantee via the grant — the double-delivery
   invariant the old doc measured still holds because there is no second
   subscription anymore). `live-ws` loses its `isAdmin` dependency.
   Role-change socket drops stay (they protect every other axis).

Out of scope (named so nobody "consistents" them later):
`services/files-path-rules.ts` admin read (filesystem axis, §-documented
separately), transfers (already boost-free by design), channels, prompts,
presets-as-resources, `/api/nodes`, and the bearer `GET /api/subshells`
owner-share enumeration the MCP-sibling ruling pinned (that arm never
consulted admin anyway — it must keep passing).

## SPA changes

- No list code changes: the rows simply stop arriving.
- `lib/subshell-node-groups.ts` — `nodeLabelFor`'s answered-without-id arm
  relabels "unknown node" → "node you can't see" (its real meaning for the
  revoked-share case that survives on both roles; the never-answered
  short-id arm stays). Update the docblock ladder, the HUD's
  `?? "unknown node"` fallback string, and every test pin.
- The rejected design (a) — an "admins see everything" caption — is moot and
  is NOT built.

## Docs and pins that move TOGETHER (repo rule: test + §3 in one change)

- `docs/security.md` §3 (admin-sees-everything → owner+grants), §11.14's
  feed-audience sentence, and any §11 mention of instance-wide pane edit.
- `.claude/rules/security-context.md`: the "admin = instance-wide edit"
  bullet, the per-subshell-routes boost bullet, the `/ws/live` bullet.
- `apps/server/api/AGENTS.md` if it narrates the boost.
- Tests: `subshells-list-visibility.test.ts` rewritten to pin admin-equals-
  stranger (and keeps the bearer-arm pin); `ws/__tests__/live-topics.test.ts`
  without ADMINS_TOPIC (the exhaustive row↔viewer diff remains THE control);
  route/service tests asserting admin foreign-pane edit/404 behavior;
  `e2e/11-subshell-sharing` if it asserts the wide read; `lint:design` +
  web group tests for the relabel.
- Changesets: one `@internal/server` MINOR (behavior change users feel),
  wording ride-along in the same file for the label.

## Verification

Focused: `subshells-list-visibility`, `live-topics`, touched route suites,
`provider-dialog`/group files; then boundary trio + `bun run test
--filter=@internal/server --filter=@internal/server-web`, `e2e` sharing
spec, review loop until clean.
