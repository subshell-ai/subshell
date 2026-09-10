---
"@internal/server": patch
---

**The node page reports what the machine can RUN.** The harness card on a node's page was still a plugin manager after the plugin move: its Install and Remove buttons POSTed to a per-node route that no longer exists, and its "not usable" and "restart the agent" notices described plugin loading in the control-plane process, which is not a fact about one machine.

The card is detection output now. One row per plugin the instance has installed, each saying whether this machine found the program it drives, at which version, and when it was last checked; a stale cached answer is labelled last-known instead of pretending to be live. Rows for plugins the instance dropped are simply gone, and a plugin that fails to load in the server is said where it belongs, on Settings → Plugins, which the card now links to. Its one control is Re-check, offered to the node's manager on enrolled nodes only (the control-plane host probes live on every read).
