---
"@internal/server": patch
---

Signing in or pasting a key is now a choice, not a form with two buttons

An operator working through the Headscale card read it backwards, and the card
was why. The auth key box sat at the top as a big empty field — with Connect and
"Sign in with Headscale" as two buttons underneath — so the optional path's
credential looked required, and two buttons side by side looked like related
steps rather than two exclusive ways to join.

The card now asks which way you mean, using the same segmented control the view
toggle and the add-subshell dialog use: **Sign in** or **Use auth key** ("Use
setup key" on NetBird, the vendor's own word lower-cased). Exactly one panel
shows beneath it, so the thing you did not choose is not on screen — an empty
box can no longer read as a field you owe somebody. Sign in is the default,
because the person at this page usually wants the browser flow; a pasted key is
what an automation or a headless host brings. The choice and what it chooses
between now sit inside one box, sized to its own labels rather than stretched
across the card, so it reads as a single question rather than a strip of tabs
above loose text. Either way the sign-in link and
its code stay visible below the choice, since they arrive from the network
whichever panel you were looking at, and a machine with only one way in —
Cloudflare Tunnel — is offered no fork at all.

The reason a join would be refused ("Save the Control server URL first.") moved
under the choice, because the server refuses either path while a required
setting is unset, and both buttons still carry it for a screen reader.
