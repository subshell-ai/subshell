---
"@subshell-ai/plugin-api": patch
"@subshell-ai/plugin-tailscale": patch
"@subshell-ai/plugin-headscale": patch
"@subshell-ai/plugin-netbird": patch
"@subshell-ai/plugin-cloudflare-tunnel": patch
"@internal/server": patch
---

The networking page reads like a form now

Three copy fixes from an operator working through the live Headscale and
NetBird cards. Each address in the Addresses list leads with its kind label
above the URL — "NetBird FQDN", then the address — instead of a big bold URL
with a small muted tag trailing it, which read as two disjoint things. The
disabled Connect/Sign-in reason now says `Save the Control server URL first.`
— naming the button that actually delivers the value, and keeping the label's
own casing so the sentence names the same box the form does. And every
credential box that can — all four built-ins now do — carries a Docs link
beside its label, pointing at the vendor page where that key is minted:
"Auth key" told you what to paste, and nothing on the card said where to get
one. The link is new manifest data (`labels.credentialDocsUrl`, http(s)
refused at parse), so third-party network plugins can carry one too.
