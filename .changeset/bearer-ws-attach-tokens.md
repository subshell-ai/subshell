---
"@internal/server": minor
---

`POST /api/auth/ws-token` accepts Bearer API keys. A system key may mint a terminal attach token for any single subshell it names; a subshell's own key may mint only for its own pane, so the sibling-keystroke-injection the route was cookie-only to prevent stays refused — by an equality check now, not by the whole door being shut. Every machine-minted token is bound to its one subshell at issue time, the bind is enforced at redemption (a wrong-subshell attach gets the bad-token refusal and burns the token), and `/ws/live` refuses scoped tokens outright, so the whole-user feed stays human-only. A script holding an API key can now drive and measure a real pane end to end: mint, attach `/ws?subshell=…`, type, watch acks.
