---
"@internal/server": patch
---

A node's Service, Configuration and Logs tabs now actually open their pages.
They were wired as child routes of the Overview, which renders no outlet, so
clicking one changed the URL and the highlight while the Overview content
stayed on screen. The Maintenance switch also stopped labelling itself by
state: its label now reads "Maintenance mode" in both positions (ON = in
maintenance, like `subshell maintenance on`), and "Accepting new subshells" /
"In maintenance since …" is its own state line below.
