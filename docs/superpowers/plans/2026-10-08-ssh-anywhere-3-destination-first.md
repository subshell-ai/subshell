# SSH Anywhere - Plan 3: The Destination-First UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Milestone 1's human half: a `Connect` page that leads with the destination question ("where do you want to work?"), feeds itself from the chosen machine's aliases plus saved and recent hosts, launches the SSH pane with one button, names the gate remedy in copy, and shows an SSH-terminal pane as view-only to everyone but its owner.

**Architecture:** The server already owns every rule (tier 2's `/api/ssh` surface, the owner-only input predicate, the WS `canInput` stamp). This tier adds ONE server behavior - the per-viewer `access` in subshell views downgrades to `view` for non-owners of an ssh pane, so every client's existing `access === "view"` posture (input disabled, read-only terminal) becomes truthful for free - and then thin UI: a `use-ssh` hook set following `use-prompts`, a `/connect` route following the launch-form patterns, a SearchableSelect destination field, and the disclosure copy spec §11 demands.

**Tech Stack:** Bun + TypeScript, Elysia (`t` schemas with descriptions), TanStack Router (file-based) + React Query, Tailwind with the design-system role tokens, `@internal/node-admin`'s `apiFetch`/`apiPost`, Playwright e2e.

## Global Constraints

- Work ONLY in `/home/theo/projects/wt-ssh-anywhere-3` (branch `feat/ssh-anywhere-3`). Never touch other checkouts.
- Tests: `env -u SHELLOPTS -u BASHOPTS bun test <files>`; check the reported file count.
- No U+2014/U+2013 anywhere (`bun run lint:prose` scans shipped strings and docs; UI copy too).
- Design system (`docs/design-system.md` enforced by `bun run lint:design`): role tokens only (`text-label font-strong`, `text-detail` via its spellings in that doc), **UI explanations at most two sentences, no em dashes in copy**, required input gold `*` + gold caption when empty, hard errors `text-destructive` red (`fieldErrorToned` from `src/lib/form.ts:88` reads the split), 4px grid, no 12px.
- Terminology is exactly three nouns (spec §11): **destination**, **connecting machine**, **key source**. Key source does not appear in this tier's UI (M2); do not invent it.
- The disclosure obligation (tier 1's engine note, satisfied server-side by the route descriptions in fe125346): the UI copy must say, before the button, in at most two sentences, that resolving runs `ssh -G` on the connecting machine and a hidden `Match exec` can run a local command.
- Route-level: `/api/ssh` response shapes are already typed by `apps/server/api/src/api/ssh/ssh-views.ts` - the SPA's local view types must mirror them field-for-field (the SPA's house style: local `lib/*.ts` types + `apiFetch<T>`, mirroring `lib/prompts.ts`).
- Focused verification while iterating; the full `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` at Task 6 only. `bunx turbo build` whenever `apps/server/api` schemas changed (treaty/dist consumers) and before e2e (it serves the web dist - memory).
- Commit as theo@suteki.nu; push only at Task 6.

## File Structure (map)

```
apps/server/api/src/api/models.ts                          # MODIFY: SubshellSchema gains ssh: boolean
apps/server/api/src/services/subshells.service.ts          # MODIFY: viewer-relative access downgrade for ssh panes (ONE helper, both view paths)
apps/server/api/src/api/subshells/__tests__/...            # MODIFY: view-access tests extended
apps/server/web/src/lib/ssh.ts                             # CREATE: view types mirroring ssh-views.ts + copy constants
apps/server/web/src/hooks/use-ssh.ts                       # CREATE: queries/mutations (aliases/saved-hosts/preferences) + useLaunchSsh
apps/server/web/src/components/connect/connect-panel.tsx   # CREATE: the destination-first flow
apps/server/web/src/components/connect/saved-hosts-section.tsx # CREATE: saved/recent ledger (delete + save toggle)
apps/server/web/src/routes/connect.tsx                     # CREATE: createFileRoute("/connect")
apps/server/web/src/components/sidebar/sidebar-nav.ts      # MODIFY: top-level Connect entry (unique icon, icons test)
apps/server/web/src/components/subshell-terminal.tsx       # MODIFY: SSH badge + view-only sentence for non-owners
apps/server/web/docs/connect-page.md                       # CREATE: the 3-sentence surface doc
packages/node-admin/src/types/node.ts                      # MODIFY: sshEnabled? on the shared Node type IF the panel needs it (it does: gate display)
e2e/tests/23-connect-flow.spec.ts                          # CREATE: the Playwright proof
.changeset/ssh-destination-first-ui.md                     # CREATE at Task 6
```

## Decisions this plan has already made (do not relitigate)

1. **Access downgrade, not a new flag:** `SubshellView.access` is the client's single truth (terminal: `readOnly = access === "view"`, subshell-terminal.tsx:567). For an ssh row, a non-owner whose resolved access is `edit` receives `view` in the VIEW layer only; every enforcement seam (REST/exec/WS/nudge) is already server-side from tier 2 and unchanged. `SubshellSchema` gains `ssh: boolean` (derived `row.ssh !== null`) so the terminal can label the pane; the snapshot itself stays never-serialized (its db-types doc).
2. **One page, three steps, §11's order:** destination field first (SearchableSelect fed by saved + recent + the machine's aliases + free text), machine follow-up as a disclosure line ("Connect from …") defaulted to the preference; NO key-source affordance (M2). With no default machine set and more than one SSH-enabled machine, the machine disclosure is required-with-gold-asterisk, never silently chosen (spec §7). With exactly one usable machine, it is pre-selected honestly and still shown.
3. **Gate-off is a named remedy, never a hidden option:** machines whose `sshEnabled` is false stay VISIBLE in the machine disclosure but disabled with a `reason` (the SearchableSelect `ComboboxOption.disabled/reason` fields), and the panel copy names the remedy: "SSH is off on <name>. Ask <owner> to enable it." (owner display name from the node row's fields the SPA already reads; for `local`, "You can enable it in Server Settings" is wrong - admins only: use "An admin can enable SSH on this machine in its settings." - pick by `isAdmin` if the client already knows it; otherwise the generic sentence).
4. **Launch is one POST:** `{node, destination}`; the 422 `outcome` refusal renders the blocked settings verbatim in red under the field; SSH_GATE_OFF 403 renders the remedy; 409 held/offline name their own cause. Success navigates to `/subshells/$id` exactly like `launch-subshell-dialog.tsx:49-55`.
5. **Remembering a host is automatic recency + explicit save:** every successful launch already touches the row (tier 2); the panel offers "Remember this destination" (PUT) and the saved section lists saved + recent with delete (DELETE) and the default-machine PATCH ("Use by default" radio-ish control on the machine disclosure).
6. **The disclosure copy (exact, shipped verbatim, under the destination field, `text-detail`):** "Resolving asks the connecting machine to read its SSH config. A hidden Match exec in that config can run a local command while it resolves." - two sentences, no em dashes, matching the route descriptions' substance.

---

### Task 1: Server - `ssh` on the view + the non-owner access downgrade

**Files:** Modify `apps/server/api/src/api/models.ts` (SubshellSchema beside `access` at :64), `apps/server/api/src/services/subshells.service.ts` (the list view ~:655-675 and the single-row view used by GET detail + launch), new tests in the existing view test home (`grep -l "access" apps/server/api/src/api/subshells/__tests__/` - extend the file that asserts the access stamping; if none, add `subshell-view-ssh.test.ts`).

**Interfaces:**
- Produces: `SubshellView.ssh: boolean`; and a helper `effectiveViewerAccess(row, access): Access` (module-private is fine, exported for test) that maps `access === "edit" && row.ssh !== null && row.userId !== viewerId` to `"view"` - owner and non-edit stay as resolved. Both view paths (list + get) pass through it. MCP `list_subshells`/detail ride the same views: one change, both doors.
- Consumes: the row's `ssh` column (migration 0048).

- [ ] Step 1: failing tests - a row with `ssh` JSON + an edit grantee's GET detail + GET list see `access: "view"` and `ssh: true`; the owner sees `access: "owner"`, `ssh: true`; an ordinary pane's edit grantee is UNCHANGED (`access: "edit"`); a view grantee was already `view`.
- [ ] Step 2: run, watch fail (unknown key ssh / access unchanged).
- [ ] Step 3: implement `ssh: t.Boolean({description: "True when this pane is an SSH-terminal pane: only its owner can type into it."})` in SubshellSchema + mapper `ssh: row.ssh !== null` (locate `toSubshellView` at subshell-manager.service.ts:2158 - the schema lives in models.ts; keep schema and mapper edits paired); the access helper applied at the two sites.
- [ ] Step 4: focused tests green; `bunx turbo build` (treaty consumers); `bunx turbo verify-types --filter=@internal/server`; biome; commit `"feat(api): ssh panes read as view-only in subshell views for everyone but their owner"`.

---

### Task 2: SPA plumbing - types, hooks, nav entry

**Files:** Create `apps/server/web/src/lib/ssh.ts`, `apps/server/web/src/hooks/use-ssh.ts`; modify `apps/server/web/src/components/sidebar/sidebar-nav.ts` (top-level entry after "Subshells": `{ to: "/connect", label: "Connect", icon: Cable }` - pick a lucide icon NOT already used in the nav (the icons test pins global uniqueness; read `components/__tests__/sidebar-nav.test.ts` and the current icon set first)); extend the Node type the SPA reads (grep `sshEnabled` in packages/node-admin/src/types/node.ts - add the boolean the node view already serializes, with the same comment class as its siblings).

**Interfaces:**
- Produces (`lib/ssh.ts`): `SshSavedHost { id, destination, alias, nodeId, savedAt, lastConnectAt }`, `SshSavedHostsView { saved: SshSavedHost[]; recent: SshSavedHost[]; defaultNodeId: string | null }`, `SshAliasesView { aliases: string[]; includeCycle: boolean; truncated: boolean }`, `SshResolveOutcome` mirroring ssh-views' union, `SshLaunchResponse { subshell: { id: string } }` (only what the panel consumes); the refusal copy strings are NOT here (they are built in the panel from codes).
- Produces (`hooks/use-ssh.ts`, all following `use-prompts.ts` exactly): `useSshSavedHosts()` (key `["ssh-saved-hosts"]`), `useSshAliases(nodeId: string | null)` (key `["ssh-aliases", nodeId]`, `enabled: nodeId !== null`), `useSaveSshHost()`, `useDeleteSshHost()`, `useSshPreferences()` mutation, `useLaunchSsh()` - mutations via `apiPost`/`apiFetch`-POST helper the file uses; launch invalidates `["ssh-saved-hosts"]` (recency moved) only.
- Consumes: `/api/ssh/*` routes (task inventory: GET aliases?node=, GET saved-hosts, PUT saved-hosts, DELETE saved-hosts/:id, PATCH preferences, POST launch).

- [ ] Step 1: extend the nav test (failing: no Connect entry) + a small type-shape compile test if the lib has a sibling pattern (check `lib/__tests__` style; a plain `tsc`-covered type file needs no runtime test - do not invent vacuous ones).
- [ ] Step 2: implement; nav icon uniqueness green; `env -u SHELLOPTS -u BASHOPTS bun test apps/server/web/src/components/__tests__/sidebar-nav.test.ts`; biome; verify-types @internal/server-web; commit `"feat(web): ssh surface plumbing - types, hooks, and the Connect entry"`.

---

### Task 3: The /connect page

**Files:** Create `apps/server/web/src/routes/connect.tsx`, `components/connect/connect-panel.tsx`, `components/connect/saved-hosts-section.tsx`; co-located `__tests__` (jsdom component tests - follow the existing `components/__tests__/` style; check what render helper they use).

**Behavior contract (each a test):**
1. Machine disclosure: options from `useNodes()` filtered to `launchable` (reuse `launchableNodes` from `lib/subshell-compat` exactly as new-subshell-form.tsx does), each option `disabled: !n.sshEnabled` with `reason: "SSH is off on this machine"`; the default from `defaultNodeId`; unset preference + several enabled machines => required (gold `*`, `fieldErrorToned` gold caption when untouched-submit); exactly one => pre-selected.
2. Destination field: `SearchableSelect` (ui/combobox.tsx; props as the launch form uses them) grouped: Saved (`label = alias ?? destination`), Recent, `From <machine>'s config` (aliases, fetched only while a machine with the gate ON is picked); free text allowed = the field accepts a typed host not in any list (how: the combobox's input value as candidate - mirror how the working-directory field takes free text, read directory-picker-input.tsx's posture); selecting an item keeps destination semantics client-side ONLY for display, the SERVER resolves (no pre-resolve step; §11's "the common case just opens").
3. Connect button: `useLaunchSsh` POST; loading state is the button's own disabled+label swap (design-system rule: no spinners elsewhere? check the launch dialog's precedent and match it); on 201 `navigate({ to: "/subshells/$id", params: { id } })`.
4. Refusals: 422 -> red line: `Config needs settings Subshell does not run: ${settings.join(", ")}. Edit them on the connecting machine and retry.`; 403 SSH_GATE_OFF -> the named-remedy sentence (decision 3); 409 -> the held/offline sentence; each maps from the ApiErrorResponse `code` (read the launch route's real response map in apps/server/api/src/api/ssh/launch.route.ts and name every branch).
5. Disclosure (decision 6's exact two sentences) under the destination field, `text-detail`.
6. "Remember this destination" checkbox, unchecked by default (every launch is already recent server-side; remembering is the explicit act). Label: "Remember this destination"; on a successful launch with it checked, PUT saved-hosts `{node, destination, alias?}` where alias is sent only when the pick came from the machine's config list (an alias token), per §7's alias-is-display rule.
7. Saved section: two lists (Remembered, Recent) rendered as label-over-detail lines, each remembered row a delete button; recent rows a save (star?) button; empty states are one short sentence each ("No destinations yet. Pick a machine to see its aliases.").
8. Route + a11y: `createFileRoute("/connect")`, page heading role `heading`, no dialog titles involved; all copy passes the two-sentence + no-em-dash scan (`bun run lint:prose` + the UI strings).

- [ ] Steps: tests-first per brief (render the panel with mocked hooks - follow existing component-test mocking style), implement, focused green, biome, `bun run lint:design` clean (it's a pre-push check but run it now), verify-types, commit `"feat(web): the destination-first Connect page"`.

---

### Task 4: The terminal's ssh affordances

**Files:** Modify `apps/server/web/src/components/subshell-terminal.tsx` (+ its test file if one asserts the header).

**Contract:** when `subshell.ssh === true`: (a) a small "SSH" badge/label in the pane header row (role `detail`, matching the node/badges posture the header already renders - read the header JSX first); (b) for `access === "view"` AND `ssh`: the header detail line reads "SSH sessions take input from their owner only." (one sentence, `text-detail`); non-ssh view grantees keep today's silence (do NOT restate the general view rule here; out of scope creep); (c) owner: nothing extra (the pane works as today).

- [ ] Steps: failing component assertions, implement, focused green, biome, commit `"feat(web): ssh panes label themselves and tell viewers why typing is off"`.

---

### Task 5: e2e - the Playwright proof

**File:** Create `e2e/tests/23-connect-flow.spec.ts`. Read first: the SPA-driving specs (grep routes `/new` or nodes pages in e2e/tests for the login/navigate helpers) and reuse spec 22's fixture recipe (`e2e/fixtures/sshd.ts`) with the SAME isolated backend boot so the alias exists.

**Scenario:** admin cookie session; `PUT /api/nodes/local/ssh-enabled on`; UI: navigate to `/connect`, machine shows `local`, destination picker shows the fixture alias among "From local's config"; pick it, Connect; assert redirect to `/subshells/<id>` and the terminal shows the pane (reuse spec 22's sshd "Starting session" settle before typing `echo CONNECT-OK`); assert the log. Then a second user with an EDIT share (REST) opens the SAME pane URL: the terminal renders read-only, the SSH detail line names the rule, typing does nothing (log unchanged; the REST 403 is tier 2's, this proves the client posture). Then toggle the gate back off via REST, reload `/connect`: `local` is disabled with the reason, the remedy sentence appears when it is selected anyway (design the exact interaction so this is testable).

- [ ] Steps: write, run ONLY this spec (`bun run test:e2e 23-connect`), iterate; remember `bunx turbo build` first (e2e serves web dist - memory); commit `"test(e2e): connect flow end to end - destination-first launch and the view-only pane"`.

---

### Task 6: Boundary - docs, verification, PR, review loop

- [ ] `apps/server/web/docs/connect-page.md`: the 3-sentence class doc (what leads, what the machine disclosure is, what refusals say), matching `launch-form-picker.md`'s voice.
- [ ] Full trio + prose + tests; `bunx turbo build` fresh; changeset `@internal/server` minor + `@internal/server-web` minor; push; `gh pr create --base feat/ssh-anywhere-2`; no auto-merge.
- [ ] Whole-branch review (opus) rounds until zero C/I/M; fix waves folded; final head pushed.
- [ ] Copy the review-disposition list into `$(git rev-parse --git-path sdd)/progress.md` as you go.
