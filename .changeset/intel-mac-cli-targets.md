---
"@internal/server": minor
"@internal/node": minor
"@internal/desktop-server": minor
"@internal/desktop-client": minor
"@internal/docs": patch
---

Intel Macs (darwin-x64) are a published target again, for every component. `install-server.sh`, the server-rendered node enroll one-liner, self-update, and the downloads route resolve an Intel host to the `darwin-x64` artifact instead of refusing it by name. The desktop apps publish a second Mac image, `Subshell-<App>-Desktop-<version>-darwin-x64.dmg`, cross-built by `tauri build --target` on the Apple Silicon runner. The release pipeline cross-builds and exec-smokes CLI binaries under Rosetta; the desktop smoke verifies the bundle's signing chain, the staple, and the nested sidecar's Mach-O slice.
