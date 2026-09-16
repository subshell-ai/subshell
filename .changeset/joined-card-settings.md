---
"@internal/server": patch
---

A joined network card leads with what is pending, not with setup fields

The settings fields — a self-hosted network's "Management URL" and its disabled save button — opened every network card, including one whose network had long since joined, above the one press still waiting there. On joined and published rows they now sit behind a "Change settings" disclosure at the bottom of the card, refusal reasons and disabled inputs intact. A row still setting up keeps its fields inline, and a row with a required field unset always shows that field and why it blocks; the first-run wizard is unchanged.
