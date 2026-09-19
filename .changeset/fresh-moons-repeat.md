---
"@internal/desktop-server": patch
"@internal/server": patch
---

Setting an https address for your server no longer locks the app out of it.

The app kept opening its own window on `http://127.0.0.1:<port>`, and a server
whose public address is https marks its session cookies so a browser will not
keep them on an http page — so the window explained why it could not sign in
and offered nothing to do about it. It opens on the address you configured now,
and the field says what to expect: a restart and a sign-in.

Only an https address moves the window. Every other setting opens exactly where
it always did.
