---
"@internal/server": major
"@internal/node": major
"@internal/docs": patch
---

Add web previews, browser watching, saved web services, and virtual displays to subshell workspaces. Open each view in its own draggable tab beside the terminal, move it between splits, or use full screen. Closing a preview leaves its terminal and sibling views running.

Node settings independently control web previews and virtual displays. Enabling web previews makes them available to the node’s subshells. Virtual displays are requested at launch, use the node’s selected provider, and check prerequisites before starting. Xvfb + VNC is the initial provider and requires Linux with Xvfb, x11vnc, and xauth. Provider changes apply to new displays; existing displays keep running. The server’s built-in node uses the same runtime as enrolled nodes.

Expose feature permissions, display-provider selection, prerequisites, and view controls through MCP. The UI explains disabled features and links to setup documentation. Preview choices use compact rows with plain port numbers, and phone previews preserve the desktop workspace layout.

Isolate web-preview scripts from dashboard credentials and browser storage, restrict viewers to authorized resources, and revoke views when access changes or subshells stop. Keep target cookies on the server, bound transport buffers and image dimensions, verify display process ownership before cleanup, and redact preview capability references from diagnostics.
