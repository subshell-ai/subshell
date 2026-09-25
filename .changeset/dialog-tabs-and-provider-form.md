---
"@internal/server": patch
"@internal/node": patch
---

Dialog and tab-strip polish, and the provider admin's sharper edges. Dialog actions stay in one right-aligned row and dialog headers stay left, always: shadcn's viewport breakpoints (stack under 640px, center until 640px) tested the WINDOW, so page zoom or a narrow shell re-stacked buttons and centered text inside a comfortably wide dialog. Page tab strips (Users, Logs, Nodes) are content-sized now instead of stretching two labels across the page; the equal-share switch stays for in-row controls. The copy icon shrank to sit inside value rows. On Settings → Auth: the provider form shows its slug id live under the name, the remove confirmation lists its effects and names the exact row (slug id and issuer) and notes that re-adding the same slug id restores the accounts, close-capable toggles are DISABLED with a tooltip when a provider is the last open one (the 409 remains the enforcement, it just stops being the introduction). The `cli-node` bump covers only the smaller copy icon, which the node dashboard shares.
