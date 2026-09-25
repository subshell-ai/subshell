---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Intel Macs (darwin-x64) are a published target for both CLIs again. `install-server.sh`, the server-rendered node enroll one-liner, self-update, and the downloads route all resolve an Intel host to the `darwin-x64` artifact instead of refusing it by name. The release pipeline cross-builds the triple on the Apple Silicon runner and exec-smokes it under Rosetta. Desktop apps are unchanged: they still ship for Apple silicon Macs and Linux x86_64 only, and `install-client.sh` keeps its by-name Intel refusal.
