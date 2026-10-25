---
"@internal/server": major
"@internal/node": major
"@internal/docs": patch
---

Add web previews, browser watching, saved web services, and virtual displays to subshell workspaces. Open each view in its own draggable tab beside the terminal, move it between splits, or use full screen. Closing a preview leaves its terminal and sibling views running.

Node settings independently control web previews and virtual displays. Enabling web previews makes them available to the node’s subshells. Nodes can enable multiple display providers and choose a default. Virtual displays are requested at launch, use the default or a selected enabled provider, and check prerequisites before starting. Xvfb + VNC is the initial provider and requires Linux with Xvfb, x11vnc, and xauth. Presets can save a provider choice. Each subshell keeps its resolved provider and display size on restart, even when the node default changes. Disabling a provider prevents new displays and restarts without stopping existing displays. The server’s built-in node uses the same runtime as enrolled nodes.

Expose feature permissions, display-provider selection, prerequisites, and view controls through MCP. The UI explains disabled features and links to setup documentation. Switching nodes clears incompatible agent and display selections, resets the working directory, and explains the corrections. Preview choices use compact rows with plain port numbers, and phone previews preserve the desktop workspace layout.

Isolate web-preview scripts from dashboard credentials and browser storage, restrict viewers to authorized resources, and revoke views when access changes or subshells stop. Keep target cookies on the server, bound transport buffers and image dimensions, verify display process ownership before cleanup, and redact preview capability references from diagnostics.
