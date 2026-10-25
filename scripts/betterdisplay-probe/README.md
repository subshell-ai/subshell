# BetterDisplay experiment

This is development tooling for testing a macOS display backend. It isn't
registered in the node's provider picker and doesn't expose a network listener.
It needs macOS 14 or later, the Xcode command-line tools, Bun, and a running
BetterDisplay app with CLI access and the required features unlocked.

`betterdisplay.ts` owns the CLI argument and identity checks. `index.ts` keeps a
private journal so an interrupted creation can be reconciled. The Swift app
tests a specific display's capture and a sample window's input. Build it once
at a stable path, then grant its macOS permissions through its own window.
Rebuilding or moving an ad-hoc signed app can require permission again.
For repeated development, pass your Apple Development signing identity as the
build script's second argument. The default is ad-hoc signing; it needs no
certificate but binds permissions to that particular binary.

From the checkout on the Mac:

```sh
env -u SHELLOPTS -u BASHOPTS bash scripts/betterdisplay-probe/build.sh \
  "$HOME/Applications/Subshell Display Probe.app"

bun scripts/betterdisplay-probe/index.ts create \
  "$HOME/Library/Caches/subshell-display-experiment" \
  /opt/homebrew/bin/betterdisplaycli
```

The build destination and experiment directory must be new paths. On an Intel
Mac or a custom install, pass the actual absolute CLI path. The app's bundled
`Contents/MacOS/BetterDisplay` executable also accepts these commands.

Open the built probe app in Finder and use its permission buttons. Launch
capture through LaunchServices so macOS uses that app's permission identity.
The same executable started directly by a node shell can report a different
Screen Recording grant. To check the app's permissions without prompting:

```sh
: > "$HOME/Library/Caches/subshell-display-experiment/readiness.json"
open -g -n -W --stdout "$HOME/Library/Caches/subshell-display-experiment/readiness.json" \
  "$HOME/Applications/Subshell Display Probe.app" --args readiness
cat "$HOME/Library/Caches/subshell-display-experiment/readiness.json"
```

Use the **UUID returned by creation** in the following commands. `sample`
keeps running and prints its PID; use another terminal for capture and input.
The sample exits after ten minutes or if its display disappears. Choose a
capture destination inside the experiment directory so the image stays private.

```sh
"$HOME/Applications/Subshell Display Probe.app/Contents/MacOS/DisplayProbe" sample DISPLAY_UUID
: > "$HOME/Library/Caches/subshell-display-experiment/capture.json"
open -g -n -W --stdout "$HOME/Library/Caches/subshell-display-experiment/capture.json" \
  "$HOME/Applications/Subshell Display Probe.app" --args capture DISPLAY_UUID \
  "$HOME/Library/Caches/subshell-display-experiment/capture.png"
cat "$HOME/Library/Caches/subshell-display-experiment/capture.json"
: > "$HOME/Library/Caches/subshell-display-experiment/input.json"
open -g -n -W --stdout "$HOME/Library/Caches/subshell-display-experiment/input.json" \
  "$HOME/Applications/Subshell Display Probe.app" --args input DISPLAY_UUID SAMPLE_PID
cat "$HOME/Library/Caches/subshell-display-experiment/input.json"
```

Check the JSON result: `open` returning zero doesn't prove that capture worked.
The app reports an error or a captured UUID and image dimensions. Input sends
`subshell-input-ok` only to another running instance of this probe.
Capture again and check the sample's field to verify delivery. A successful
event-post call alone doesn't prove that the app received the text. This test
doesn't establish that arbitrary apps can accept background input.

If both settings look enabled after an ad-hoc rebuild but the probe still
reports them unavailable, macOS may retain the previous binary's code
requirement. Quit the probe, then clear **only this development app's** stale
grants and approve it again through its permission window:

```sh
tccutil reset ScreenCapture sh.subshell.display-probe
tccutil reset Accessibility sh.subshell.display-probe
```

These commands revoke the probe's grants; they don't approve anything or reset
other apps. Avoid rebuilding again during the measurement run.

Always remove the owned display when the experiment ends, including after a
creation error. Keep the journal until cleanup succeeds:

```sh
bun scripts/betterdisplay-probe/index.ts remove \
  "$HOME/Library/Caches/subshell-display-experiment" \
  /opt/homebrew/bin/betterdisplaycli
```

Cleanup queries the exact recorded name, verifies the UUID and BetterDisplay
tag ID, then discards that one virtual screen and checks that it's gone. A
pending creation has only its unique generated name; cleanup resolves that
name once and uses the same identity checks. If the pending name isn't present,
it keeps the journal and asks you to check again; an asynchronous creation could
still be finishing. Never run an unqualified
BetterDisplay `discard`: it removes every virtual screen.

Capture rejects missing, main, built-in, or mirrored displays. It selects the
requested display in ScreenCaptureKit, checks its identity again before saving,
and never falls back to another display. The CLI verifies that the allocation
is a BetterDisplay virtual screen; the native helper alone isn't a security
boundary for choosing an arbitrary external monitor. Its command line is
developer tooling, not a remotely callable API.

The [engineering experiment](../../docs/betterdisplay-experiment.md) records
what was measured and what a shipped provider still needs.
