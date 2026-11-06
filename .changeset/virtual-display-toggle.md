---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Turn a running subshell's virtual display on or off from the Web previews &
screens picker, or with the new set_subshell_display MCP tool. Turning a display
on restarts the subshell in place so its process starts on the new screen;
turning one off closes the screen immediately and frees the machine's memory
and CPU while the subshell keeps running. Nodes and the server must update
together (protocol 27).
