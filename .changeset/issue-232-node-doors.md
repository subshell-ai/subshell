---
"@internal/node": minor
"@internal/desktop-client": minor
"@internal/docs": patch
---

feat(node), feat(desktop-client): the node role gets its reset doors (issue #232). New CLI verbs: `subshell reset` stops the daemon, closes this machine's pane servers, removes the service definition, and deletes the data directory, the daemon lock and `config.json` (the node key's only home) last, keeping the binary; `subshell uninstall` adds the binary and asks separately, default NO, whether the data goes too (`--reset-data` is the scripted yes). Consent is the machine's NAME typed at the prompt or `--confirm <name>`; `--yes` is refused by name, and once consent is given a step that cannot run is reported and the clear continues. The Subshell Client's tray gains **Reset…**, raising the page's existing typed-hostname dialog from any state. Docs: the node CLI reference gains the verbs and a reset/uninstall section.
