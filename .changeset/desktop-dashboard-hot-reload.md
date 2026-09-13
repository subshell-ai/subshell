---
"@internal/server": minor
"@internal/desktop-server": minor
"@internal/desktop-client": patch
---

The Addresses form on Server Settings → Service checks what you typed before sending it, and says what is wrong under the field it is about. The rules are the server's own — the same ones `subshell-server configure` applies — so the form cannot refuse a value the server would have taken, or accept one it would not. Save is now "Save and restart", and goes through the same confirmation as the Restart button, since saving an address the server is not listening on was never the point; cancelling that confirmation still leaves the change saved. Each field explains the mistake it invites — which bind address is the permissive one, and that a browser at an unlisted address is refused at sign-in with "Invalid origin" — instead of one sentence glossing all four.

Where a restart would close running subshells, the dashboard now names the command that fixes it (`subshell-server service install`) rather than telling you to "reinstall the service definition", which is not something the dashboard can do. It no longer warns about a service definition on machines that have none.

Both About boxes read "Desktop app" and "CLI", the same words the downloads carry. Subshell Server's said "Server" and "Subshell Server" — two programs named one word apart, usually showing the same version.

For developers: `bun run dev:desktop-server` points the dashboard window at the SPA's dev server when one is running, so edits to the dashboard hot-reload. It never did before — that window loads the installed binary's embedded SPA — and the Service and Status pages say so while it is in effect.
