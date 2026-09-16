---
"@internal/server": patch
---

The network card stops printing its install steps twice, and leads with what is wrong

A `not-installed` Tailscale row rendered the whole install sequence twice —
"1. Install the Tailscale daemon", "2. Let this server drive it", then the
sentence explaining the state, then "3. Install the Tailscale daemon",
"4. Let this server drive it" — with the only sentence that says WHY buried in
the middle of it, in the same muted grey as a step label.

One cause behind both halves. The install steps live in the plugin's
`package.json` as data the page renders before any plugin code loads, and the
plugin ALSO emitted them as status hints; each side was written believing it
was the only one rendering them. The plugin now contributes the one thing a
manifest cannot know — which state this machine is in — and the steps are
rendered once, from the manifest.

That sentence now opens the card as a notice, above the steps it explains,
rather than below them. Only sentences BEFORE a plugin's first command are
hoisted: one that follows a plugin's own commands says what to do once they
are done, and lifting it would state the last instruction first.
