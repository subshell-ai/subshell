# Node ↔ Profile pairing at launch (Design 2026-09-02)

> **Superseded in part 2026-09-13 by
> [2026-09-13-presets-design.md](2026-09-13-presets-design.md).** The PIN half
> is dead: presets carry no `node_id`, the launch form lost its
> `suggestDecision` state machine, and node compatibility is decided by the
> agent chosen first. What lives on is the pairing itself — greyed never
> hidden, node-aware usability — now rendered by the Agent picker. The profile
> naming throughout is historical; that word is preset now.

**Problem.** The new-session form asks for a Profile before a Node, yet a profile
is only launchable where its harness is enabled + installed. The profile list is
filtered by LOCAL usability only (the phase-1 note in `profiles.route.ts`), so
Node B + a Local-only profile is discovered at submit time by a 409
`harness_disabled`. Separately, the global Settings → "Harness plugins" card
frames local-harness toggling as an instance-wide setting even though per-node
toggles already exist on the node detail page (`NodeHarnessCard`).

**Delegation note.** The product owner set the direction (node-aware pairing,
settings move) through a Q&A round, approved the client-side-matrix approach,
and delegated every remaining call ("make the decisions you think are best").
Each ruling is marked **RULING**.

## 1. New-session form: paired, searchable pickers

`new-session-form.tsx` (shared by `/new` and the workspace dialog) becomes:

```
Node      [searchable combobox]   ← first
Profile   [searchable combobox]
Working directory
Session name (optional)
```

- **RULING — Node field moves above Profile.** The original request ("ask
  which node first") stands as the default reading order; pairing works in
  whichever order the user actually clicks.
- **Either can be picked first.** Each selection re-filters the other list
  live; both directions are computed client-side (§2).
- **Incompatible options are greyed, never hidden** (owner's choice), each with
  a muted reason rendered inside the option row:
  - profile greyed under node N: `harness not installed on this node` /
    `disabled here` — chosen from `N.harnesses` state (§2);
  - node greyed under profile P: `no <harnessId> here` (missing entry, or
    `enabled && installed` false);
  - the existing offline rule composes on top: an offline agent stays disabled
    with ` — offline` in its label.
- **Searchable.** **RULING:** a new shared primitive
  `components/ui/combobox.tsx` wrapping Base UI `Combobox` (v1.7.0 ships it —
  verified in `node_modules`), styled from the existing `select.tsx` wrapper.
  Its props mirror the Select usage the form needs: `id`, `value`,
  `onValueChange`, `placeholder`, and items `{ value, label, disabled?, reason? }`
  (also fed to the Base UI `items` map so the closed state renders the label).
  The e2e-pinned element ids (`picker-profile`, `picker-node`, plus `/new`'s
  own set) move onto the combobox's focusable input; option label strings keep
  their exact current format where e2e asserts them
  (`${profile.name} (${profile.harnessId})`).
- **Node options carry the platform.** `nodeOptionLabel` gains os/arch when
  both are present: `mac-mini · darwin/arm64`, `Local · linux/x64`. The
  function stays the single source for the closed state and the items map
  (its contract comment). `local` gets real os/arch from §4b, so the label is
  never `Local · null/null`; a node that has never reported (young agent)
  falls back to today's name-only label.
- **Pin = suggestion** (owner's choice, replacing the current anchor-with-
  override semantics):
  - selecting a profile pinned to node X preselects X **iff X is selectable
    and compatible with that profile** (pure `anchorDecision` is replaced by a
    pure `suggestDecision` — same "explicit pick since the profile change"
    bookkeeping, but the suggestion never parks the form on an incompatible or
    offline node);
  - the pinned option is suffixed ` · default for this profile`;
  - every other compatible node remains selectable, and the current
    `This profile runs on X — it overrides Local.` hint is **deleted** — the
    visible pick is now always what launches (§3).

- **RULING — empty-state guidance.** If the chosen node has zero compatible
  profiles: a muted line under the Profile field —
  `No profiles run on <node> — enable a harness on it or create a profile`,
  with the node name linking to `/nodes/<id>`. Symmetrically, a profile whose
  harness runs on zero visible nodes says so.
  The pair-validity rule is deliberately soft: `canSubmit` keeps requiring
  only the three non-empty fields — the form never silently mutates the other
  selection when a pick becomes incompatible (e.g. a background refetch flips
  a node's inventory); it shows the invalid pick greyed-reasoned in the closed
  state and lets the server's 409 (already mapped by
  `create-session-error.ts`) be the backstop for races. This keeps the
  existing "the pick list can always be stale" posture.

## 2. Compatibility model (client-side matrix)

A new pure module `apps/frontend/src/lib/session-compat.ts`:

```
profileFitsNode(node: Node, harnessId: string):
  | { ok: true }
  | { ok: false; reason: "not-installed" | "disabled" }
```

Rule (mirrors the server's `agentHarnessUsable`/`harnessUsable` informational
shape): the node's `harnesses[]` entry for `harnessId` with `enabled &&
installed`. Absent entry ⇒ `not-installed`. `NodeHarness[]` and
`inventoryStale` already ride `GET /api/nodes` for every visible node
(`list-nodes.route.ts` → `toNodeViews`), so **no per-node fetch is added** —
the matrix needs zero new endpoints beyond §4a.

- When `node.inventoryStale` and the reason is `not-installed`, the option
  copies append `(inventory may be outdated)` — the last-known truth must not
  read as a fact.
- **The server stays authoritative**: the strict gate
  (`sessions.service.ts` → `harnessUsable` → 409 `harness_disabled`) is
  unchanged and remains the only correctness guarantee.

The form fetches profiles with `?node=any` (§4a) — the whole point is that
profiles unusable on Local but usable on an agent must appear.

**What does NOT change:** `useRecentPaths(nodeId)` prefill behavior (a
mid-mount node switch still never yanks typed input), `canSubmit`, the
`emptyNewSessionForm` defaults (`nodeId: "local"` stands until the list says
otherwise), and the working-dir/name fields.

## 3. Wire change: the visible pick always wins

`use-create-session.ts` → `toSessionCreateBody` stops omitting `nodeId` for
`"local"` and always sends the currently selected node id. Consequences:

- an explicit Local choice on a pinned profile genuinely launches on Local
  (server precedence already puts body `nodeId` first — no backend change);
- the pin still works for clients that OMIT `nodeId` (mobile, API callers) —
  the server-side ladder (body → pin → local → single-agent auto-pick) is
  untouched;
- a pick re-homed by `pickNodeDefault` (e.g. "exactly one selectable node")
  now rides the wire explicitly — same resolved node, honest payload.

## 4. Backend (two additive changes)

**a. `GET /api/profiles?node=any`.** Optional query param `node`:

- absent → today's behavior exactly (filter by `usableHarnessIds()` — local
  probe; keeps mobile, the profiles admin page, and the `list_profiles` MCP
  projection unchanged);
- `"any"` → no harness-usability filter: every row of `listByUser` (bearer
  redaction rules unchanged). This is what the new-session form fetches.

**RULING:** `?node=<specificId>` (server-side per-node filtering) is NOT built
— YAGNI: the form needs the full list plus per-node states for bidirectional
greying anyway, and `GET /api/nodes` already carries those states.

**b. `local` os/arch in the view.** `nodeViewBase` (`api/nodes/node-view.ts`)
overrides `os`/`arch` for `kind === "local"` rows with the server's own
`process.platform` / `process.arch` (the canonical `linux`/`darwin` ×
`x64`/`arm64` spellings — the same values the agent reports). No migration,
no seed change: the DB row stays null, the VIEW is honest. Fixes the label
gap that would otherwise make §1's platform suffix impossible for Local.

## 5. Settings page: drop the global "Harness plugins" card

- Delete the Card block from `settings.tsx` (and the now-unused local wiring:
  `harnessErrors`/`toggleHarness`/`recheck` state in that page only).
- **Keep everything shared:** `GET/PATCH /api/setup/harnesses` (the setup
  wizard's first-run flow), `HarnessRow`, `use-harness-toggles.ts`,
  `useHarnesses` (profile-fields + NodeHarnessCard read it).
- Local harness toggling now lives solely on `/nodes/local`
  (`NodeHarnessCard` already renders there; `patch-node-harness.route.ts`
  already routes `local` through `toggleLocalHarness`, seeding Default
  profiles on enable). Access parity: the card gated on any cookie session;
  `canConfigure` on `local` is owner|edit, and the seeded Everyone/`edit`
  share gives the same audience. Disabling local launching (LocalLaunchCard)
  still narrows it to admins.
- No new copy needed on the Nodes pages — the detail page already explains
  the matrix. If the empty Settings section leaves an ordering comment stale,
  fix the comment, not the layout.

## 6. Out of scope (deliberate)

- **Mobile** (`apps/mobile`): keeps omit-`nodeId` semantics (pin ladder still
  applies server-side) and default `GET /api/profiles` filtering (unchanged).
  The web-only `node-anchor.ts` mirror drifts a little (no suggestion label,
  no pairing) — acceptable; a mobile pass is follow-up work.
- **Profile authoring stays local-gated**: `POST /api/profiles` still refuses
  a harness not usable on Local (`profiles.route.ts:86`) and pin validation
  stays visibility-only. Making the profile editor node-aware is the natural
  next slice; it is NOT needed for launch pairing to be correct (you can only
  ever have profiles that exist, and §1 explains where they run).
- **Node-scoped profile filtering server-side** (§4a ruling).
- Manual restart's deliberate no-recheck behavior: unchanged.

## 7. Testing

Frontend (`bun test`, happy-dom):
- `lib/__tests__/session-compat.test.ts` — the matrix: enabled∧installed,
  each failure mode, absent entry, stale-inventory note (composition), the
  helper is the single source the option-reason strings format from.
- `suggestDecision` matrix in the existing `new-session-form` test file —
  suggestion earned/not-earned, explicit pick outranks, suggestion never lands
  on incompatible/offline, release falls back to `pickNodeDefault`.
- `nodeOptionLabel` — platform suffix present/absent, offline composition,
  local label.
- `toSessionCreateBody` — `nodeId` always present incl. `"local"`.
- Combobox primitive smoke test (opens, filters, disabled item + reason text),
  mirroring the existing `select`-style component tests.

Backend:
- profiles route — `?node=any` returns a profile whose harness is disabled
  locally; absent param still hides it (regression pair).
- node view — `local` row reports non-null os/arch matching the server.

E2E (`bun run test:e2e`, manual gate — not in pre-push): `05` (dialog), `06`
(`/new` lifecycle), `12` (remote launch through `/new`) — update the picker
interaction to the combobox (click input, optional type, click option);
assert the new greying path once (06 or 12: pick the node lacking the
harness, expect the disabled option + reason).

## 8. Verification

Standard trio after implementation: `bun run verify-types`, `bun run
lint:check`, `bun run test`; `turbo build` (backend route + schema touched →
`@internal/backend-client` type re-inference); targeted e2e as §7.

## 9. Doc touch-ups

- `new-session-form.tsx` header comment (pairing + suggestion replace the
  anchor/override narrative; mobile-mirror notes trimmed to what still holds).
- `node-label.ts` contract comment (platform suffix).
- `use-create-session.ts` comment (nodeId always on the wire; pin ladder
  remains for omitting clients).
