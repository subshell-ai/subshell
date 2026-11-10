---
"@internal/server": patch
---

Adding a subshell to a populated workspace now selects the new tab. The workspace refetch could tile the pane first while its summary was still loading, leaving the previous tab active; the add handler now activates the pane after either path, including when the summary read fails.
