---
"@internal/server": minor
"@internal/desktop-server": minor
"@internal/docs": patch
---

feat(server), feat(desktop-server): reset now has doors everywhere it is needed (issue #232). New CLI verbs: `subshell-server reset` runs the assistant's chain without a window (stop, close the pane servers, remove the service definition, delete exactly the paths `status` publishes; the binary stays for a fresh `init`), and `subshell-server uninstall` removes the service and the installed binary (plus its `.previous`) and ASKS, separately and default NO, whether the data and settings go too: `--reset-data` is the scripted yes, and a headless run without it keeps the bytes. Both confirm by the machine's NAME typed at the prompt (or `--confirm <name>` for a terminal-less run); `--yes` is refused outright for both, the way it cannot buy a live daemon elsewhere. Once the name matches, a step that cannot run is reported and the clear continues; the exit code carries the failures (the desktop chain keeps its abort-and-retry shape). The Subshell Server app's tray menu gains **Reset…**, so a machine caught mid-first-run (wrong install, account page with no way back) reaches the same confirmation the dashboard card raises, over any screen. Docs updated, including the reversed ruling that the CLI would never carry a reset verb.
