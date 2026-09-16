---
"@internal/server": patch
---

Network results speak the product, not the config file

The card's green lines used to append what the write changed — ENV-key names concatenated into a success sentence nobody reading it asked for. They now say what the person can do ("Published on Tailscale — your other devices can open this dashboard over it once the server restarts"), removals name the ending rather than a subtraction, and the refused-write notes lead with the outcome and keep the key (`TRUSTED_ORIGINS`, `config.env`) only as a mono pointer naming where the change has to be made instead — because a symptom that names nothing is the defect the original 403 story taught us. Tense is honest throughout: nothing says "can" while a restart is still owed.
