# macOS permissions in the first run — Design Spec (2026-09-14)

Implementation plan: `docs/superpowers/plans/2026-09-14-macos-permissions-screen.md`.
Scope: `apps/server/desktop` (Subshell Server) and the SPA it opens. Subshell Client is out of
scope (see §9); the native piece is built where it can be shared.

## 1. The problem

A first run on a Mac produces several system prompts and banners with no warning and no
explanation from the app: a Notifications prompt the first time an agent is waiting, a
Files-and-Folders prompt the first time the directory picker lists the home folder, a Photos
prompt if someone attaches an image from the Photos sidebar, and a "Background Items Added"
banner when start-at-login installs the launchd agent. Each names the app or the server
binary and asks for a decision the person has not been prepared for. Declining Notifications
is one click, and macOS never asks again — the app then silently stops telling you an agent
is waiting, and nothing in the product says why or how to undo it. The same silence follows
every other decline: attach an image from Photos with Photos blocked and nothing happens; pick
a folder the server may not list and the picker shows it empty (operator's report, 2026-09-14).

So this is two things. A screen that says up front what macOS will ask and why, and **detection
at the moment a permission is needed and missing**, with a way to fix it right there.

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| Which items | Notifications, Files & Folders, Photos, Background Items — **explained**; Notifications alone is **requested** | It is the only prompt the APP owns. The others are attributed to the server binary or raised in context by a system panel, and cannot be requested or read by the app |
| Where | A new native screen, **macOS only**, between Install tmux and Set Up | Prerequisites, then what macOS will ask, then the server. Linux has none of these prompts and keeps its trio |
| Blocking | **Never.** Continue is live whatever the answer | Declining is a legitimate choice; the recovery path exists for changing it |
| Native API | `UNUserNotificationCenter` via the `objc2` crates already in the lockfile, in `crates/desktop-core` | Tauri's notification plugin **stubs** both `permission_state()` and `request_permission()` to `Granted` on desktop (measured, 2.4.0). It cannot see a decline |
| Where the state lives | A probe field, `notification_permission` | The screen re-renders on the existing 1500 ms poll; a probe fact is how every other "what is true of this machine" answer reaches the page |
| Dev builds | The API **aborts** in a process that is not an `.app` bundle, and `tauri dev` runs the bare binary — so the answer is `unavailable` there, never a crash | The real prompt is testable only in a built app |
| Detection | Each permission is checked **where it is needed**, and a missing one is said there with a button (§5) | Explaining up front does not help someone who declined; the moment of failure is the moment they want the fix |
| The page reads state | One new main-window command, `desktop_permissions`: **read-only, no arguments** | In-context detection lives in the dashboard, so the dashboard has to be able to ask. It is the sixth command `main` holds, argued in §7 as `AGENTS.md` requires |
| The page fixes state | It **raises the assistant** at the new screen; it never opens System Settings itself | The dashboard already holds `desktop_open_assistant`. Opening a system pane from a web page is a nuisance an XSS could pull, so that stays on the bundled page |
| Re-request | Offered only while **undetermined**; once denied the button becomes **Open System Settings** | macOS will not prompt twice. Offering "Ask again" on a denied state is a button that does nothing |
| Info.plist | Adds the four usage descriptions | A prompt attributed to the app shows the app's own sentence; today there is none |

## 3. The screen

`ScreenId` gains `"permissions"`. `FIRST_RUN` becomes `["welcome", "tmux", "permissions", "setup"]`,
and `screensFor` drops `permissions` when `probe.platform !== "darwin"`. Title **"What macOS Will
Ask"**; subtitle "Four things, each once. Here is what they are for."

Four rows in the `.checklist` visual language (glyph column, label, detail — the same rows Set Up
and Reset use), in the order a first run meets them:

| Row | Label | Detail (what and why) | Right-hand side |
|---|---|---|---|
| notifications | Notifications | Tells you when an agent is waiting for you. Asked now, if you allow it. | state + action (§3.1) |
| files | Files and Folders | The directory picker lists your home folder. macOS asks per folder — Desktop, Documents, Downloads — the first time. Asked when you browse. | "Asked later" |
| photos | Photos | Attaching an image to an agent can read your Photos library if you pick from there. Asked when you attach one. | state (§3.1 words; no Allow button — the system asks in context) |
| login | Background Items | Starting at login adds Subshell Server to Login Items, and macOS shows a banner saying so. Nothing to allow. | "Not a permission" |

The `files` row's attribution depends on supervision: under the launchd service the prompt names
`subshell-server`; under "runs with this app" it names Subshell Server. The detail says which,
from `probe.supervision`, because a prompt naming a binary the person never typed is the one that
looks like malware.

### 3.1 The notifications row

Driven by `probe.notification_permission`:

| state | glyph | label suffix | action |
|---|---|---|---|
| `not-determined` | pending | — | **Allow notifications** (primary) → `desktop_request_notifications` |
| `authorized`, `provisional` | done ✓ | Allowed | none |
| `denied` | failed ✕ | Not allowed | **Open System Settings** → `desktop_open_system_settings("notifications")` |
| `unavailable` | pending | Unavailable in this build | none; detail adds "Permissions can only be requested from the installed app." |

While the request is in flight the row is `active` (spinner) and the button disabled, with the
usual `busy`. The result lands through the next probe, not a return value the page trusts.

Bar: Back (to tmux), **Continue** (always live). No text beside Continue — the row carries its
own state, per the rule this app keeps.

### 3.2 As a requested screen

`REQUESTED_SCREENS` gains `"permissions"`, `Screen` gains `Permissions`, `parse_screen` accepts
`"permissions"`, `as_str` returns it. Raised from the dashboard it renders the same four rows
over whatever the probe implies, with the bar reading Back → `host.close()` and no Continue,
exactly as `supervision` does. Which means it is reachable on an onboarded machine, which is the
whole point.

## 4. The native layer

### 4.1 `crates/desktop-core/src/permissions.rs`

```rust
pub enum Permission { NotDetermined, Denied, Authorized, Provisional, Unavailable }
pub fn notification_permission() -> Permission;                   // UN getNotificationSettings
pub fn request_notifications() -> Result<Permission, String>;      // UN requestAuthorization(.alert|.sound)
pub fn photos_permission() -> Permission;                          // PHPhotoLibrary.authorizationStatus(.readWrite)
```

One `Permission` type for both, because the page renders both with one model (§8).

- macOS only (`#[cfg(target_os = "macos")]`); other targets return `Unavailable` from both.
- **The bundle guard comes first.** `NSBundle.mainBundle` must have a `bundleIdentifier` AND a
  `bundlePath` ending in `.app`; otherwise `Unavailable`, and the UN API is never touched.
  `currentNotificationCenter` aborts the process with "bundleProxyForCurrentProcess is nil" from a
  bare binary, which is what `tauri dev` runs. Tauri's build script embeds an Info.plist into the
  dev binary, so the identifier alone is NOT proof of a bundle — hence both checks.
- Both UN calls are completion-handler async; the functions block on an `mpsc` channel with a
  bounded wait (10 s) and answer `Unavailable` on timeout rather than hanging a command forever.
- Dependencies: `objc2-user-notifications` 0.3.2 and `objc2-foundation` 0.3.2, both already in
  the registry, pinned exactly, target-gated to macOS in `Cargo.toml`.
- `UNAuthorizationStatusEphemeral` maps to `Authorized`.

Shared crate, not `control.rs`: Subshell Client posts no notifications today, and the day it does
this is the half it needs (§9).

### 4.2 Commands (Subshell Server, `control.rs`)

| command | grant | does |
|---|---|---|
| probe field `notification_permission: String` | (probe) | `notification_permission()` serialized kebab-case: `not-determined` / `denied` / `authorized` / `provisional` / `unavailable` |
| probe field `photos_permission: String` | (probe) | `photos_permission()`, same words |
| `desktop_permissions` | **main + wizard** | both states, no arguments (§5.5) |
| `desktop_notify` (existing) | main | now checks the state first and returns `{ shown, permission }` (§5.1). Still posts when `authorized`/`provisional`/`unavailable` — `unavailable` is a dev build, where the plugin's own path still shows something |
| `desktop_request_notifications` | **wizard only** | calls `request_notifications()`, returns the resulting state |
| `desktop_open_system_settings(pane)` | **wizard only** | `pane` is a closed enum `SettingsPane { Notifications, FilesAndFolders, Photos }` → a `x-apple.systempreferences:` URL Rust owns, opened with the opener plugin. Same shape as `WebTarget`: the page names a member, never a URL |

All go in `permissions/desktop.toml`; the request and settings commands in `wizard.json` only;
`desktop_permissions` in both. `main.json` moves from five commands to **six**, and §7 is the
written argument `AGENTS.md` demands before that number moves.

Settings URLs (macOS 13+; verify each opens the intended pane on the dev machine and fall back to
the parent pane if one does not):

- notifications: `x-apple.systempreferences:com.apple.Notifications-Settings.extension`
- files: `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders`
- photos: `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Photos`

### 4.3 `src-tauri/Info.plist`

New file, merged by the bundler (Tauri 2 merges `src-tauri/Info.plist` when present — the plan
verifies this by reading the built bundle's plist):

| key | text |
|---|---|
| `NSPhotoLibraryUsageDescription` | Subshell Server reads a photo only when you attach it to an agent. |
| `NSDesktopFolderUsageDescription` | Subshell Server lists this folder so you can pick where an agent runs. |
| `NSDocumentsFolderUsageDescription` | (same) |
| `NSDownloadsFolderUsageDescription` | (same) |

Notifications needs no key. These describe the APP's prompts; a prompt attributed to
`subshell-server` under launchd carries no description, and the screen's `files` row is where
that case is explained.

## 5. Detection where it is needed

The screen prepares; these catch. Every notice below has the same shape: one sentence naming
which permission is missing and what it blocks, and a **Fix…** button that raises the assistant
at the `permissions` screen (`desktop_open_assistant({ screen: "permissions" })`), where the
denied row carries **Open System Settings**. In a plain browser the button is replaced by the
instruction in words ("Allow it in System Settings → Privacy & Security → …"), since no app is
there to raise.

### 5.1 Notifications — at the moment one should have shown

`desktop_notify` (already granted to `main`) checks `notification_permission()` **before**
posting and returns `{ shown: boolean; permission }` instead of `()`. The hook that fires
"Waiting for you" (`use-desktop-notifications.ts`) reads the answer: on `denied`, it raises a
dismissible banner in the dashboard, **once per session**, reading "macOS is blocking
notifications from Subshell Server, so it cannot tell you when an agent is waiting." with Fix….
This is the one detection that needs no new read: the failed act itself reports.

### 5.2 Photos — when the image picker opens

`openImagePicker` (`use-terminal-uploads.ts`) calls `desktop_permissions` first on the server
desktop. If `photos === "denied"`, the terminal's drop overlay region shows the notice "macOS is
blocking Subshell Server from your Photos library, so images picked from Photos will not attach.
Files from folders still work." with Fix…, and the panel still opens — Files still work, and
the person may not have wanted Photos at all. `not-determined` shows nothing: the system will
ask in context, which is the right moment.

Reading Photos state needs `PHPhotoLibrary.authorizationStatus(for: .readWrite)` — read-only,
never prompts — through `objc2-photos` (pin the version in the registry that matches
`objc2` 0.6 / `objc2-foundation` 0.3; if none does, the field answers `unavailable` and only
the up-front row explains Photos). Same bundle guard as §4.1.

### 5.3 Files and Folders — when the picker cannot list a folder

This one is the SERVER's, on every platform, because the denial is the server's own error.
Listing `~` succeeds; it is stepping INTO `~/Desktop` (or Documents, Downloads) that makes
`readdirSync` throw `EPERM`. So the flag is on the **listing**, not on a child entry:
`files.route.ts` distinguishes `EPERM`/`EACCES` on the requested path from an empty or absent one
and answers `200 { entries: [], blocked: "permission", … }` rather than an error. **It never
probes children to pre-flag them** — a `readdir` of each folder under `~` is exactly the act that
fires a TCC prompt per folder, so the picker learns a folder is blocked only when someone opens
it. The SPA directory picker (`components/directory-picker-input.tsx`) renders a blocked listing
with "Blocked by macOS" in place of its contents and the notice "macOS is not letting
`subshell-server` read this folder." — or "Subshell Server", under app supervision, since that is
the name the system prompt showed — with Fix… on the server desktop and the words otherwise. `.claude/rules/security-context.md`'s allowlist rule is
unaffected: this is a folder the OS refused, not one the owner restricted, and the two render
differently.

### 5.4 Preferences → Notifications

`components/notifications-card.tsx`, desktop branch: the static `DESKTOP_HELP` sentence gains a
live line from `desktop_permissions` — "macOS permission: Allowed / Not allowed / Not yet asked /
Unavailable in this build" — and, when not allowed, the same Fix… button. This is the standing
home for the recovery; §5.1–5.3 are the moments it is reached without looking for it.

### 5.5 `desktop_permissions`

```ts
desktopInvoke("desktop_permissions") → { notifications: Permission; photos: Permission }
// Permission = "not-determined" | "denied" | "authorized" | "provisional" | "unavailable"
```

Granted to `main` and `wizard`. No arguments, no side effects, answers two facts about the app's
own standing with the OS. `ipc-acl.test.ts` pins `main` at **six** commands and pins this one by
signature (no arguments), the way `desktop_set_supervision` and `desktop_open_in_browser` are.

## 6. Dots and steps

- Native: `dots(probe, current)` returns `total: 7` on darwin, `6` elsewhere — `_probe` stops
  being unused, which its own comment anticipated.
- SPA: `NATIVE_STEPS` in `routes/setup.tsx` becomes `4` when `desktopPlatform() === "macos"`,
  `3` for `linux`, `0` in a browser. The "Step 5 of 6" test gains its "Step 6 of 7" twin.

## 7. Security accounting

**The main window gains one command, `desktop_permissions`, and this is the argument for it.**
`AGENTS.md` holds `main` at five and says a sixth needs the case made in writing:

- **What it does.** Answers two questions about the app's OWN standing with the OS: may it post
  notifications, may it read Photos. It takes no argument, runs no program, reads no path,
  touches no service or config, and changes nothing — it cannot be pointed at anything.
- **Why the dashboard needs it.** The operator's requirement is that a missing permission be
  said at the moment it is needed, in the surface where it is needed. Two of those moments —
  attaching an image, reading the standing state in Preferences — are in the dashboard, and the
  dashboard cannot know without asking. Routing every check through the assistant would mean
  raising a second window to find out whether to show a sentence.
- **What an XSS in the SPA gains.** Two booleans about the app's permissions. Nothing to act on.
- **What stays off `main`.** Requesting the permission and opening System Settings. Both live on
  the bundled page and are reached by raising it — the command `main` already holds. A page
  that could pop system panes on its own is a nuisance vector, and the request should come from
  a press the person can see the sentence above.

Also on `main`, `desktop_notify`'s return type widens from nothing to two fields. It is the same
call with the same capability; it now reports instead of guessing.

The wizard-only pair — request, and open a pane from a closed enum holding no URL from the
page — follow the shape of `desktop_open_web` exactly. The server's `files.route.ts` change is a
richer error on a read it already performs. Info.plist strings are copy, not capability.
`.claude/rules/security-context.md`'s desktop bullet is updated to read "six commands — five
harmless, one deliberate exception" and to name `desktop_permissions` among the harmless ones;
`docs/security.md` gets the paragraph above.

## 8. Testing

- **Pure, wizard**: `screensFor` includes `permissions` on darwin and not on linux; `dots` totals
  7/6; a new `permissions-model.ts` maps each `Permission` state to glyph state, suffix and
  action kind for both the notifications and photos rows, and the `files` row's attribution to
  supervision.
- **Pure, SPA**: `NATIVE_STEPS` by platform (extend the existing step-label tests).
- **ACL**: `ipc-acl.test.ts` pins page-invoked == granted == defined. `main` moves to **six**,
  with `desktop_permissions` pinned by signature (no arguments) beside the other two argued
  exceptions; the request and settings commands are `wizard`-only.
- **Server**: `files-route.test.ts` — a path whose `readdir` throws `EPERM` answers 200 with
  `blocked: "permission"` and no entries (inject the error via the route's fs seam; do not chmod,
  CI is root), an empty directory answers with no `blocked`, and an absent one still 404s, so the
  three stay distinguishable.
- **SPA**: `use-desktop-notifications` shows the banner once on a `denied` answer and not on
  `shown: true`; `openImagePicker` shows the Photos notice only on `denied`; the directory picker
  renders a blocked entry with the notice and, on the server desktop, the Fix… button; the
  Preferences card shows each state's line.
- **Rust**: `desktop-core` unit test that both functions answer `Unavailable` in the test binary
  (which is not a bundle) — this is also the crash guard, so it is the test that matters.
  `rust:check` across all three crates.
- **Manual, built app only**: `bun run release:desktop-server` (or `tauri build --debug`),
  install, wipe as the reset screen does, run first run: the prompt appears from the Allow
  button; decline → row shows Not allowed → Open System Settings lands on the pane; allow there →
  next poll flips the row. Then: with Notifications denied, let an agent go idle → the banner
  appears once → Fix… lands on the screen. With Photos denied, press the image picker → the
  notice appears and the panel still opens. Revoke Desktop access for `subshell-server` in
  System Settings → the picker shows that folder blocked. Record the result in the plan's
  verification section, including which settings URLs resolved.

## 9. Out of scope

- **Subshell Client's first run.** The client posts no notifications today, so it needs none of
  this screen; the day it notifies, `desktop-core::permissions` is the half it adopts, and only
  the notifications row applies (operator's call, 2026-09-14).
- Requesting Photos or folder access up front. Both are asked in context by the system at the
  moment of use, which is where Apple's guidance puts them and where the app cannot intervene
  anyway.
- Requesting Photos from the app. The system asks at the moment of use; the app reads the
  answer (§5.2) and never pre-empts the question.
