---
"@internal/server": minor
---

Admins can assign roles and reset other users' passwords.

Creating users already existed; this adds the two operations that were missing
from the Users page.

- `PATCH /api/users/:id/role` — assign Admin or User. **Demoting the last admin
  is refused**, counted and written in one transaction so two concurrent
  demotions cannot both succeed and leave an instance nobody can administer.
  Stepping down yourself is allowed while another admin remains.
- `PATCH /api/users/:id/password` — set another user's password and **sign them
  out of every device**. A reset is usually an answer to "this account may be
  compromised", so leaving live sessions would achieve nothing.

Both are admin-only over a browser session; bearer keys are refused like every
other admin surface. The `system` service account cannot be modified, and an
admin cannot reset their own password here — Account is the path that requires
the current one. Audited as `user.role_change` and `user.password_reset`; the
password itself is never logged, echoed, or audited.
