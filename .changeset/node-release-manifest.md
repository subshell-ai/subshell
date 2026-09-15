---
"@internal/node": patch
---

Every agent release now publishes a `release-manifest.json`

A fifth asset beside the three binaries and their digests: the component id,
the version, this build's `NODE_PROTOCOL_VERSION` and `MIN_AGENT_VERSION`, and
the commit it was cut from.

It exists so a control plane can answer "can I talk to the agent in this
release" from 200 bytes rather than by downloading an 80 MB binary — and that
question was previously not asked at all. The plane offered a node the newest
release above its agent floor, which on a plane one version behind installs an
agent speaking a protocol the plane does not: that node enrols, reconnects, and
is closed 4406 forever. A release carrying no manifest is now refused BY NAME
rather than guessed at, so the first cut after this is the first one plane-side
node updates can use.
