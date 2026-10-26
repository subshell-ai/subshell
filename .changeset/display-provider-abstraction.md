---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Separate virtual display providers from viewer connections and launch settings. Allow node owners to enable multiple display providers and choose a default, with Xvfb + VNC as the initial option. Persist per-subshell provider choices for restart and preserve display requests in presets. Check requirements for the selected provider and preserve existing displays when the selection changes.

Order provider allocation and cleanup per subshell, recheck permission after asynchronous prerequisites, and verify VNC listener ownership during allocation and recovery. Reserve viewer ports before probing to prevent concurrent displays from selecting the same port.
