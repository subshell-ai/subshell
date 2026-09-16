---
"@internal/server": patch
"@subshell-ai/plugin-tailscale": patch
---

The first-run Network step shows one collapsed row per network, with a Configure button

Every network plugin rendered as a full card on the wizard's Network step,
split into "networks this machine has" and an "Other networks" disclosure.
On a fresh install the first group is empty by definition, so the step
opened on a heading relative to nothing, followed by two numbered sudo
commands, three Docs links and a Re-check button — for a step whose own
framing says it is optional.

Each network is now a row in the shape the Add an Agent step already uses:
icon, name, a state chip ("Not installed", "Not signed in", "Joined",
"Published", …) and one button. Configure expands the same card the
Networking settings page renders, in place; Manage once published; Hide
folds it away. Unsupported and disabled networks show their chip and no
button.

Two things found on the same screen: a network plugin's icon 404'd because
the icon route consulted only the harness registry, so Tailscale rendered as
a "T" monogram; and "Let this server drive it" — the label for Tailscale's
`--operator` grant — now reads "Allow this server to control Tailscale", in
the manifest's step, the needs-permission hint and the publish refusal.
