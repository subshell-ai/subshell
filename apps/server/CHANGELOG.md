# @internal/server

## 1.2.0

### Minor Changes

- [`87d9edb`](https://github.com/subshell-ai/subshell/commit/87d9edb5716a9f08dbb0ddf376ddfb3cb11f998d) Thanks [@theogravity](https://github.com/theogravity)! - Sidebar upgrade (rides the embedded SPA): recent sessions carry live status dots — working / idle / waiting-for-you / exited / ended / node-unreachable, one precedence shared with the home cards — and the rail sorts them live-first (waiting → working → idle → node-offline → exited → ended). A filter field searches all sessions; `+` buttons launch a subshell or open the new-workspace dialog, which now lets you pick existing sessions (multi-select) or launch one BEFORE the workspace exists. Sessions can be dragged from the sidebar straight into a workspace dock (adds a pane, focuses an existing one, never duplicates) or onto a workspace card. One SSE feed at the app root keeps every list current on every page.

## 1.1.0

### Minor Changes

- [`a76236e`](https://github.com/subshell-ai/subshell/commit/a76236e1c09cab7a3d93048198cc8e7bc8f7cb5a) Thanks [@theogravity](https://github.com/theogravity)! - Remote folder picking: the new-subshell form's folder picker now browses the selected node, not just the control-plane host. The agent answers a new `fs_ls` command (node protocol v3, additive — v2 agents stay connected and merely can't be browsed: the picker says so); `GET /api/files/explore?node=<id>` dispatches it signed and passes the listing through in the local shape.
