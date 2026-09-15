---
"@internal/server": minor
---

Admins can disable a user account, which signs them out everywhere and refuses every credential they hold, including the bearer tokens their running subshells authenticate with. Enabling restores it. Nobody can disable or re-role their own account, since an admin who removes their own administration cannot undo it without another admin. The Add user dialog asks for the role first, and both role controls on the page spell each role one way. Display names are normalized and capped like every other person-chosen label, on the admin route and at first-run sign-up.
