# macOS display helper

Both desktop apps build `native/display-helper` and bundle the same
`dev.subshell.display-helper` app under `Contents/Helpers`. The native menu
installs it to `~/Applications/Subshell Display Helper.app` and opens its
settings using LaunchServices. This identity is distinct from the experimental
`sh.subshell.display-probe`; development must not replace that approved probe.

## Consent and lifecycle

Installation and first-run setup never call the helper. The status menu opens
the panel without opting in. The panel is a `WKWebView` over a bundled page: it
draws the controls and posts actions, and Swift re-checks every one of them, so
the page is presentation and never authority. Consent is written only by the
enable act, whether it arrives from the panel's **Enable helper** button or from
the status menu's toggle. Starting at sign-in is its own act with its own
button (**Start at sign-in** / **Stop at sign-in**), offered by the panel and
the menu alike; enabling never registers it, because agreeing to be captured
and agreeing to launch at sign-in are two choices. OS privacy prompts have
their own buttons, available only after consent. A remote web page has no
Tauri command for any of these operations.

After consent, login may resume the helper. Disable clears consent first and
closes every capture and input connection, releasing held keys/buttons; it
leaves the login item alone, so a helper that returns at the next sign-in is
found disabled and exits at once. **Quit helper** asks first, in the panel and
in the status menu alike, then ends the process: captures close, consent and
the TCC grants stay, and a registered login item brings it back at the next
sign-in, so disabling rather than quitting is how you stop it returning.
Normal logout preserves consent. Disabling does not revoke TCC grants, close
terminals, or guarantee removal of virtual screens while BetterDisplay is
unreachable. A disabled running helper answers the read-only `status` request
and accepts `rescue-cursor` (which does nothing while no viewer held the
pointer there), but refuses every other RPC. No RPC can enable it, register
login startup, or request a privacy prompt.

User procedures belong in [node management](../apps/docs/content/docs/nodes/manage.mdx#macos-display-helper).

The [BetterDisplay protocol reference](betterdisplay-protocol.md) specifies the
CLI commands, helper messages, RFB subset, resource limits, and versioning.

## Trust and transport

The provider and helper share a private Unix socket at
`~/Library/Caches/Subshell/display-helper/control.sock`. Its directory is 0700,
the socket is 0600, and accepted peers must have the helper's UID. The same OS
user is trusted; this is not authentication between hostile processes running
as that user. There is no network listener in the native helper.

Protocol 1 uses bounded JSON lines. `status` reports consent, Screen Recording,
Accessibility, and the executable of an already-running BetterDisplay app.
`start` takes a Subshell-owned virtual screen name and UUID plus bounded
capture dimensions. The helper independently verifies BetterDisplay's current
inventory and refuses physical, main, built-in, and mirrored screens. Capture
checks display identity on every frame and polls permissions once a second,
including while frames are idle. Input also requires both permissions on every
event. Disable closes capture connections synchronously from the main actor;
a native stream whose startup was pending is stopped again when startup
completes, even if Disable already cleared its owner's reference. Frames and
input stay blocked during that teardown.

ScreenCaptureKit supplies JPEG frames at up to 5 fps. Four capture reservations
at most share a total 16-megapixel budget. Each connection has bounded input
and output queues and a request rate cap. Descriptors are nonblocking so a
stalled reader cannot hold the Disable button hostage. Startup and incomplete
requests have deadlines. No audio or clipboard access is implemented.

The Bun `MacOSRfb` bridge exposes RFB 3.8 and Tight JPEG on an ephemeral
loopback-only port, with at most eight viewers and bounded protocol buffers.
The existing authorized preview lane carries those bytes to noVNC. This local
RFB port has the same same-host trust assumption as x11vnc; it is not an
additional remote authentication boundary. Losing the helper closes every
viewer and reports a display loss without killing the terminal.

Text uses Unicode events; native shortcuts use ANSI virtual key positions,
so shortcut behavior on other keyboard layouts needs separate validation.
Keyboard delivery checks that the focused app's window is wholly within the
selected display and posts to that process. A headless Mac whose only online
screen becomes the main display is refused; another main screen is required. Pointer events stay within the
selected screen's coordinate bounds, but macOS focus and the pointer remain
shared globally. Focus can race window movement, shortcuts can affect the
account, and notifications or unrelated windows on the screen are visible.
This is deliberately disclosed as desktop control, never advertised as an
isolated Linux-style session.

## Provider ownership and recovery

`BetterDisplayProvider` is a static member of the existing provider registry.
Readiness never starts BetterDisplay or the helper. The node's feature and
provider flags still gate allocations and viewing; allocations recheck policy
after native startup and close new displays if access was revoked during the
wait. Existing displays retain their documented lifetime. Helper consent and
macOS permissions are additional requirements. MCP uses the same readiness result.

Each subshell gets an unpredictable `Subshell-<UUID>` name. Before invoking
create, the provider writes a private journal below
`<dataDir>/betterdisplay-displays/<subshell-id>`. After allocation it persists
BetterDisplay's UUID and tag ID. Deletion requires a successful inventory and
matching name, UUID, and tag ID, followed by a fully qualified discard. A failed
query is never interpreted as absence. Unknown or changed identities keep the
journal and are never deleted. An uncertain timed-out create retains its
journal even when the screen is not yet visible, because BetterDisplay may
finish the request later. Recovery retries such journals; operators may need
to inspect BetterDisplay manually for an allocation that never completes.

Recovery skips another live daemon's journals. It reattaches a live subshell
only after rechecking requirements and identity; dead subshells are reaped.
A disabled helper leaves screens pending until cleanup can contact it and
BetterDisplay. Cocoa has no DISPLAY equivalent: launch environment values
`SUBSHELL_DISPLAY_UUID` and `SUBSHELL_DISPLAY_NAME` identify the screen but do
not automatically place windows there.

## Builds, updates, and verification

Each desktop `build.rs` compiles the same Swift sources for its target, then
signs the helper before Tauri signs and notarizes the outer app. Release builds
require `APPLE_SIGNING_IDENTITY`; ad-hoc signatures are debug-only. Both apps
must use the same Developer ID team and helper bundle ID so TCC has a stable
code requirement across updates. `Info.plist` owns the helper's independent
version: bump it whenever shipping changed helper code, including changes
released in only one desktop app. A later release of the other app must never
downgrade the installed helper.

The installer verifies signatures and compares versions and code hashes.
It uses a shared install lock and atomic directory renames with rollback.
The helper holds that lock for its entire lifetime, even while disabled, so
an update cannot replace a running permission owner. If an update is needed while the helper runs, the menu still opens the existing
settings so Disable stays reachable. The user quits the helper and reopens
settings to install the new version. No installer changes consent
or OS privacy settings. Release smoke checks inspect the nested bundle's
identity and hardened runtime without launching it.

`native/display-helper/test.sh` compiles tests into a temporary directory and
uses a disposable preference suite and Unix socket. It never opens an app,
requests permissions, registers login startup, captures a display, or injects
input. `scripts/rust-check.sh` runs it on macOS; the CI router includes native
source changes and checks both desktop integrations on macOS. TypeScript
provider tests cover policy, ownership, uncertain allocation, recovery, and
helper-loss teardown; socket tests exercise RFB negotiation and bounded input.

## Security review, 2026-10-25

Reviewed native consent and login activation, Unix socket peer checks and
protocol bounds, capture/input permission checks, RFB forwarding, provider
ownership and recovery, installer signature checks, and preview authorization.
The follow-up pass found no remaining major or minor issues within this scope.
This is a code-review result, not a guarantee against undiscovered defects.

The review fixed three revocation gaps:

- A pending ScreenCaptureKit start could complete after Disable had stopped
  and cleared the stream. Startup now stops its retained native stream again
  if consent, permissions, or display identity changed while it was pending.
- Keyboard and pointer input could continue until the periodic capture check
  noticed Screen Recording revocation. Each input event now requires that
  permission too; frame delivery also checks Accessibility immediately.
- Node or provider policy could change during native allocation. The runtime
  now refuses the completed allocation and closes a newly created display;
  it doesn't tear down an existing display as a side effect of a refused open.

Validation passed: 564 pane-runtime tests, 57 preview-route authorization tests,
TypeScript checks, and lint (with existing warnings). On the M5, native tests
covered consent, rejected RPCs while disabled, and revocation during capture
startup; all Swift sources compiled with warnings treated as errors for arm64
and x86_64. These tests used temporary files and preferences and requested no
privacy permissions. The temporary terminal and build directory were removed.

A signed release's install/update, TCC persistence, and real ScreenCaptureKit
revocation still need end-to-end validation on macOS. This review did not
activate or replace the installed experimental probe or the production helper.

### Expanded display and VNC review

The follow-up covered the complete display path, including Xvfb/x11vnc,
noVNC decoding bounds, raw WebSocket forwarding, browser/MCP permissions,
server capability revocation, signed node settings, provider selection,
and both desktop integrations. It found no additional major or minor issues
within the documented trust model. The boundary-by-boundary account is in
[Web previews and virtual displays](security.md#1115-web-previews-and-virtual-displays).

Nine additional socket-level RFB tests cover malformed negotiation/input,
encoding and clipboard limits, excess viewers, and controller cleanup. The
expanded run passed 573 pane-runtime, 1,269 node, 3,098 web, and 131 MCP tests.
The server run passed 4,751 tests but couldn't run its proxy cases without a
built frontend. After building that prerequisite, all 21 tests in the affected
proxy file passed, including origin gates and raw VNC tunnels. Other test
packages passed in the broad run. Documentation build, export, types, and lint
passed too.

The dependency audit reported only the existing Expo-tooling node-forge
advisory. Its tracked mitigation remains necessary: the installed-consumer
regression passed, verifying rejection of malformed nested DigestAlgorithm
signatures while preserving valid signatures and certificates. The version
scanner still reports the original package version; this isn't a clean
upstream advisory result. See [dependency audit](security-actionable.md#dependency-audit-outside-the-preview-runtime).

### Follow-up code and documentation review

A further pass checked provider allocation and recovery, helper consent and
resource limits, RFB parsing, native installation, CI routing, and setup links.
It corrected recovery's case-sensitive UUID comparison and added a regression
test: equivalent UUID casing now restores the same display without allocating
another one. Tag and UUID identity checks still reject a different display.

The capture-limit error now tells users to close a subshell using a virtual
display, since closing its viewer alone doesn't release capture capacity.
The architecture diagram also distinguishes capture loss, which retains
ownership for recovery, from explicit cleanup.

The follow-up found no further major or minor issues in the reviewed paths.
Validation passed: 574 pane-runtime tests, 17 node-card and launch-form tests,
16 CI-routing tests, 175 documentation tests, runtime type checks, and the
documentation build and 127-page export verification. Runtime lint retained
17 existing warnings. This pass changed only native error text and didn't
rerun macOS native tests; the signed-release validation gap above remains.


## PR feedback follow-up

Uncertain creation records move to `betterdisplay-displays-pending` after a
successful inventory shows no matching screen. They remain available for
cleanup if a delayed creation appears, but don't block a new allocation or
closing the subshell. A vanished created display removes the stale active
journal and reports a lost reason. Failed or ambiguous inventory still keeps
ownership records. The experimental probe shares the production CLI guards,
with a separate `Subshell-Probe-` namespace.

JPEG encoding uses a serial worker and one retained frame per capture. Busy
encoders drop incoming frames. Permission and identity checks remain before
encoding and before sending the result; the idle timer supplements those
checks. Moving the expensive encode off the main actor keeps settings and
control requests responsive without weakening revocation.

`native/display-helper/Info.plist` owns the helper's independent version for
both desktop apps. After its first release, bump both version fields whenever
shipping helper changes. Release installers only replace an older helper
version; equal-version bundles retain the installed copy even if their hashes
differ. Development builds may refresh equal-version content by hash. Never
use either desktop app's independently advancing version for this shared app.

The RFB clipboard limit stays at 64 KiB: the screen viewer doesn't call
noVNC's `clipboardPasteFrom`, and clipboard sharing isn't supported. Oversized
messages close that viewer rather than expanding the untrusted input budget.
SetPixelFormat remains supported because the bundled noVNC sends it during
initialization. It now validates full-depth true-color formats while accepting
the byte and channel orders that don't affect Tight JPEG decoding.
