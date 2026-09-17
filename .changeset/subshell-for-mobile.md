---
"@internal/server": minor
---

The dashboard now says how to put Subshell on a phone, and answers the hard half of it

The SPA has been an installable PWA for a while and nothing on any surface said so. A new **Subshell for Mobile** row at the foot of the sidebar's navigation opens a dialog with the install steps for a desktop browser, for iPhone and iPad, and for Android, as a tab group that opens on whichever device is reading it.

The steps are the easy half. The harder one is that the person looking them up is usually at a desk, on an address their phone cannot reach — `localhost` most of the time. So the dialog offers every address this server accepts a sign-in from, ordered with the reachable ones first and the loopback ones listed and labelled "this device only", and encodes the chosen one as a QR code beside a copyable link. Picking a different address re-renders both.

It is honest about what an address costs: over plain `http://` an iPhone still adds the app to the Home Screen, but notifications never arrive there and Chrome offers a shortcut rather than an app — with the remedy named only for someone who can take it. Choosing an address a phone cannot reach replaces the QR with a sentence naming it, so nothing unscannable is ever offered — and on an instance that knows no reachable address at all, which is every stock install, that sentence says so instead.

`GET /api/settings/public` carries a new `trustedOrigins` field to make this possible, which is what the dialog reads. It is a deliberate widening — any signed-in caller now learns this instance's other names — recorded in `docs/security.md` §3.

Two existing surfaces change as a result of the helpers moving into shared code. The loopback check behind the Add-node dialog's "a remote machine cannot dial this address" warning matched `127.` as a string prefix, so it fired on hosts like `127.0.0.1.example.com`, which are somebody else's domain entirely.

And the iOS check behind the notifications card's "use Share → Add to Home Screen first" line now recognises an iPad running iPadOS 13 or later, which requests desktop sites by default and so calls itself a Macintosh — it reports touch points, and no Mac does. That line was previously absent on exactly the devices it was written for.
