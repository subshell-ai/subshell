---
"@internal/server": patch
---

The auth provider dialog no longer closes when you click outside it, so a half-typed issuer or client id survives a stray click (it joins the other form dialogs behind the shared close-only-on-deliberate-act guard, so Escape keeps it open too). It also no longer draws a second scrollbar inside the dialog: the extra height cap and overflow on the panel stacked one bar atop the shared dialog's own scroller.
