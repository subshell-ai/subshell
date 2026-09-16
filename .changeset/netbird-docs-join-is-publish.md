---
"@subshell-ai/plugin-netbird": patch
---

The README says what joining does now

"Unpublish is therefore a no-op" was true of the plugin's own half and
misleading about the whole act: joining now records the publish and trusts
its origins, and the host's unpublish strips them at leave, disable or
uninstall. Documentation-only; the plugin's code never changed.
