---
"@subshell-ai/plugin-api": patch
---

`supervisedProcess` may return a promise

The contract widened at its first real use. The spec requires an ABSOLUTE
`command`, resolved through `host.findBinary` — which is async — and the host
re-asks `supervisedProcess` at every boot, on a fresh process where no earlier
call cached anything. A purely synchronous member would have forced plugins to
remember the path from a previous run (state the contract forbids) or arm
nothing after a restart — silently breaking the "published survives a
reboot" guarantee that member exists to serve. The host's boot pass now awaits
the result; plugins that need no lookup may keep returning the spec directly.
