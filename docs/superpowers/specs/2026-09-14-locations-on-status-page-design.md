# Design: the Locations card moves from Service to Status

Date: 2026-09-14
Status: approved design, from the operator's direction of 2026-09-14: "a lot
of the data in the admin > services panel feel like they belong in the status
page instead."
Amends: `2026-09-12-management-in-the-dashboard-design.md` § 4.1 and § 4.3
(the Locations card is no longer a Service-page card).

## 1. The line between the two pages

The 2026-09-12 spec created `/settings/service` beside `/settings/status`
and stated the split in each route's own docstring: **Status is where an
admin sees what the instance currently is; Service is where they change the
running process.** Status is "read-only by design … nothing here is a
control", which is what lets the whole page refresh under the viewer with no
confirmation anywhere.

Measured against that line, the Service page holds one card that is pure
read-only data — the **Locations** card — and the Status page's Runtime card
already restates one of its rows. Every other Service card carries an act:

| card | the act it carries | stays on Service |
|---|---|---|
| Service | **Restart server**; the supervision line is where the restart reports back | yes |
| Supervision | the mode switch and start-at-login | yes |
| Addresses | the config form (PATCH `/api/admin/server/config`) | yes |
| Update | the update itself | yes |
| Server log | the **Debug logging** switch, an audited instance setting | yes |
| Locations | none — eight paths with copy affordances | **no: moves** |

The Server log card is the judgment call and it stays. It is mostly data,
but it holds a control that writes an audited setting, and the 2026-09-12
spec names "what it logged" as the page's fourth job. If a later change
wants "every read on Status", it starts by moving the switch, not the log.

## 2. What changes

### 2.1 The Status page gains Locations

`routes/settings_.status.tsx` renders the Locations card **after Runtime and
before Inventory**: Runtime says what the process is, Locations says where it
keeps things, Inventory says what lives in it.

The card reads `GET /api/admin/server` (the deployment view), which the
Status page does not fetch today. The page mounts `useServerDeployment(isAdmin)`
beside `useAdminStatus`, the same pairing the Service page already runs and
for the same reason: the paths live only in the deployment view (config
file, service definition and manager log have no `admin/status` counterpart),
and the route already polls at the cadence this page wants. **No server
change**: duplicating `paths` into `admin/status` would be two routes to
keep agreeing for one card.

Rendering rules, because the two queries can fail independently:

- The card renders when the deployment view is present, inside the same
  admin branch as everything else, independent of whether `status` has
  arrived — one query failing must not hide the other's cards.
- A failed deployment read shows the existing error banner shape with its
  own message ("Could not load this server's deployment.") and Retry, inside
  the admin branch for the reason both route docstrings already give:
  `refetch()` ignores `enabled`.
- The "Loading…" line shows while either query is loading and has no data.

### 2.2 The Runtime card stops restating the path

`RuntimeCard`'s **Database** row currently renders `databasePath (size)`.
With Locations on the same page the path is stated twice, once copyable and
once not. The row becomes **Database size**, showing `formatBytes(databaseBytes)`
only (an em-dash when null). `databasePath` stays in the `AdminStatus` type
and the route response — it is read elsewhere and the response's key set is
not this change's business.

**Listening on** and **base URL** stay in Runtime: those are the RUNNING
values, read-only, and the Addresses card on Service is the SAVED, editable
side of the same keys. Saved-versus-running is that card's whole vocabulary,
and it does not move.

### 2.3 Files

- `components/service/locations-card.tsx` → `components/admin-status/locations-card.tsx`.
  Its imports do not change: it already builds on `admin-status/fact-list`,
  and `CopyableValue` stays at `components/service/copyable-value.tsx`
  because four Service cards import it from there.
- `routes/settings_.service.tsx`: drop the Locations import and render; the
  subtitle becomes "Where this server listens, who supervises it, and what
  it logged."; the docstring's "where it writes" goes with it.
- `routes/settings_.status.tsx`: mount `useServerDeployment`, render
  `LocationsCard`, add the deployment error banner; update the docstring to
  say the page reads two routes and why.
- `components/admin-status/runtime-card.tsx`: the Database row per § 2.2.
- `components/service/locations-card.tsx`'s docstring cites "spec
  2026-09-12 § 4.3"; it now also cites this spec.

### 2.4 Tests

`routes/__tests__/server-status.test.tsx` is the page's existing test. It
gains:

- a mock for `GET /api/admin/server` (a minimal `ServerDeployment` — the
  fixture shape is `types/server-deployment.ts`), and an assertion that the
  Status page renders the Locations title and at least the config-file and
  data-directory paths;
- an assertion that the Runtime card no longer renders `databasePath` and
  does render the formatted size;
- one case where the deployment fetch fails and `admin/status` succeeds:
  the Runtime card still renders, and the deployment error banner appears.

The Service page has no route test today, and this change adds none there;
the absence of a card is not worth a test file.

### 2.5 Documentation

- `apps/server/web/AGENTS.md`: wherever it lists the Service page's cards or
  the Status page's, reflect the move (the implementer greps for
  `Locations`, `LocationsCard`, `where it writes`).
- `2026-09-12-management-in-the-dashboard-design.md` is a historical design
  and is not edited; this file amends it.
- Changeset: `@internal/server`, **patch** — "The Locations card (config
  file, data directory, database, logs, node artifacts, service definition)
  moved from Server Settings → Service to Server Settings → Status, where
  the read-only facts live; the Runtime card now shows the database size
  only." Never `@internal/server-web`: it is an ignored package and a
  changeset naming it wedges the version PR.

## 3. Verification

`bun run verify-types`, `bun run lint:check`, `bun run lint:design`,
`bun run test` — all green before the commit. No Rust, so `rust:check` is
not needed.

## 4. Out of scope

- Moving the Server log card or its debug switch (§ 1).
- Adding `paths` to `GET /api/admin/status` (§ 2.1).
- Any change to the sidebar: both entries, their labels and their order stay.
