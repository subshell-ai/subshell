# Desktop core AGENTS.md

`crates/desktop-core` is the Rust crate BOTH desktop apps compile:
`apps/server/desktop` (Subshell Server) and `apps/client/desktop` (Subshell
Client). This file carries the security rules that are shared by both; the
per-app halves (window tables, command lists, the reset path, the update act,
the entitlement plists) live in each app's own `AGENTS.md` and load when you
work there.

## The boundary is window KIND, not count (§8b)

Commands touching a CLI, config, service manager or filesystem are granted to
BUNDLED pages only, with one narrow exception: the SSH signer commands let a
REMOTE page ask for native confirmation and a native file picker, but it
cannot name a file or receive key contents. Each app has one remote window,
one bundled management page, and a temporary bundled SSH-key unlock window.

Each app's ACL manifest is **load-bearing by existence**: with no manifest,
Tauri leaves app commands ungated for local windows. The `csp` in
`tauri.conf.json` governs bundled pages only; the remote window carries
whatever the plane sends.

## They execute what they find

Each resolution ladder runs `<candidate> version`, and the installed copy in
`~/.local/bin` is executed on every launch from a user-writable directory
(same OS user; accepted. But validate a hand-chosen binary before persisting
it and bound every spawn); the login-shell PATH probe runs the user's own
profile, arbitrary code by construction.

## The open-in-browser path

`desktop_open_in_browser` takes a PATH (`/`-prefixed; no authority, no
backslash, no whitespace/control), and the validator lives once here, shared
by both apps. What the validated path is joined onto is each app's own
decision: the client names it `PlanePin`, and the server app names the
trusted origin its dashboard sits on; those rules are in the app files.

## Desktop update verification

`release_verification` verifies the publisher signature over the exact manifest
bytes, then binds the component, selected version and locally derived platform
filename. The resulting `VerifiedArtifact` must check the exact downloaded
buffer before either app passes it to Tauri's installer. Tauri still verifies
the bundle signature as well. Network reads and Tauri types stay in each app.
