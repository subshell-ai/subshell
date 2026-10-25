# BetterDisplay on macOS

This note records the prototype that informed the BetterDisplay backend for the
[virtual-display provider interface](preview-architecture.md#display-providers-and-viewer-protocols).
The experiment remains in [`scripts/betterdisplay-probe`](../scripts/betterdisplay-probe/README.md)
and is separate from the registered provider and bundled helper. Current
implementation details live in [macOS helper architecture](macos-display-helper.md);
this note preserves measurements and implementation constraints.

## Measured on the M5

The initial run used macOS 26.6.2 on Apple Silicon and BetterDisplay 5.1.1
(build 53784). BetterDisplay was installed in the user's Applications directory.
The app needed its first launch completed before CLI requests would answer;
a present executable wasn't enough to establish readiness.

The CLI created a separate 1280×800 virtual screen and returned a macOS UUID,
a transient display ID, and BetterDisplay's installation-local tag ID. Both
CoreGraphics and AppKit found the display, and the native probe placed its
sample window on it after a placement fix: the default window initializer
constrained the original coordinates onto the physical screen. The corrected
probe chooses the AppKit screen explicitly, moves after layout, and checks
the resulting screen ID and window bounds. It exits if the window leaves
that display. BetterDisplay's `get -identifiers` output was a sequence
of comma-separated JSON objects without enclosing array brackets. The probe
accepts this measured format and rejects ambiguous or malformed responses.

After the user granted Screen Recording, the probe captured a 1280×800 PNG
from the selected virtual display through ScreenCaptureKit. Launch attribution
was significant: a fresh process launched through LaunchServices reported
Screen Recording granted, while the same executable launched directly from
the node shell reported it unavailable. Restarting only the direct child
didn't change that result. A production helper needs an app launch path and
permission checks under that same identity. Rebuilding the ad-hoc signed
probe invalidated its grants. The macOS TCC log reported a code-requirement
mismatch for both ScreenCapture and Accessibility, including the old and new
code hashes. Toggling the existing settings didn't repair that mismatch.
The experiment reset only `sh.subshell.display-probe` with Apple's `tccutil`
before asking the user to approve the rebuilt app. The build script accepts
an explicit signing identity for subsequent development; a shipped helper
needs consistent signed identity across upgrades.

A name-filtered CLI query for a nonexistent display returned exit 1 and
`Failed.`, which can't distinguish absence from another CLI failure. The
probe now reads a successful full inventory and filters it locally. An empty
or malformed inventory is an error, not proof that cleanup succeeded.

The CLI controller created a second virtual screen, removed it by its recorded
identity, and confirmed that the first screen remained intact. This exercises
two simultaneous BetterDisplay allocations without a global cleanup command.

After fresh approvals, the final build reported both permissions available.
The sample's actual window bounds were inside the selected display, and a
1280×800 ScreenCaptureKit image showed that window with `subshell-input-ok`
in its text field after process-targeted keyboard events. This verifies the
sample's placement, capture, and input delivery. It doesn't establish the
behavior of unrelated apps or simultaneous remote controllers.

Final cleanup removed the remaining owned virtual display and left the
physical display present. Capturing the removed display's UUID and capturing
the main display both returned the expected refusal, and neither wrote an
image. The sample, permission window, and Cua process started for this
experiment were closed. BetterDisplay and the approved probe app remain
installed for future development.

Validation also includes eight CLI ownership/regression tests, the repository's
type, lint, prose, and test checks, and compilation of the native probe on the
M5. The native experiment is manual hardware coverage; the ordinary TypeScript
suite cannot validate macOS window placement or privacy grants.

## Integration constraints

BetterDisplay allocates a monitor in the logged-in macOS desktop. It doesn't
create a separate login session or an X11-style environment for a subshell.
Our sample chooses an AppKit screen explicitly. An ordinary macOS app won't
necessarily put its windows there because a subshell has a display assigned.
`launchEnv()` alone cannot provide the placement contract that `DISPLAY` gives
the Linux provider. App placement needs its own explicit launch mechanism.

BetterDisplay doesn't provide the browser viewer transport. A native helper
must capture the selected display with ScreenCaptureKit, handle input, and
provide a transport the preview runtime can carry. The existing viewer speaks
VNC. Reusing it requires an RFB bridge; choosing another protocol requires a
new validated descriptor and viewer adapter. This experiment opens no listener
and adds no npm packages.

The macOS desktop shares focus, the menu bar, applications, and the pointer.
Per-process input into the sample isn't proof of isolation for arbitrary apps.
A production UI must explain this shared-desktop behavior before enabling
control. It must not imply that the virtual display isolates apps or protects
the rest of the Mac from a controller. Other windows, menus, or notifications
can appear on the selected display and would be part of its capture.

## Requirements identified by the experiment

The prototype established the following requirements. The production follow-up
implements the provider and helper; real-hardware validation under its signed
release identity remains separate from the prototype's permission grants.

- Package and sign a stable native helper for both Mac architectures. Check
  permissions under the identity that will actually capture and control the
  display, including launches from the node's launchd service.
- Treat BetterDisplay readiness as an asynchronous, bounded CLI query, with
  useful reasons for an unavailable login session, incomplete app setup,
  disabled CLI access, unavailable features, and missing macOS permissions.
- Record owned names and IDs before and after allocation, recover by durable
  identity, and reconcile partial creations. A timeout can follow a mutation.
  Cleanup must never issue unqualified `discard` or trust a reused display ID.
- Pin capture to the owned UUID and stop if it disappears, becomes mirrored,
  or changes identity. A missing display must never select the primary screen.
- Bound frames, input messages, queues, and helper IPC. Bind any viewer socket
  to loopback and prove that it belongs to the helper before publishing it.
- Define app placement and input behavior for multiple simultaneous subshells.
  Test focus changes, the Mac locking, logout, BetterDisplay exiting, node
  restart, display removal, and permission revocation on real hardware.

These are provider requirements, not reasons to weaken the common runtime's
node policy, per-subshell serialization, authorization, or cleanup guarantees.
The current probe isn't suitable for registration as a production provider.

## Primary references

- [BetterDisplay integration setup](https://betterdisplay.pro/guide/integration/)
- [BetterDisplay CLI reference](https://betterdisplay.pro/guide/integration/cli-reference/)
- [BetterDisplay virtual-screen sharing](https://betterdisplay.pro/guide/faq/general/share-virtual-screen/)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Apple DTS confirmation of ad-hoc signing and capture permissions](https://developer.apple.com/forums/thread/819406)

The online CLI reference describes 5.2.0 prerelease behavior. The installed
app's `help` output supplied the command syntax used in this experiment.


## Production follow-up

The production implementation now lives in the bundled native helper and
`BetterDisplayProvider`. Its identity is `dev.subshell.display-helper`, not the
probe identity used for these measurements. See [helper architecture](macos-display-helper.md)
for the consent panel, shared installation, signing, transport, and remaining
shared-desktop constraints. Compiling and testing that code does not validate
its production TCC grants or a signed release installation; those require an
explicit local opt-in by a person testing the release.
