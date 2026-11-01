---
"@internal/server": patch
---

Fixed "Update all" failing on most nodes when many are registered. An update now fetches the release bytes it's about to authorize before ordering the download, and a fleet of simultaneous node downloads shares one fetch of those bytes instead of each paying for its own. On a plane with a hand-published node binary, this was the difference between every machine timing out on the first try and the whole batch updating at once.
