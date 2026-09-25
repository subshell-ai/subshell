# macOS permissions deep dive

The permissions screen's rows and doors, the desktop-core permissions module
and the wire-name pins: the "macOS permissions (spec 2026-09-14)" section,
lifted verbatim from `apps/server/desktop/AGENTS.md`. Read this before working
on the permissions screen, `crates/desktop-core/src/permissions.rs`, or the
request/notification commands.

## macOS permissions (spec 2026-09-14)

A first run on a Mac meets four system prompts or banners. THREE of them are
the app's own to raise: Notifications, and (since 2026-09-17) Photos.
Files-and-Folders is attributed to whichever process lists the folder
(`subshell-server` under launchd, this app under "runs with this app"), and
Background Items is a banner, not a permission. So the `permissions` screen,
macOS only, shows THREE rows, REQUESTS the
two it owns, EXPLAINS the one it cannot, and never blocks Continue. The rows
are listed ACTIONABLE FIRST (operator's ruling 2026-09-25): notifications,
photos, files: reading down reads the decisions before the prose, where the
old "order a first run meets them" put the one explanation-only row between
the two questions. It left the first
run with spec 2026-09-17 (the TCC prompt it explains belongs at the moment a
permission is first wanted, not at launch) and came back on 2026-09-18 on the
far SIDE of the setup chain (spec § 10): the ready screen's Continue hands off
to it, on macOS, on a first run, once, so nothing is asked of anyone until
there is a running server to be notified about, and the dashboard's notices
remain its other door.

It is still reached ONE way. `permissions` never left `REQUESTED_SCREENS`, so
the handoff names it exactly as a dashboard notice does and
`isRequestedScreen(screen)` remains the whole routing; the render's old
dual-role disambiguator stays gone. What the screen has to know is which door
it came through: from a notice there is somewhere to go BACK to, and from the
handoff there is not, so it carries a primary **Continue** that opens the
dashboard in place of the ghost Back.

**The fourth row, Background Items, was removed on the operator's request,
and the reason is worth keeping** (it is the same reason the second rule below
exists). The banner is real: starting at login does add Subshell Server to
Login Items and macOS says so. But the row had no state to read, no pane to
open and nothing to press, so it could never change, and a row that can never
change is not information; it is prose standing in the column a person reads
for decisions. Where the banner appears the sentence belongs: the login
screens that arm it.

**The Photos button is not a second door to the same room, and that needed
proving.** The screen shipped with the row EXPLAINED and never ASKED (spec
2026-09-14 § 9): the system raises the prompt at the moment an image is picked,
which is where Apple puts it. What makes asking here sound rather than merely
possible is recorded in `desktop-core`'s `request_photos`: **the panel that
normally raises this prompt is THIS app's own image picker**, running in this
process, and `Info.plist` already carries the `NSPhotoLibraryUsageDescription`
sentence the sheet shows. So a sheet raised on this screen arms exactly the TCC
subject the picker would otherwise arm later: one question, asked where it can
be explained. The ask is at `PHAccessLevel::ReadWrite`, the SAME level
`photos_permission()` reads, so the sheet and the row answer one question, and
the answer is RE-READ from that function rather than mapped from the handler;
this row renders the difference between `authorized` and `limited`, and one read
keeps that mapping in one place.

**The request itself had to move to the main thread** (operator report,
2026-09-25, packaged app). Called on the command's tokio worker, the sheet
never appeared and the app never registered under System Settings → Privacy &
Security → Photos: no consent prompt ever reached TCC. PhotoKit's consent sheet
is presentation, and presentation belongs on the main thread. **The first fix
of this crashed the app** (measured the same morning, 1.0.1): it dispatched
through a `msg_send!` of `+[NSThread performBlockOnMainThread:]`, that
selector does not exist on the class (its absence from the generated
`objc2-foundation` bindings was the evidence, read the wrong way), and an
unrecognized selector ABORTS the process; the crash report is the record.
`request_photos` therefore takes its hop as an injected dispatcher, and
`desktop_request_photos(app: AppHandle)` hands it
`AppHandle::run_on_main_thread`, a checked Rust API, so the shape of the hop
cannot be guessed wrong again. The wait stays on the worker, so the main
thread is never held. The notifications pair keeps calling in place: the UN
framework re-dispatches its own request internally, which is why the identical
pattern worked there and did not here. **No check on this host can compile the
macOS-gated half; `cargo check --target aarch64-apple-darwin` does, and the
fix's real proof is a press of the button on a built app.**

**Tauri's notification plugin cannot see any of this.** Its desktop
`permission_state()` and `request_permission()` are stubs that answer
`Granted` (2.4.0, measured), so the truth comes from `UNUserNotificationCenter`
and `PHPhotoLibrary` directly, in `crates/desktop-core/src/permissions.rs`,
shared, because Subshell Client will want the notifications half the day it
notifies. Two facts about that module are load-bearing:

- **The bundle guard runs before every call, and checks BOTH halves.** The UN
  API aborts a process that is not an `.app` bundle (no error, no stack, the
  window just never paints), and `tauri dev` runs the bare binary. A bundle
  identifier alone is not proof: `tauri-build` embeds an `Info.plist` into the
  dev binary through a linker section, so `bundleIdentifier` answers there too.
  The bundle PATH ending in `.app` is what a linker section cannot fake. Dev
  therefore answers `unavailable` by design, the page says "Permissions can only
  be requested from the installed app", and the real prompt is testable only in
  a built app. `cargo test` in desktop-core is itself not a bundle, which is why
  its test that every function answers `Unavailable` there is the crash guard
  under test.
- **Both states ride on the probe** (`notificationPermission`,
  `photosPermission`), so the screen re-reads them on the poll it already runs.
  The dashboard cannot read the probe, so it has `desktop_permissions` (the
  sixth `main` command, read-only, no argument, argued in `docs/security.md`
  and in `capabilities/main.json`'s own comment). Everything that ACTS stays
  `wizard`-only: `desktop_request_notifications`, `desktop_request_photos` and
  `desktop_open_system_settings` (which takes a closed `SettingsPane`, never a
  URL, the `WebTarget` shape). The two requests take NO argument either
  (pinned in `ipc-acl.test.ts` beside the read's own no-argument pin), so
  neither can be aimed at a permission the screen did not name. And each has a
  `#[cfg(not(target_os = "macos"))]` stub answering `Unavailable`:
  `control.rs` names them on every platform, and **`cargo clippy` on a Mac
  cannot see what Linux compiles**: a missing stub is a Linux build failure
  that ships green from a laptop.

`src-tauri/Info.plist` carries the four usage descriptions; they are the
sentence a prompt attributed to THIS APP shows, and a prompt attributed to
`subshell-server` under launchd shows none, which is what the `files` row's
attribution sentence is for. THAT the file reaches the bundle is a v1 behavior
the v2 docs never repeat; it was confirmed at the source (tauri-cli 2.11.4
`interface/rust.rs` merges the file with the `bundle.macOS.infoPlist` object)
and the darwin smoke now RE-checks it: `plutil -extract` on each of the four
keys inside the mounted `.app`, because a silently dropped key is not a
build failure, it is a permission sheet with no reason, found only on a
user's Mac (the 2026-09-25 Photos hunt is what earned this). The row model is
pure (`ui/src/lib/permissions-model.ts`): every `Permission` value to a glyph
state, a suffix and an action, and which pane each row opens.

**Every row the dashboard sends someone to has something to press when they
arrive**, and that is a SECOND rule beside "a button only where pressing it
does something". Read as one rule, they produce the dead end this screen
shipped with (review, 2026-09-14). The two are about different buttons: macOS
asks once, so **Allow** is inert after the first answer and is offered only
while the state is `not-determined`; **Open Settings** is never inert where
the pane has an entry to flip, whether or not the question was asked on this
machine yet. So the `files` row offers it in EVERY state ON THE RECOVERY DOOR:
its own state is unreadable by construction, so a button gated on `denied`
would render never, while the picker's "Blocked by macOS" notice raises this
screen as the fix regardless, and that notice only appears once a refusal is
already in the pane. The door is the KIND of arrival, not which notice sent
the person: the notifications notices route through the same door and can
arrive with the files pane not yet populated, the price of a door Rust can
answer without reading TCC. `SettingsPane::FilesAndFolders` being defined,
granted and sent by nothing was the tell. The 2026-09-25 door ruling
WITHHELD that button on the FIRST-RUN door: on a machine never asked the
pane holds no row for this app, and a button onto an empty pane is the dead
end the Photos `restricted` arm below refuses with the identical reason
(macOS verdicts outlive an in-app reset; a person who reset and had denied
a folder meets the button again at the notice door). The
row model takes the door as its third argument
(`permissionRows(probe, requesting, door)`); the button and the sentence's
finder hint move with it, the suffix and the attribution never do. The same
2026-09-25 pass, from a live screenshot, took the row's GLYPH off as well: it
wore the checklist's `pending` ring, which reads as "not yet done": a
promise this screen can never keep, since it never asks the question that
would tick it. The row's state is `info` now: a label, a sentence, a suffix,
at most one button, and NO state mark on either door; every glyph border in
styles.css keys off `data-state` and no arm names `info`, while the 28px
glyph column stays so its labels still align with the rows above. `photos`
follows `notifications` on the two shared states (**Allow**
while `not-determined`, **Open Settings** once `denied`) because it has a
prompt of its own to raise now (see above), and its notice fires in the
`denied` state the pane answers, and then DIVERGES on the state only Photos
can reach: `restricted` is macOS refusing WITHOUT asking (a profile, Screen
Time, or the 2026-09-25 VM whose Photos library has never existed), and the
pane holds no row for such an app, so the row says **Blocked**, wears the ✕
(the attach will fail), and offers NOTHING to press. A door onto an empty
pane is exactly the dead end this rule exists to forbid, and the operator
proved it: "Nothing in the system settings either". Both buttons are short
since the
operator's pass of 2026-09-25: the row's own label names the permission, so
the ask is the bare **Allow** and the door is **Open Settings**; what keeps
the 2026-09-14 anti-lie rule is the row's `request` field and the renderer's
exhaustive `Record` over it, not the label spelling out which permission it
spends. The buttons carry `aria-label` with the row's permission anyway
(**Allow Photos**, **Open Photos settings**): a screen reader browsing the
button list sees no rows, and an invisible accessible name costs the eyes
nothing.

**A second rule came out of the same screen: an `allow` row carries its own
button WORDS.** The renderer used to hardcode `("Allow notifications",
allowNotifications)` for `row.action === "allow"`, which was true of one row and
became a lie the moment two rows could ask: the Photos row would have shown a
button naming notifications and spent the Photos question. So `PermissionRow`
carries `allow: { label, request } | null` (present exactly where `action` is
`"allow"`, pinned by `permissions-model.test.ts`), and `permissions-screen.tsx`
looks the handler up in a `Record<PermissionRequest, () => void>`. A `Record` over the
model's closed union, not a chain of `if`s on `row.id`: a third request added to
the union without its handler is a COMPILE error, where dispatch defaulting to
notifications is a button that lies and a test nothing fails.

**The three enums that cross as WORDS are pinned to Rust's own spelling**:
`WebTarget` and `SettingsPane` (`control.rs`), `Permission` (`desktop-core`);
the pin is `ui/src/__tests__/wire-names.test.ts`, which derives the serde wire names
from each enum body and compares them against `lib/ipc.ts`'s unions and the
SPA's hand-written `types/permissions.ts` mirror. The test was born from
`MacPorts` going across as `mac-ports`; `Permission` is the worse case it now
also covers, because it travels TOWARD the page: a drifted word there is not
a refusal with a message but an `undefined` falling out of an exhaustive
switch, rendering a blank row with no error anywhere.
