---
"@internal/docs": patch
---

Docs for sign-in providers. A new Server page (Sign-in Providers) covers the Settings → Auth list: adding a provider as a trust decision (a provider's verified email claim links straight into the matching account), what the save verifies, the per-provider switches, the last-open-provider guard, and the approval queue. Registration & Enrollment moves its switch from Settings → General to the E-mail provider's row (where spec 2026-09-24 put it) and points at the providers for the per-provider answers. The security overview's anonymous-read sentence now names the open-provider list the sign-in page reads, and gains the provider trust accounting; the Users page's Pending tab and the audit trail's provider and approval rows are documented.
