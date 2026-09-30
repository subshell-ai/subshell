---
"@internal/desktop-server": minor
---

Ships the Server app the bundled subshell-server 1.7.0 (presets carry the launch), so desktop users receive the preset-launch work as a desktop-server update. This bump is the pairing this release mechanizes: the app now declares @internal/server as a workspace dependency and changesets propagates CLI bumps to it.
