# macOS permissions in the first run — Implementation Plan (2026-09-14)

Spec: `docs/superpowers/specs/2026-09-14-macos-permissions-screen-design.md`. Branch:
`feat/split-to-workspace` (this work rides the current branch; the operator will cut it later).

Two agents, disjoint files, both **no commits** — the lead reviews and commits each slice:

- **Agent R** — Rust + the native assistant: Tasks A, B, C.
- **Agent W** — server route + SPA: Tasks D, E.
- Task F (docs, changeset) and Task G (manual verification in a built app) are the lead's.

The wire shapes both agents build against are pinned in the spec (§4.2, §5.5, §5.3) so they can
run in parallel: `Permission` words `not-determined | denied | authorized | provisional |
unavailable`; `desktop_permissions → { notifications, photos }`; `desktop_notify → { shown,
permission }`; files listing `blocked?: "permission"`.

Conventions for every task: TDD where a pure function or route is involved; JSDoc on exports;
`description` on every Elysia `t` property; design-system roles only (`text-detail` for every
explanation a control gives about itself); no `await import`. Run the scoped checks named in each
task, then the gate: `bun run verify-types && bun run lint:check && bun run lint:design && bun run
test`, plus `bun run rust:check` for anything under `crates/` or `src-tauri/`.

---

## Task A — `desktop-core::permissions` (Agent R)

Files: NEW `crates/desktop-core/src/permissions.rs`; `crates/desktop-core/src/lib.rs` (`pub mod
permissions;`); `crates/desktop-core/Cargo.toml`.

- `Permission` enum (`NotDetermined | Denied | Authorized | Provisional | Unavailable`) with
  `serde(rename_all = "kebab-case")` and an `as_str()` giving the same words.
- `notification_permission()`, `request_notifications()`, `photos_permission()` per spec §4.1.
- Dependencies, **target-gated**: under `[target.'cfg(target_os = "macos")'.dependencies]` add
  `objc2-user-notifications = "0.3.2"`, `objc2-foundation = "0.3.2"` (both in the local registry),
  `objc2 = "0.6.4"`, `block2` at the version already in `apps/server/desktop/src-tauri/Cargo.lock`.
  For Photos, `objc2-photos` at the crates.io version whose `objc2` peer is 0.6 — if none exists,
  leave `photos_permission()` returning `Unavailable` with a comment naming the missing crate, and
  say so in the report. Pin exact versions (project rule).
- **Bundle guard first** (spec §4.1): `NSBundle::mainBundle()` must have `bundleIdentifier()` AND a
  `bundlePath()` ending in `.app`, else `Unavailable` before any UN/PH call. Document why both.
- Completion handlers → `std::sync::mpsc` with `recv_timeout(10 s)` → `Unavailable` on timeout.
- Non-macOS: every function returns `Unavailable`.
- Tests (`#[cfg(test)]`): all three answer `Unavailable` in the test binary (which is not a
  bundle) — this is the crash guard under test; `as_str` round-trips serde.
- `cd crates/desktop-core && cargo fmt --check && cargo clippy --all-targets -- -D warnings &&
  cargo test`.

## Task B — Subshell Server commands, probe, ACL, plist (Agent R)

Files: `apps/server/desktop/src-tauri/src/control.rs`, `reset.rs`, `lib.rs`,
`permissions/desktop.toml`, `capabilities/wizard.json`, `capabilities/main.json`, NEW
`src-tauri/Info.plist`, `src-tauri/Cargo.toml` if a dep is needed.

- `Probe` gains `notification_permission: String` and `photos_permission: String` (kebab words),
  filled in `probe_now` from `desktop_core::permissions`.
- New commands: `desktop_permissions` (no args → `{ notifications, photos }`),
  `desktop_request_notifications` (→ `Permission`), `desktop_open_system_settings(pane:
  SettingsPane)` with a closed `SettingsPane { Notifications, FilesAndFolders, Photos }` mapped to
  the three `x-apple.systempreferences:` URLs in spec §4.2, opened via `app.opener().open_url`
  exactly as `desktop_open_web` does. Register all three in `lib.rs`'s `invoke_handler`.
- `desktop_notify`: check `notification_permission()` first; return `{ shown: bool, permission:
  Permission }`; post when `Authorized | Provisional | Unavailable`, skip on `Denied |
  NotDetermined` with `shown: false`. (NotDetermined: posting would fire the system prompt from a
  background moment; the assistant's Allow button is where that prompt belongs.)
- `Screen::Permissions` in `reset.rs`: `parse_screen("permissions")`, `as_str` → `"permissions"`.
- ACL: three `[[permission]]` entries in `desktop.toml` with descriptions in the file's voice;
  `wizard.json` grants all three; `main.json` grants `desktop_permissions` ONLY — its comment
  block must carry the spec §7 argument in brief and name it the sixth.
- `Info.plist` with the four usage descriptions (spec §4.3).
- `bun run rust:check` from the repo root (stages the sidecar stub itself).

## Task C — the assistant screen (Agent R)

Files: `apps/server/desktop/ui/src/lib/ipc.ts`, `lib/wizard-state.ts`, NEW
`lib/permissions-model.ts` + `__tests__/permissions-model.test.ts`, `wizard.ts`,
`__tests__/wizard-state.test.ts`, `__tests__/ipc-acl.test.ts`.

- `ipc.ts`: `Permission` type, `Probe.notification_permission` / `photos_permission`,
  `SettingsPane`, `permissions()`, `requestNotifications()`, `openSystemSettings(pane)`; widen
  `notify`'s return type if the page calls it (it does not — the SPA does; leave a comment).
- `wizard-state.ts`: `ScreenId` + `"permissions"`; `FIRST_RUN = ["welcome","tmux","permissions",
  "setup"]`; `screensFor` filters it out unless `probe.platform === "darwin"`; `REQUESTED_SCREENS`
  + `"permissions"`; `dots()` total `7` on darwin, `6` otherwise (`_probe` becomes `probe`).
- `permissions-model.ts` (pure): `permissionRows(probe) → Row[]` with `{ id, label, detail,
  state: "pending"|"done"|"failed"|"active", suffix, action: null | "allow" | "open-settings" }`
  for the four rows per spec §3/§3.1, the `files` detail naming `subshell-server` or `Subshell
  Server` from `probe.supervision`. Tests: every `Permission` value for the notifications row;
  photos has no `allow`; login has no action; attribution flips with supervision.
- `wizard.ts`: `renderPermissions(p)` using `checklist`-style markup (reuse `.checklist`
  classes; a row's right-hand side is the suffix or a `button`); Allow → `act(() =>
  ipc.requestNotifications())`; Open System Settings → `ipc.openSystemSettings("notifications")`;
  bar: Back to `tmux` + Continue (always live) in the first run, Back → `host.close()` when
  requested (mirror `renderSupervision`). Add to the `views` map and the requested-screen branch.
  NO text beside Continue.
- Tests: `wizard-state.test.ts` — `screensFor` darwin vs linux, `dots` 7/6, `screenForRequest(
  "permissions")`. `ipc-acl.test.ts` — `main` count moves to **six**; pin `desktop_permissions`
  by signature (no arguments) beside the other two argued exceptions, with the reason.
- `cd apps/server/desktop && bun test && bun run build && bunx tsc --noEmit -p ui/tsconfig.json`.

## Task D — files route: a blocked listing (Agent W)

Files: `apps/server/api/src/api/files.route.ts`, `__tests__/files-route.test.ts`.

- Response schema gains `blocked: t.Optional(t.Literal("permission", { description: … }))` at the
  LISTING level. When `readdirSync(path)` throws `EPERM`/`EACCES`, answer 200 with `entries: []`
  and `blocked: "permission"`; an absent path still 404s; an empty directory has no `blocked`.
- **Never probe children** (spec §5.3) — assert in a comment where the temptation is.
- Test via the route's existing fs seam (or add one): inject `EPERM`; do not `chmod` (CI is root).
- `cd apps/server/api && bun test src/api/__tests__/files-route.test.ts`, then `bunx turbo build
  --filter=@internal/backend-client`.

## Task E — SPA: detection, notices, Preferences, steps (Agent W)

Files: `apps/server/web/src/routes/setup.tsx`; NEW `hooks/use-desktop-permissions.ts`;
`hooks/use-desktop-notifications.ts`; NEW `components/desktop/permission-notice.tsx`;
`hooks/use-terminal-uploads.ts` + the terminal surface that shows its overlay;
`components/directory-picker-input.tsx`; `components/notifications-card.tsx`; `types/` for the
files response; tests beside each.

- `setup.tsx`: `NATIVE_STEPS = isServerDesktop() ? (desktopPlatform() === "macos" ? 4 : 3) : 0`
  (`desktopPlatform` exists in `lib/desktop.ts`). Extend the step-label tests with the macOS UA.
- `use-desktop-permissions.ts`: `useQuery` on `desktopInvoke("desktop_permissions")`, enabled
  only under `isServerDesktop()`, `staleTime` 30 s, key in `lib/query-keys.ts`.
- `permission-notice.tsx`: one sentence + **Fix…** (`desktopInvoke("desktop_open_assistant",
  { screen: "permissions" })`) on the server desktop; the System Settings path in words otherwise.
  Shared by the three call sites below; `text-detail` for the sentence.
- `use-desktop-notifications.ts`: read `{ shown, permission }` from `desktop_notify`; on
  `permission === "denied"` show the banner (spec §5.1) once per session (a module-level flag or
  `sessionStorage`, guarded in try/catch per the storage rule).
- `use-terminal-uploads.ts` `openImagePicker`: on the server desktop, read the permissions query;
  if `photos === "denied"`, surface the Photos notice (spec §5.2) and still open the panel.
- `directory-picker-input.tsx`: when the listing carries `blocked: "permission"`, render "Blocked
  by macOS" in place of entries and the notice naming `subshell-server` / `Subshell Server` (the
  supervision mode is readable from the server-deployment query the Service page already uses —
  `SERVER_DEPLOYMENT_QUERY_KEY`; fall back to `subshell-server` when unknown).
- `notifications-card.tsx` desktop branch: live "macOS permission: …" line from the query, Fix…
  when `denied`.
- Tests: hook behaviour with a mocked `desktopInvoke`; notice renders words vs button by shell;
  picker renders a blocked listing; card shows each state; setup step label under the macOS UA.
- `cd apps/server/web && bun test && bunx tsc --noEmit && bun run lint:design` (root).

## Task F — docs and changeset (lead)

- `apps/server/desktop/AGENTS.md`: a "macOS permissions" section (the screen, the probe fields,
  the bundle guard and why dev answers `unavailable`, the sixth main command and its argument).
- `.claude/rules/security-context.md`: the desktop bullet reads six commands — five harmless,
  one deliberate exception — and names `desktop_permissions`.
- `docs/security.md`: the §7 paragraph.
- Changesets: `@internal/desktop-server` minor; `@internal/server` patch (files route + SPA).

## Task G — manual verification, built app only (lead)

`bun run release:desktop-server` (or `tauri build --debug`), install, wipe via the reset screen,
first run: Allow → system prompt → row flips; decline → Not allowed → Open System Settings lands
on the pane; allow there → next poll flips. Notifications denied + idle agent → banner once →
Fix… → screen. Photos denied → image picker → notice, panel opens. Revoke Desktop access for
`subshell-server` → picker shows the folder blocked. Record which settings URLs resolved, here.

## Dependency order

A → B → C (Agent R, sequential). D → E (Agent W, sequential). R ∥ W. F after both. G after F.
