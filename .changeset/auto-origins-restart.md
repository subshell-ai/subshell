---
"@internal/server": patch
---

Trusted origins now have the lifecycle of the publish that added them, and the restart that lands a change can be taken from the result that needs it

Publishing already added its addresses to `TRUSTED_ORIGINS`; unpublishing now takes exactly those back through the same config writer — origins no publish ever matched survive every cycle — the subtraction is by value, so a hand-added entry equal to a published address leaves with it, and a key the server's environment owns is refused by name while the unpublish itself completes. No kind is exempt: a NetBird unpublish clears its record and takes its origins back too — after a disable the daemon may still answer at its address, and what changes is that the address stops accepting sign-ins when the restart lands, the stated and chosen cost of letting a publish own an origin's lifecycle.

Network plugin manifests that pair `publishImplicit: true` with a non-`private` exposure are now refused at load: implicit publishing means the JOIN records and trusts the addresses with no press to warn at, and that is only sound on a network whose addresses cannot reach the open internet.

Joining NetBird now completes the whole path to "other devices can open this dashboard" in one press plus one confirmation: the join itself records the publish and widens `TRUSTED_ORIGINS` through that same writer, so the separate box under "Publish" is gone — the rare gap where the address table never settled still shows a single line and the press.

And where a publish or unpublish ends with `restartRequired`, the card's result offers the Service page's own restart button and confirmation — the one that names what it costs running subshells — locks the card's acts while the server is out, and refetches the row and the public settings the moment it is back.
