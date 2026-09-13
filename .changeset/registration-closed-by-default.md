---
"@internal/server": minor
---

Registration is closed by default. An instance used to ship accepting sign-ups from anyone who could reach it until an admin noticed and turned them off; the permissive state is the one an operator should have to choose.

The exception is what makes the default possible rather than a softening of it: sign-up stays open while the instance has **no users at all**, because the first account registered becomes the admin. Without that, a closed empty instance could never mint the one person able to open it, and a fresh install would be bricked behind a sign-up form that refuses. The door is open exactly until someone walks through it, and closes behind them. An admin who wants open registration afterwards turns it on under Settings → General, and that is recorded in the audit trail.

Nothing changes for an instance that has already answered the question: an explicit yes or no is still honoured exactly as before, and a corrupt setting still fails closed.
