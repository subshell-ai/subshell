---
"@internal/server": patch
---

Running a re-registration key's install command now says so. A recovery key from a node's Re-register card produced the same script, and the same wizard, as a new-machine enroll: the first thing it asked was "Name this node", a question the recovery path ignores (the existing row keeps its own name), so the flow read like registering something new instead of re-associating the machine. With a key bound to an existing node the script now prints, before anything is asked: "re-registering the existing node '<name>': this machine takes over that entry (its name, shares and settings are kept)", and it supplies that name to the wizard itself so the question never appears. An explicit SUBSHELL_NODE_NAME still wins. The Re-register card's Terminal tab carries the same sentence. Keys that are absent, spent or expired still render the byte-identical usage script; only two kinds of LIVE key differ now, and either one already hands its holder the node.
