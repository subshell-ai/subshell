# The IPC boundary deep dive

The ACL manifest, the window-KIND command split, the trusted-origin guard, the
CSP/dev-override mechanics and the configure-form contract: the "The IPC
boundary" section (including "The dashboard window's two trusted origins"),
lifted verbatim from `apps/server/desktop/AGENTS.md`. Read this before adding
or changing a Tauri command, a capability grant, or anything
`ipc-acl.test.ts` pins.

## The IPC boundary

`src-tauri/permissions/desktop.toml` is the app's own ACL manifest, and its
**existence** is the boundary, not just its contents. Tauri gates an app
command when `plugin_command.is_some() || has_app_acl_manifest || !is_local`
(tauri 2.11.5, `webview/mod.rs`). Without that file every app command is
ungated for every LOCAL window, so any window added later would silently
inherit the ability to drive the CLI.

With it, the split is enforced, and the split is window KIND:

| Window | Gets |
| --- | --- |
| `wizard` | the twenty-four its page invokes: probe, port in use, setup, install tmux, install server, set the binary, set supervision, every service verb, logs, open path, arm reset, pending screen, reset, open main, open tmux docs, about, open web, request notifications, request Photos, open a System Settings pane, read the launch window, set the launch window, check for an app update, install one; plus `dialog:allow-open`, `opener:allow-reveal-item-in-dir`, and its core grant: `core:default` ALONE. `core:window:allow-close` was granted for spec 2026-09-17's **Later** button and went with it when that screen's two dismissals became one **Close** (2026-09-18), a leave rather than a window close, so no page call to a core window verb remains. `ipc-acl.test.ts` pins the narrowed list, pins that nothing under `ui/src` imports `@tauri-apps/api/window` (the route the grant would come back through), and pins that `main` holds neither close nor the update verbs |
| `main` | `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`, `desktop_open_in_browser`, `desktop_permissions`, `desktop_app_update`, window dragging, and `desktop_set_supervision` (below) on a TRUSTED origin only (loopback, or the instance's configured `APP_BASE_URL`; see below) |

Six of `main`'s seven commands are chosen for what they cannot do: raise a
window at a named screen, drop this app's own title bar, display one
notification with a fixed shape, open a page of THIS server in the system
browser, and (no argument at all, two facts each) read this app's macOS
permission states (2026-09-14, argued in
apps/server/desktop/docs/macos-permissions.md) and its own two update version
facts (2026-09-17, spec § 5.3):
`{ currentVersion, availableVersion }` from `PackageInfo` and the one
settings field the daily check writes. The read NEVER checks:
`desktop_check_app_update`, `desktop_install_app_update` and every other
verb stay `wizard`-only, and the row's `[Update]` rides `desktop_open_assistant`,
a command `main` already held.
`desktop_set_supervision` (the one deliberate exception, added by operator
decision on 2026-09-12) lets the dashboard's supervision card confirm in its
own dialog rather than raising the assistant; `docs/security.md` carries the
accounting, and `ipc-acl.test.ts` pins `main` at exactly these seven so an
eighth is loud.

`desktop_open_in_browser` (2026-09-14) is of the harmless kind and its
harmlessness is in the ARGUMENT: it takes a PATH (no scheme, no
protocol-relative `//host`, no backslash, no whitespace or control characters,
all refused by `crates/desktop-core`'s shared `browser` module) and joins it
onto a TRUSTED origin this side chose, so the page names the route and Rust
names the host. Its signature is pinned as well as its name, because an
exception is only as narrow as its arguments. A webview has no address bar and
no second tab, which is the whole reason it exists; the tray's and the View
menu's "Open in Browser" reach the same act from Rust and need no grant at all.
Two things a person will notice and that this does not try to fix: the browser
carries no session cookie from the webview, so they sign in again; and the
origin opened is whichever trusted one the window is on (usually LOOPBACK,
where a passkey works only if `APP_BASE_URL` is loopback).
Nothing else that touches the CLI, the config, the service or the filesystem
is reachable from a page the server serves. `desktop_open_assistant` takes an OPTIONAL
`screen` argument, and the SPA sends it from the Settings danger card
(`{ screen: "reset" }`), the Service page's Update card (`{ screen: "update" }`),
the permission notices (`{ screen: "permissions" }`) and the sidebar pill (no
argument). The supervision card sends none: it confirms in its own dialog and
calls `desktop_set_supervision` itself. It names a SCREEN
and never a command: raising `update` performs one read-only probe, arming
`reset` performs one `status --json` the watch already runs on its own timer,
and every verb behind either needs a press inside the bundled page.

**`app-update` is no longer a word this enum knows** (spec 2026-09-18, the two
update screens becoming one). Every sender says `update` now: the SPA's
sidebar update row (`components/desktop/desktop-app-update-row.tsx`) and its
Updates page, whose Subshell Server row is FOLDED into the Server row inside
this app (D4) and whose remaining desktop row cannot raise an assistant at all.

Deleting the id rather than aliasing it is what made that sweep finishable: the
old word parses to `Home`, so a sender left behind raises the assistant at
whatever the probe implies (visibly wrong on a machine whose server is
running, rather than silently correct until someone notices the wrong screen).
Two senders were found exactly that way while this work was in flight.

### The dashboard window's two trusted origins

**The capability's scope stopped being the boundary on 2026-09-18** (spec
2026-09-18 § 15, operator's decision with the trade stated; `docs/security.md`
§ 11.11a has the accounting). It was: `capabilities/main.json` named
`http://localhost:*` and `http://127.0.0.1:*`, `open_main` refused anything
else, and `on_navigation` pinned the window to the origin it opened with. Under
that rule a control plane behind an OAuth proxy could not be shown in this app
at all: a proxied sign-in bounces the window to an identity provider on a third
origin and back, and the window would not follow. Subshell Client was unblocked
the same way for the same report (`f1c2aa68`).

So `remote.urls` is a wildcard now (`http://*:*`, `https://*:*`; `http://*`
alone does not match a non-default port in Tauri 2.11.5's urlpattern, which
would silently exclude the default `:3080` plane), and **`src-tauri/src/trust.rs`
is the boundary**. Four facts to hold:

- **Two origins, one predicate.** Trusted means this machine's loopback (either
  spelling, http, any port, exactly what the old scope named) or the instance's
  configured `APP_BASE_URL`. `MainTrust::trusts` answers both "where may
  `open_main` POINT the window" and "may this page invoke anything", so where we
  aim it and what it may do cannot drift apart.
- **The flag belongs to the COMMITTED document, never to a page and never to a
  navigation request.** `allow_navigation` refuses any non-http(s) scheme (the
  window must not be steerable into `file:` or a custom handler) and **arms
  nothing**: it runs at request time and fires for subframes, so an untrusted
  page could otherwise arm all seven commands by aiming at a loopback port that
  refuses the connection, or by embedding an iframe. Arming is
  `on_page_load(PageLoadEvent::Started)`, which wry raises from
  `didCommitNavigation:` (macOS) and `LoadEvent::Committed` (GTK), main-frame
  only, at commit, and before any script in the new page runs, so the SPA's own
  title-bar handshake is never refused. `open_main` sets it for the URL it
  opens a NEW window with (nothing can be invoking yet) and CLEARS it when it
  re-points an existing one; a destroyed window clears it.
- **The guard sits at the INVOKE HANDLER** (`trust::guarding` wraps
  `generate_handler!` in `lib.rs`), keyed on the calling webview's label, and is
  uniform over all seven. Not per-command, because Tauri identifies a caller
  through an injected `Webview` argument and three of the seven are pinned to
  taking no argument precisely so they cannot be aimed: `desktop_permissions`
  takes nothing at all. Plugin commands never reach the app handler, so window
  dragging still works on an untrusted page; the assistant is not subject to it
  at all, and must not be: it is the surface that repairs a machine whose server
  is unreachable.
- **The base URL is live, not captured.** It arrives as `Probe::base_origin()`
  (passed into `open_main` by both callers, and refreshed each tick by
  `watch.rs`, which already takes a probe), because an admin can move
  `APP_BASE_URL` from the Service page without moving the port, and the watch's
  own re-point trigger only watches the port.

Two Rust-side conveniences follow the same line rather than the window's current
address: `browser_origin` uses the window's origin only while it is trusted, and
`current_path` answers `/` when it is not, so a tray click mid-sign-in cannot
carry an identity provider's path onto this server's origin.

What it costs: a page on the instance's own address now holds what a loopback
page held, including `desktop_set_supervision`, and that address may be
reachable from a network. That is the operator's call. What the guard buys is
that it is not a widening to the whole web.

**`dialog:allow-ask` is deliberately NOT granted.** It was the console's, for
its update and restart confirmations. Both of those are screens now, with
their consequences written on the screen rather than inside a system sheet, so
nothing calls `ask`, and a granted permission with no caller is the erosion
these pins exist to catch, read from the other end.

**HMR reaches the assistant and NOT the dashboard, and that is the shape of
the app rather than a broken config.** `tauri dev` starts the bundled page's
own Vite server (`devUrl`, `beforeDevCommand`), so edits under `ui/` hot-reload.
The dashboard window loads the RUNNING SERVER's origin, and that server is the
installed `subshell-server` binary serving the SPA embedded in it at build
time; so an edit in `apps/server/web` reaches that window not slowly but not
at all, until the SPA is rebuilt, embedded, installed and restarted.

**`bun run dev:desktop-server` does this for you.** The launcher probes
`http://localhost:5174` and, when the SPA's own Vite server answers, points the
dashboard window THERE: it proxies `/api` and `/ws` to the real server, and
it is the only way that window hot-reloads. It says which of the two it chose
on startup, so the absence of hot reload is never a silent mystery.

Reused when one is listening, STARTED HERE when none is (operator ask
2026-09-25): the old detect-only rule meant a dev dashboard silently showed
the installed binary's embedded build, and an SPA edit reached it "not slowly
but not at all". A second Vite never fights a developer's own (the running
one is reused untouched), and a window is never aimed at a dead port: the
launcher waits for the port to answer before pointing at it, and a Vite that
never comes up is killed so the run falls back to the old warning. The one
this run started is killed when `tauri dev` exits; one the developer started
is never this script's to kill. `SUBSHELL_DESKTOP_SPA_URL` still wins
when set explicitly, which is what makes a non-default port possible.
Three things make it safe rather than a hole: it is read only under
`debug_assertions`, so a release build ignores the variable before looking at
it; the value must be a loopback `http://` origin, one of the two `open_main`
accepts, and it re-checks independently; and it is applied inside `Probe::origin` rather than at the
`open_main` call sites, because `watch.rs` compares the window's URL against
that same answer and would otherwise navigate back to the server's port on the
next tick. The substitution is printed on stderr every time.

Two consequences to expect, both correct: the Service page reports the
SERVER's port (3080), not the window's (5174), because it describes the server
(`DevProxyNotice` says so on that page and on Status, in dev builds only),
and `resumeElsewhere` fires permanently, because the base URL's origin really
is not the page's. Editing the Port field under the override moves the server
out from under Vite's fixed proxy target until Vite restarts.

**`withGlobalTauri` is load-bearing for `main`, not for the bundled page.**
The SPA's desktop bridge (`apps/server/web/src/lib/desktop.ts`) reads
`window.__TAURI__` (it imports nothing), and it takes its desktop branch
because `windows.rs` marks `main`'s user agent `SubshellDesktop/…`. Turning
the global off while the marker ships kills the title-bar handshake, the
server pill, native notifications and window dragging, and kills them
SILENTLY: the bridge never throws and the ACL stays green. Subshell Client
ships `true` as well since 2026-09-14; its plane window carries a
`SubshellClient/…` marker and one command now, and the same pair rule applies
there. The pair, not either half, is what `tauri-config.test.ts` pins in both
apps.

**That marker carries the bundled server's version.**
`SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)`: `b=` is what
`bundled_version()` reports, and only the app knows it, so it is the one way
the SPA's Service page can offer an update. The group is optional, so a build
that ships no server, Subshell Client (whose `SubshellClient/…` marker never
carries one: it bundles a node CLI) and every older shell
stay valid against the same regex; `DESKTOP_PROTOCOL` is unchanged by it.
`user_agent_for` is the pure body, pinned by test.

**The three-way contract is pinned, because nothing else catches it.** A
command name lives in the calling page module, in `permissions/desktop.toml`
and in a capability file; missing from any one is a runtime permission
refusal, not a compile error. `ui/src/__tests__/ipc-acl.test.ts` asserts that
the commands invoked by the assistant page (`ui/src/main.tsx`, `host.tsx`,
`runners.ts`, plus every module under `screens/` and `hooks/`, enumerated from
disk so a new screen joins the pin by itself) are EXACTLY the set
`wizard.json` grants,
that `ipc.ts` hides nothing extra, that no capability names an undefined
permission, that no defined permission goes ungranted, and that `main` still
holds exactly its seven commands plus window dragging (by name, by count, by
SCOPE, and for every one that takes arguments, by Rust signature), the two
reads, `desktop_permissions` and `desktop_app_update`, pinned to an EMPTY list.

**The SCOPE assertion changed shape on 2026-09-18** and is worth reading before
touching it. It used to pin loopback, both spellings; `remote.urls` is a
wildcard now and the boundary is `trust.rs` (above), so the same test pins the
wildcard AS WRITTEN plus the guard that replaced it: the two-origin predicate,
the recompute on navigation, the wrapper around `generate_handler!`, and
`open_main`'s refusal. A wildcard scope with nothing behind it is exactly the
failure that assertion exists to catch, and it is the one pin in that file § 15
was allowed to move.

**The count is a number worth a test**, because "a few harmless ones" is how a
boundary erodes. Three more pins arrived with the console's deletion: that
`capabilities/` contains exactly `main.json` and `wizard.json` (a third file
is a third window, and a window added without a deliberate grant list is what
the manifest exists to prevent), that no file under `ui/src` names any of the
five commands the console took with it (`desktop_open_console`,
`desktop_init`, `desktop_settings`, `desktop_set_close_to_tray`,
`desktop_open_control_plane`): a leftover name is an invoke that rejects at
runtime, indistinguishable from a permission it was never granted; and that
nothing reaches Tauri outside `lib/ipc.ts`.

**`ipc.ts` does not wrap `main`'s three.** `desktop_open_assistant`,
`desktop_shell_ready` and `desktop_notify` belong to the SPA, which reaches
them through its own bridge. A wrapper here for a command this page never
calls would break the exact-set pin by describing a surface the assistant does
not have.

**The opener surface is the same rule with paths.** `desktop_open_path` takes
a CLOSED enum (`config-env | server-dir | service-definition | logs`), never a
path: the page names an intent and the Rust side re-reads the path from its
own fresh probe, so a row can only ever reveal the fact it is showing (the
client's `node_open_path` for the same reason). `logs` is answered entirely by
the CLI's `service status --json → logPath`: a null is the journal-hint case,
an absent field is an old server, and this side never re-derives a platform
path. `desktop_open_web` is the same shape for the About block's three links
(`website | license | company`). `desktop_open_control_plane` is GONE: the
base URL is the SPA's Networking page to show and to copy now (the Addresses card, since 2026-09-17), and no URL crossed
the IPC boundary from the page in either design. The
`opener:allow-reveal-item-in-dir` grant in `capabilities/wizard.json` covers
the plugin side; the app commands are gated by their own permission entries
here.

`main`'s page is served by the subshell-server this app manages, so it is
treated as remote content. Its `remote.urls` USED to be the gate; see "The
dashboard window's two trusted origins" below for what replaced it, and why.

The bundled page has a real CSP (`script-src 'self'`), which is why its logic is a
module rather than an inline script. The page is TypeScript built by Vite into
`ui/dist` (2026-09-10), and the build step moved INSIDE the promise the
plain-JS version made: `tauri dev` and `tauri build` run `dev:ui`/`build` as
their own before-hooks, so there is no way to launch or bundle the app that
skips it. `app.security.devCsp` relaxes the policy for `tauri dev` ONLY
(Vite's HMR injects an inline script and a style tag and needs its `ws://`
socket; production ships untouched). The build keeps its half of the
pairing (`modulePreload: { polyfill: false }`, `assetsInlineLimit: 0`,
`base: "./"`), because the production CSP would silently block an inline
polyfill or a `data:` asset, and `ui/src/__tests__/tauri-config.test.ts`
pins both halves against each other: a "cleanup" that re-enables either
breaks the assistant with no error anywhere.

**What the configure form SENDS is a contract, not a rendering.** A save is a
non-interactive `init --yes`, and `configure` resolves every key it was given no
flag for to that key's STORED value, so what the form sends decides whether a
save preserves config.env or rewrites it, and both ways of getting it wrong are
silent. `ui/src/lib/config-form.ts` holds the pure halves (`effectiveForm`,
`explicitFields`, `derivedBaseUrl`, `configPayload`, `fieldProblems`) and
`ui/src/__tests__/config-form.test.ts` covers them beside the source. (They
lived OUTSIDE `ui/` while `frontendDist` was `../ui`, because that whole
directory was copied into the shipped bundle and a test importing `bun:test`
would have shipped inside the installed app. The asset root is a Vite output
now, so source-beside-source is the layout again, and what keeps the old
failure mode from returning is `tauri-config.test.ts` pinning
`frontendDist === "../ui/dist"`: the shipped directory is generated, and a
test file cannot hide inside a build's output.) `package.json`'s `test` runs
`bun test src ui/src`; that same file also pins the wiring in `host.tsx` and
`runners.ts` at the source, because the render path imports Tauri and cannot be
loaded here.

The fields are PREFILLED with the effective configuration (2026-09-09), which
moved that contract rather than removing it:

- **Blankness used to mean "nobody chose this"**, which is how the CLI was told
  to keep deriving a value. A filled form cannot say that, so `explicitFields`
  does: a field is sent only when its `status --json` `source` is something
  other than `default`, or the user has typed in it since. `configPayload`
  sends an empty string for anything else, and the Rust side turns that into an
  omitted flag.
- **It keys on CHOSEN, not on EDITED, and the difference is a data-loss bug.**
  `trusted_origins` is the one emptyable flag: empty means "no extra
  addresses". Keyed on editing alone, opening the form and saving without
  touching that field sends empty and WIPES a stored list. So a value already
  in config.env is sent even when untouched.
- **`trustedOrigins` is never prefilled.** Its default is
  `DEFAULT_TRUSTED_ORIGINS`, the two dev Vite origins, which as a suggestion to
  someone configuring an instance would be actively misleading. Its label says
  `(optional)` and it stays blank.
- **A prefilled base URL follows the port while nobody has edited it**
  (`derivedBaseUrl`). The save is safe without that, since an unedited field is
  sent empty and the CLI re-derives, but a filled field reading
  `http://localhost:3080` beside a port of 4000 looks like what is about to be
  written.

**What none of this does is prevent the stale-port case**, and it is worth
being exact because the reverse is easy to assume. `APP_BASE_URL` is in
`OWNED_KEYS`, so it is written on every save, which means after the FIRST save
it is `config.env`-sourced forever, always sent, and changing only the port
leaves a base URL naming a port nothing listens on. The guard there is
`configure`'s port-mismatch warning, not anything here; the page shows the
CLI's stdout verbatim, so that warning is what the user actually reads. What
this side buys is narrower and still worth having: a fresh install does not get
its built-ins frozen into the file.

**First-run configure also installs and starts the service.** "Save and start"
writes config.env and then installs the service, because there is no reason to
configure a server on this machine and not run it. The `install-service` step
remains for the case that means something, a config that already exists with
no service.

**A FRESH machine gets no press and no form (2026-09-10; zero-touch per spec
2026-09-17 § 4).** Where no server exists and one is bundled, the page FIRES
the setup chain itself (the progress checklist is the first screen and it
opens the dashboard by itself when done), and the press survives only where
the fire is refused: the pre-filled form fallback and recovery's **Set Up**,
both of which run the same chain. The chain is `desktop_setup`, unchanged from
2026-09-10: install → init → service install → start, each step calling the
same extracted body (`install_server_now`, `init_now`, `service_now`) its own
command uses, stopping at the first failure so the ordinary probe names the
remainder. This reverses the rule above it, and the distinction is what makes
both true: the two-click floor protected the PREFILL, which comes from asking
the installed server for its settings: a machine with no server has nothing to
prefill, so the form was four clicks executing a plan `decide()` had already
made. Disclosure moved from the form to the checklist's hint, which names every
path the chain writes to. The chain also waits for the re-probe to say READY
before opening the dashboard: `service start` returns when the manager has
spawned the process, not when the port is bound, and every existing opener of
the window (the `ready` button, the tray) opens only against a server that
answers.

**The install offer mirrors a Rust list; the page never sends a command.**
Missing tmux gets `desktop_install_tmux` (brew where it exists, pkexec apt-get
on Linux; never a bare sudo, which has no tty from a GUI and hangs to the
timeout). The decision is pure TypeScript in `ui/src/lib/installers.ts`
(`tmuxInstallPlan`) and is MIRRORED in Rust by
`crates/desktop-core`'s `tmux::install_argv` (it lived in `control.rs` until
2026-09-18, when Subshell Client needed the same installer and the table moved
to the shared crate rather than being copied a third time),
because the webview cannot look at the machine and the Rust side is what
decides what may be EXECUTED. The copies are two languages on purpose (the
page's decides what the user SEES, Rust's decides what runs), and they are
pinned to each other by `the_console_install_table_and_the_rust_one_agree` (a
test whose name outlived the window it was written for), an
`include_str!` containment test so a token removed on either side fails the
Rust build. `console_platform` normalizes Rust's "macos" to the "darwin" the
page branches on: a wrong spelling there strands every Mac in the
no-button fallback silently, so both sides carry a pin.

Agent CLI installs used to live here too (`desktop_install_agent`,
`AGENT_INSTALLS`, and a JS-side `agentInstallPlan` mirror), run from the
user's own desktop session as the same OS user. They are GONE (spec
2026-09-11 §7), not widened: installing an agent CLI is now the control
plane's job, `POST /api/setup/agents/:id/install`, driven from the setup
assistant's Add an Agent screen (`apps/server/web`), the host that has the
plugin manifests, so one install arms every launch rather than one desktop
user's own machine. This app's `ready` step offers "Add agents in the
dashboard" instead, which is exactly `desktop_open_main` under a different
label and carries no tmux gate: opening a window needs no pane.
