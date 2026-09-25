# Subshell for Mobile (the PWA install dialog)

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

`components/mobile-install-dialog.tsx`, opened from a row of the rail's
`<nav>`, above "Open in browser". Ungated, desktop shells included; it was
`!isDesktop()` for half a day on the reasoning that a Tauri webview cannot
install a PWA, which is true and beside the point: the dialog's payload is a
QR code, read by a DIFFERENT device, and somebody at Subshell Server on their
laptop is the likeliest person in the product to want Subshell on their phone.
The gate hid it from exactly them.

**The steps are the easy half.** The person looking them up is usually at a
desk on an address their phone cannot reach, so the dialog's first control is
an address picker. Candidates come from `lib/install-addresses.ts` (the
shared half, since the Add-node dialog grew the same picker):
`window.location.origin`, `appBaseUrl` and `trustedOrigins` merged, normalized
to origins and ordered by insertion (the address this browser is
demonstrably on is the best guess for the phone beside it). **And the picker
now explains nothing about itself** (operator's call, 2026-09-18): the
"every address this server accepts a sign-in from…" paragraph and the amber
plain-http note are gone: the audience is developers, and every clause
restated the address bar. The test pins the absence.

**Loopback rows are DROPPED in `installAddresses`, not labelled here.** They
used to be listed and captioned "this device only" (never hidden, never
disabled) because on a stock instance every address looked like that (the
`0.0.0.0` bind contributed none, so the list was the two loopback spellings
plus the dev Vite ports): a disabled version of that picker shipped for an
hour and could not be operated at all, and a hidden one makes the address
someone is looking at vanish. What made the caption survivable was that it
named the cost of a real choice; what makes dropping honest is the server's
LAN derivation (`services/lan-origins.ts`, server side), which puts rows a
phone CAN dial into that same list: a localhost row was never a choice for
the device this picker is for. When an instance genuinely knows no
phone-dialable address (a loopback bind, or a server predating the
derivation), the refusal renders WHERE THE QR WOULD BE, so nothing
unscannable is offered and the empty box names the remedy. Joined networks
keep the behaviour that made the refetch-on-open load-bearing: a tailnet's
addresses are in the list the moment the plugin reports them, with no publish
and no restart, and the empty state says to JOIN a network rather than publish
on one for exactly that reason.

`trustedOrigins` is a field on `GET /api/settings/public` added for this, and
it is the EFFECTIVE allowlist: local origins ∪ this machine's derived LAN
interfaces ∪ the Addresses card's extras ∪ every enabled network plugin's
addresses, computed live, and re-asked of the kernel by the read itself so a
laptop that switched Wi-Fi stops offering the network it left; its disclosure
is accounted in `docs/security.md` §3. Optional in the client type for the
usual reason (a cached PWA can outlive its server), and the dialog falls back
to the origin this browser is already on. `lib/setup-checklist.ts`'s
`lan-origin` item judges this same effective list, so a joined network (or,
since the derivation, the machine's own address on a wildcard bind) silences
it.

Two details that are not decoration. The QR's plate is `bg-white`
unconditionally, because a QR is read optically and dark modules on a dark
surface do not scan in either theme. And the tab group is three GESTURES, not
three brands, which is why macOS Safari sits under **Browser** beside Chrome
rather than under the Apple tab with the iPhone.
