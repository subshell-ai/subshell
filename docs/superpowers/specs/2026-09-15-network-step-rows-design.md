# The wizard's Network step: collapsed rows with a Configure button

**Date:** 2026-09-15
**Status:** approved, ready to build
**Amends:** `2026-09-15-network-plugins-design.md` § 6 (the first-run step)

## 1. The defect

The Network step of the first-run wizard renders every network plugin as a
full `NetworkPluginCard` in `compact` mode, split into two groups: networks
whose vendor CLI is already on this machine, and a `<details>` disclosure
titled **"Other networks"** holding the rest. On a machine with nothing
installed — which is every fresh install — the top group is empty, the
disclosure opens by default, and a person sees a heading that is relative to
nothing, followed by two numbered sudo commands, three "Docs" links and a
Re-check button, for a step whose framing says it is optional.

Three more things wrong on that same screen, each found while reading it:

1. **The Tailscale icon does not render.** The file is seeded correctly to
   `<dataDir>/plugins/tailscale/icon.svg`, but `readPluginIcon` in
   `apps/server/api/src/api/plugins.route.ts` resolves the manifest's icon
   path through `getHarness(id)`, and the registry keeps network plugins in a
   separate list (`getNetworkPlugin`). The lookup returns `undefined`, the
   route 404s, and the card falls back to the "T" monogram.
2. **"Let this server drive it"** is spec vocabulary that leaked into
   user-facing copy. It names the Tailscale `--operator` grant, which is
   what lets a non-root process issue `tailscale` commands. Nobody reads
   "drive" that way.
3. **The step conflates "the plugin is here" with "the network is set up".**
   The plugin is a built-in, seeded at boot like the harness plugins. What
   is missing on a fresh machine is the vendor's daemon, and nothing on the
   screen says which of the two it is talking about.

## 2. The design

### 2.1 One row per network, collapsed

The step renders a single `<ul>`, one `<li>` per network, in the shape the
next step's `AgentRow` already uses: icon, name, a state chip, and one
button on the right. Nothing else is visible until asked.

The chip is derived from the row exactly as `NetworkPluginCard` derives its
state, so the two never disagree:

| condition | chip |
|---|---|
| `!row.supported` | "Not available on this platform" |
| `!row.enabled` | "Disabled" |
| `status === undefined` | "Not checked yet" |
| `state === "not-installed"` | "Not installed" |
| `state === "daemon-down"` | "Daemon not running" |
| `state === "needs-privilege"` | "Needs permission" |
| `state === "needs-login"` | "Not signed in" |
| `state === "joined"` | "Joined" |
| `state === "published"` | "Published" |

Chip styling follows `AgentRow`'s `chipFor`: muted for the neutral states,
the success colour for `joined` and `published`. Text role is `detail`, per
the design system.

### 2.2 The button expands the row in place

- Label **"Configure"** for every state short of `published`, **"Manage"**
  once published (a published network still owns unpublish and leave).
- Unsupported and disabled rows render **no button**: there is nothing to
  configure from here, and the chip already says why. This is the only
  case the card's own short-circuits are not reached through the wizard.
- Pressing it toggles an expanded region directly under the row, holding the
  existing `NetworkPluginCard` with `compact`. The card's own `<li>` wrapper
  is not nested inside the row's `<li>`: the row IS the list item, so the
  card's compact branch renders its header-less body only (see § 3.2).
- The button carries `aria-expanded` and `aria-controls` pointing at the
  expanded region. The label flips to **"Hide"** while expanded, so a person
  can fold the instructions away again without the button lying about what
  it does next.
- Expansion is per-row, local component state, not persisted. Several rows
  may be open at once; nothing enforces one. With one plugin shipped this
  cannot matter and a rule would be a rule about nothing.

### 2.3 Ordering, and what goes away

- The `<details>` disclosure and its "Other networks" heading are deleted,
  along with `hasStarted`'s role as a grouping key. `hasStarted` stays as
  the **sort key**: networks with something already installed first, then
  the rest, each group in the server's order (by id).
- The "Checking this machine…", error-with-Retry, and "ships no network
  plugins" states are unchanged.
- The step subtitle "Reach this server from your other devices over a
  network you already use." is unchanged.

### 2.4 The icon route

`readPluginIcon` resolves the manifest's `icon` from **either** registry:

```ts
const rel = getHarness(id)?.icon ?? getNetworkPlugin(id)?.manifest.icon;
```

Nothing else about the route changes: same path re-check, same disk-first
then embedded-built-in ladder, same cache header. `getNetworkPlugin` is
already exported from `@internal/pane-runtime`.

### 2.5 Copy in the Tailscale plugin

The plugin owns its words, so these edits are in `packages/plugins/tailscale`:

| where | was | becomes |
|---|---|---|
| `package.json` `network.privileged.*[1].label` (both platforms) | Let this server drive it | Allow this server to control Tailscale |
| `hints.ts` `notInstalledHints` | Tailscale is not installed on this machine. Install it, then let this server drive it. | Tailscale is not installed on this machine. |
| `hints.ts` `needsPrivilegeHints` | This server may not drive Tailscale yet. Grant its user access to the daemon, then re-check. | This server is not allowed to control Tailscale yet. Grant its user access to the daemon, then re-check. |

The not-installed sentence loses its second clause because the numbered
steps rendered directly beneath it say exactly what to do; a sentence that
previews them is the duplication the hints module's own docblock complains
about. The docblock's quoted "Let this server drive it" example is updated
to the new label so the comment keeps describing the code.

Test fixtures in `apps/server/web/src/components/__tests__/network-plugin-card.test.tsx`
that hard-code the old label are fixtures, not assertions about the plugin;
update them to the new string so a reader grepping for the old copy finds
nothing.

## 3. Components and files

### 3.1 `apps/server/web/src/components/setup/network-row.tsx` (new)

```ts
export function NetworkRow({ row }: { row: NetworkRow }): JSX.Element
```

Owns: the chip mapping (§ 2.1), the button (§ 2.2), the `open` state, and
the `<li aria-label={row.name}>`. Renders `<NetworkPluginCard row={row}
compact />` inside the expanded region. Under 100 lines.

### 3.2 `NetworkPluginCard` compact branch

Today `compact` returns `<li aria-label={row.name} …>{header}{body}</li>`.
The row now owns both the list item and the header, so the compact branch
returns `body` in a plain `<div className="space-y-3">` with **no header and
no `<li>`**. `compact`'s docblock is updated: "no card chrome, no header —
the caller renders the name — no description, no supervisor detail, and
only the settings a join cannot proceed without."

No other change to the card. Every state, control, refusal and hint renders
as it does today, on both pages.

### 3.3 `apps/server/web/src/components/setup/network-step.tsx`

Loses the two-group layout and the `<details>`; maps the sorted rows to
`<NetworkRow>`. The docblock's paragraph about reusing the card stays true
and stays; the sentence about the disclosure goes.

### 3.4 `apps/server/api/src/api/plugins.route.ts`

§ 2.4, one line plus an import.

### 3.5 `packages/plugins/tailscale/{package.json,src/hints.ts}`

§ 2.5. `packages/plugins/tailscale` needs a rebuild (`bunx turbo build`)
before the server's tests see the new manifest, since the server imports
the built package.

## 4. Testing

TDD: each test below is written and seen failing before its change.

**`apps/server/web/src/routes/__tests__/setup.test.tsx`** — replace the
"files the rest under Other networks" case with:

- *renders every network as a collapsed row with a state chip*: two
  networks, one `joined` and one `not-installed`; each `listitem` shows its
  name and chip text; **no** privileged command text is in the document;
  "Other networks" is absent.
- *sorts networks the machine already has first*: the `joined` row is
  `listitem[0]` even though it sorts second by id.
- *Configure expands the row to the card, and Hide folds it away*: press
  the not-installed row's "Configure"; its privileged command appears and
  the button now reads "Hide" with `aria-expanded="true"`; press again and
  the command is gone.
- *a published row offers Manage, an unsupported row offers nothing*: one
  `published` row shows a "Manage" button; one `supported: false` row shows
  the platform chip and no button.

**`apps/server/web/src/components/__tests__/network-plugin-card.test.tsx`** —
the compact case (if one asserts on the `<li>` or the name in compact mode)
is updated: compact renders no header. Add one assertion that compact
output contains no element with the plugin's name as text, so the
double-name regression cannot come back silently.

**`apps/server/api/src/api/__tests__/plugins-route.test.ts`** — add
*serves a network plugin's icon*: `GET /api/plugins/tailscale/icon` with an
authenticated cookie answers 200 with `image/svg+xml`, following the
existing harness-icon case's setup.

**`packages/plugins/tailscale/src/__tests__/tailscale.test.ts`** — whatever
asserts the not-installed and needs-privilege hint text is updated to the
new sentences. If nothing asserts the manifest labels, add one that pins
both platforms' second step label to "Allow this server to control
Tailscale", so a future rewording is a decision made in the manifest and
the test together.

Verification after: `bunx turbo build`, `bun run verify-types`,
`bun run lint:check`, `bun run lint:design`, `bun run test`. Then load
`/setup` against a dev server and confirm the Tailscale mark renders and
the row expands.

## 5. Out of scope

- `/settings/networking` keeps the full cards. It has the room, and a
  person goes there to manage rather than to get past a step.
- No one-open-at-a-time rule, no persisted open state.
- The three "Docs ↗" links per Tailscale card (one per step plus the
  notice's) are unchanged; whether a step needs its own link is a plugin
  question, not this step's.
- Running the privileged steps from the page: still impossible by the
  sudo boundary (network-plugins spec § 11.13), still copy-only.
