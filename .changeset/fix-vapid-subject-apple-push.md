---
"@internal/server": patch
---

fix(notify): VAPID subject defaults to the instance URL — Apple's web push refuses a localhost mailto contact (403 BadJwtToken) while FCM tolerates it, so iOS PWA pushes could never arrive on instances using the generated subject. A stored localhost subject is normalized in place on load; the key pair (and every live subscription bound to it) is untouched.
