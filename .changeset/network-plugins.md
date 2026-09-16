---
"@internal/server": minor
"@subshell-ai/plugin-api": minor
---

Connect this server to a private network, from a page instead of a config file

Subshell has always been meant to be reached remotely across a perimeter you
already own — a VPN, a mesh, a tunnel. Building that perimeter was yours to do,
and the server only told you about it afterwards, as a `403 Invalid origin` on
the sign-in page that named nothing you could change. The Add-node dialog's
advice was "replace the host with this machine's VPN/LAN address".

**Settings → Networking**, and an optional first-run step, now do it. Connect
the server to a network, publish it there, and the address flows into the
trusted origins and the enroll command by itself. **Tailscale** ships first:
paste an auth key or sign in through a link the page shows you, then publish at
`https://<host>.<tailnet>.ts.net`.

It is a new kind of PLUGIN rather than four integrations wired into the stack,
so the same store, install door and admin gate that govern agent plugins govern
these, and anyone can publish one for a network we have not thought of. A
network plugin describes and the host executes: it returns commands, parses
their output and names a credential, but never spawns a process, writes a file,
edits your config or reads a credential back.

Three things it will tell you rather than let you discover:

- **What needs root, and that this server will not do it.** Every mesh VPN
  installs a daemon as root, and the server has no terminal to answer a
  password prompt. Those commands are shown to copy, never run behind a button
  that could only fail. For Tailscale that is the whole install.
- **What a browser will refuse at each address.** A mesh address over plain
  http is encrypted end to end and still will not do passkeys or `Secure`
  cookies. Publishing adds an address to the trusted origins, which is safe;
  promoting one to the server's base URL moves where passkeys work, which is
  opt-in and says so.
- **Which networks work on this machine at all.** Support is declared per
  platform, so a row reads "not available on macOS" instead of offering a
  button that returns an error.

Headscale, NetBird and Cloudflare Tunnel follow. Cloudflare will refuse to
publish until a Cloudflare Access application covers the hostname, and the
server will verify that assertion itself — it reaches the public internet,
which the rest of these do not.
