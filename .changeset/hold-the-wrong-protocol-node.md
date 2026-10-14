---
"@internal/server": patch
---

Hold nodes the protocol gate refused mid-handshake, so Update can reach them. An encrypted-link agent one protocol behind an upgraded server used to be closed with "protocol mismatch" and redial forever, showing only as offline with an Update button that refused. It now finishes its handshake, is held offline-for-everything-but-update, and the Updates page's Update button rescues it in one click.
