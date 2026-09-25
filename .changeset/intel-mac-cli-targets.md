---
"@internal/server": minor
"@internal/node": minor
"@internal/desktop-server": minor
"@internal/desktop-client": minor
"@internal/website": minor
"@internal/docs": patch
---

Intel Macs (darwin-x64) are a published target again, for every component. `install-server.sh`, the server-rendered node enroll one-liner, self-update, and the downloads route resolve an Intel host to the `darwin-x64` artifact instead of refusing it by name. The desktop apps publish a second Mac image, `Subshell-<App>-Desktop-<version>-darwin-x64.dmg`, cross-built by `tauri build --target` on the Apple Silicon runner, and `install-client.sh` now installs it on an Intel Mac instead of refusing. The release pipeline cross-builds and exec-smokes CLI binaries under Rosetta; the desktop smoke verifies the bundle's signing chain, the staple, and the nested sidecar's Mach-O slice.

On the marketing site the macOS download button becomes a split control with an Apple silicon / Intel menu. The choice is capability-driven: `releases.json` now carries each desktop release's verified asset list (read from the release's own signed `release-manifest.json`), and the menu appears only when the newest cut actually ships the Intel image. No version numbers are hardcoded anywhere on the page.

