# Instance and node naming

Date: 2026-09-08
Status: accepted, implementing

## The problem

The control-plane host's node row is seeded `name: "Local"` and, until now,
`PATCH /api/nodes/:id` refused to rename it — "The local node's name is fixed",
400 for everyone including admins. On a single-user instance that label is
merely terse. On a shared one it is **wrong for every user but the operator**:
a person signing in from their laptop reads "Local" in the Nodes list and in
every launch picker and concludes it means *their* machine, when it names the
machine the control plane runs on.

The word is not the only offender. The same misreading is spelled several other
ways in copy that renders in a browser far from the host it describes:

| where | what it says |
|---|---|
| `node-row.tsx:48` | `"this machine"` as the `local` row's subtitle |
| `local-launch-card.tsx` | "Launch on this host", "Local launching is off" |
| `nodes.tsx:62` | "…this host plus enrolled nodes" |
| `node-sharing-dialog.tsx:40` | "Let others see this machine…" |
| `node-harness-card.tsx:45` | "Agent CLIs on this machine…" |
| `use-harnesses.ts:57` | "Not installed on this machine yet…" |
| `runtime-card.tsx:49` | "…local subshells cannot launch" |
| `client/desktop/.../windows.rs:91` | window title `"Subshell Client — this machine"` |

And a second, quieter defect made the first one unfixable-by-design: **the
launch surfaces never read the node's name at all.** `nodeOptionLabel(node,
localLabel)` takes the local label from its caller, and four callers each pass
their own hardcoded string (`subshell-compat.ts:86`, `profile-fields.tsx:188`
and `:199`, `clone-subshell-dialog.tsx:72`). Making the row renameable without
touching that helper would produce a rename that updates the Nodes page and
silently fails to reach the launch picker, the profile pin, the clone dialog
and the compat matrix.

Separately, an instance has **no name of its own**. There is no
`instanceName`/`appName` anywhere in the repo. A person who points Subshell
Client (or three browser tabs) at a laptop, a homelab box and a production
plane has nothing on screen that says which is which.

## What ships

1. The `local` node becomes **renameable by an admin**, defaulting to
   `"Server"`, migrated on upgrade.
2. The control plane gains an **instance name** — a settings key, admin-editable
   in the UI, defaulting to the host's hostname.
3. **No user-facing string says "local", "this machine" or "this host"** about a
   node, on any surface a person can reach from another machine. Two pieces of
   copy that genuinely describe the control-plane host to an admin standing on
   it are kept and named under "Decisions taken without further consultation".
4. Both names apply **live**. No service restart, by construction.

## The naming rule

The fixes are not string-by-string judgement calls. Three tiers of copy, each
with exactly one right answer:

| tier | names it as | applies to |
|---|---|---|
| **node-scoped** | `node.name` | Nodes row + detail, harness card, sharing dialog, allowed-dirs, launch pickers, profile pin, clone dialog, tmux warning |
| **instance-scoped** | the instance name | sidebar, login page, Nodes page subtitle, loopback warning |
| **identifier only** | `local`, unchanged | `LOCAL_NODE_ID`, `kind: "local"`, the `/nodes/local` route, file and component names |

The third tier is already licensed by `AGENTS.md`: *"Directory names and
component IDS are two different things."* The id stays `local` because it is a
key, not a label; what changes is that **no rendered string is derived from
it.** `cloneNodeId`'s `"local"` fallback is the one place a raw id could reach
a user's eye, and it stops doing so.

### On naming a node "Server"

`AGENTS.md` reserves **server** for "the control plane: the API, its database,
the SPA it serves" and explicitly *not* "a machine that runs agents", under the
rule that no word may name two things. Defaulting this node's label to
"Server" puts that word on a machine that runs agents, so the tension is real
and is recorded here rather than discovered later.

It resolves because the string is now a **display label the admin owns**, not a
vocabulary term. The id stays `local`; the release-component id, tag prefix and
package name for the control plane stay `server`; the directory stays
`apps/server/`. Nothing that the vocabulary rule governs acquires a second
meaning. An admin who dislikes the default renames it in one field — which is
the actual point of the change.

## API

### `PATCH /api/nodes/:id` — the `local` ban is deleted

The `gate.row.kind === "local"` → 400 branch goes away. Nothing else about the
route moves: it stays cookie-only, stays `canManage`-gated, keeps its audit
event, and keeps the `idx_nodes_owner_name` → 409 `NODE_NAME_TAKEN` path.

`canManage` already resolves to **admin** for `local` (real owner, or admin on
`local` — the boost is `local`-only), so no new permission concept is
introduced and no gate is rewritten.

**Agent nodes stay owner-only.** An admin still cannot rename a node another
user enrolled. Spec §9 and the `security-context.md` line that an admin's
instance-wide `edit` does not confer rename are unchanged — this widens exactly
one row, the one the admin already manages.

### `instance_name`, in the existing settings table

`settings` is a key/value table read per request behind an admin-cookie gate.
That is the whole reason the name applies without a restart: unlike
`TRUSTED_ORIGINS` and everything else in `config.env`, nothing here is read
once at boot and cached.

- `PATCH /api/settings` accepts `instanceName`, audited on real changes exactly
  as `allow_registrations` is.
- `GET /api/settings` returns it (admin).
- `GET /api/settings/public` carries it, so every signed-in page — which
  already holds this payload — gets it with no new request.

**Unset resolves to the hostname at read time; no row is seeded.** Clearing the
field therefore falls back to the hostname rather than to blank, a hostname
change follows on its own, and there is no settings migration. The
`hostname().replace(/\.local$/, "") || "localhost"` normalization currently
inline in `seed-local.ts` is extracted so the node seed and the instance
resolver cannot disagree about what this host is called.

### `GET /api/settings/instance` — new, anonymous

Returns `{ instanceName }` and nothing else, to an unauthenticated caller, so
the login page can say what you are about to authenticate against.

`authGuard` is a scoped plugin, so a public route is one that does not `.use()`
it — the pattern the setup endpoints already follow. This ships as its own
small Elysia group sharing the `/api/settings` prefix rather than as an
exemption inside `settingsRoutes`, which is what keeps `viewerIsAdmin`,
`appBaseUrl` and `nodeArtifactTargets` from becoming anonymous by accident.

**This is a deliberate pre-auth disclosure**, the first in the app outside the
first-run setup window. It discloses one operator-chosen string to anyone who
can reach the port. Sound on the trusted-network posture and useful — knowing
which plane is asking for your password is a security property, not a leak —
but it is a widening, and `docs/security.md` and
`.claude/rules/security-context.md` say so.

### Error strings

`delete-node.route.ts` and `recheck-node.route.ts` reach users with "The local
node…". Both become "the control-plane host's node". `rename-node`'s equivalent
string is deleted with its branch.

## Sanitization

The instance name is rendered to **anonymous callers** and interpolated into
copy and log lines. `normalizeDeviceLabel`
(`packages/subshell-protocol/src/frames.ts:198`) already strips C0, DEL and C1
for precisely this reason — CR/LF in a device label would forge a second line
in the attach log.

That function is generalized to `normalizeLabel(raw, max)`, with
`normalizeDeviceLabel` becoming a call to it at `DEVICE_LABEL_MAX`. The new
`normalizeLabel` is applied to:

- the instance name, cap 64, and
- **node renames**, which today enforce `minLength`/`maxLength` and nothing
  else. A node name can currently carry CR/LF into a log line and into the
  `ActionsMenu` label. That was a small latent gap; node names are about to
  appear in a great deal more copy, and this is the change that touches the
  route.

`INSTANCE_NAME_MAX = 64` joins `NODE_NAME_MAX` in `web/src/lib/name-limits.ts`,
whose docstring already exists to keep client caps honest about mirroring the
TypeBox schemas.

## Migration `0022-local-node-name`

```sql
UPDATE nodes SET name = 'Server' WHERE id = 'local' AND kind = 'local'
```

Safe to rewrite unconditionally because the value was **immutable until this
change** — it is always still the seed, so no admin's choice can be clobbered.

No unique-index hazard: `idx_nodes_owner_name` is per owner, and the `system`
user owns exactly this row (enrollment assigns the enrolling human as owner).

Registered in **both** the migrations directory and the provider map in
`db/migrate.ts` — the CLI scans the folder but the boot-time migrator reads the
static map, and a dynamic import would break `bun build --compile`.

## UI

**Where each name is edited** matches where the thing lives:

- **Node name** — the node detail page's existing `EditableText` in
  `PageHeader`. Only the gate changes: `canRename = n.canManage && n.kind !==
  "local"` loses its second clause.
- **Instance name** — a new card on the Settings page, beside Registration.

**The helper collapse.** `nodeOptionLabel(node, localLabel)` drops its second
parameter and reads `node.name` for every kind. This deletes four hardcoded
strings and is what makes a rename propagate to all five launch surfaces by
construction rather than by remembering to.

**Where the instance name renders:** under the sidebar wordmark, and on the
login page ("Sign in to …"). Not in `document.title` — considered and declined
as unrequested.

## Live-apply, and its one limit

Both names are per-request DB reads with query invalidation on save. The web
UI updates on the next fetch; no process is restarted, no config file is
written, nothing is cached at boot.

**The desktop window titles are deferred, with a reason.** The selected
placement included the two Tauri shells' window titles, and that turns out to
cost more than it returns:

- Setting the plane window's title needs the name **in Rust**, and no Rust crate
  here has an HTTP client. Adding `reqwest` (or `tauri-plugin-http`, which
  wraps it) to two Tauri bundles for a window title means a large dependency
  tree, two more `Cargo.lock`s to carry it, and more cross-build and glibc
  surface — for the weakest of the three placements.
- Routing the fetch through the bundled page instead hits **CORS**: the
  anonymous endpoint sits behind the deliberately static origin allowlist, and
  the bundled page's `tauri://localhost` origin is not in it and should not be.
  `security-context.md` calls that allowlist "the narrow point that makes
  'static allowlist' true"; widening it for a window title would spend exactly
  the property it exists to hold.
- Both windows **render the SPA**, so the sidebar name and the login-page name
  already appear inside them. What is missing is only the OS-level title.

What does ship on the desktop side is the phrasing fix: the client's node
window title stops claiming `"— this machine"` and names its role instead.

Revisiting this later has a clean shape — a `subshell` CLI subcommand that
prints the configured plane's instance name would give the node page the value
through a command it is already allowed to call, with no HTTP client and no
CORS involvement.

## Testing

- **Rename `local`**: admin 200; non-admin manager 403; bearer/system key 403
  (cookie-only); collision 409; audit event emitted.
- **`instanceName`**: `PATCH`/`GET` round trip; audit on real change only;
  unset resolves to hostname; a cleared value falls back to hostname, not blank.
- **`GET /api/settings/instance`**: 200 anonymous, and the serialized body
  asserted to carry *only* the name — the same shape as the existing
  `admin-status-route.test.ts` scan, so a field added later cannot quietly
  become anonymous.
- **`normalizeLabel`**: CR/LF, C1 and DEL stripped; `normalizeDeviceLabel`
  behavior unchanged at its own cap; applied on node rename and instance write.
- **Migration**: alongside `0017-nodes.test.ts` — the `local` row is renamed,
  and re-running is idempotent.
- **`nodeOptionLabel`**: updated for the dropped parameter; a `kind: "local"`
  node renders its own `name`.
- **e2e**: `12-nodes.spec.ts:96` pins `getByText("Local", { exact: true })` and
  becomes `"Server"`.

**Deliberately not done:** a repo-wide "no user-facing 'local'" string scan.
It would have to distinguish rendered copy from identifiers, comments,
`localStorage`, `localhost` and `toLocaleString`, and would be brittle in both
directions. The naming rule above plus the e2e pin is the coverage.

## Decisions taken without further consultation

- **Default node label `"Server"`** and **default instance name = hostname**,
  both as chosen during design.
- **`local` remains the id and route path.** Renaming it would be a migration
  across `nodes.nodeId` references, the WS handler, the downloads route and
  every cached client view, to change a string no user needs to read.
- **`document.title` is left alone.**
- **The `LocalLaunchCard` component and `seed-local.ts` keep their file names.**
  They are identifiers under tier three; renaming files would enlarge the diff
  without changing a rendered string.
- **Node names are now sanitized**, a small pre-existing gap in the route this
  change already edits.
- **`add-node-dialog`'s loopback warning keeps "this machine"** — it is
  admin-only copy about the control-plane host's own address, read on the
  Nodes page of that plane, and "this machine" is accurate there.
- **`setup.tsx`'s "Nothing usable on this machine?"** likewise stays: first-run
  setup runs on the server host by definition.

## Non-goals

- Admin rename of **agent** nodes owned by other users. Spec §9 stands.
- An instance name in `config.env` or the `subshell-server` CLI. It would
  reintroduce the restart this change exists to avoid.
- Per-user or per-client naming of a plane. The instance name is one
  operator-chosen string, the same for everyone.
- Editing the instance name from the Subshell Server desktop console. That
  console writes `config.env` through the CLI; this value lives in the
  database, and the plane's own Settings page is where it belongs.
