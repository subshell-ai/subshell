# One new-account form; the login page paints its providers

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**There is ONE new-account form.** `components/account/new-account-fields.tsx`
renders the four fields (name, email, password, confirmation) plus the two
rules that make them usable (the password requirement stated before it is
broken, and a mismatch reported only once the confirm box is left), and both
callers use it: the first-run wizard's first screen and the Add user dialog on
`/settings/users`, which adds only the Role select that setup has no use for.
The admin's form used to be a thinner copy, so the person creating an account
for someone else got less help than the person creating their own.

**The login page paints its providers from the anonymous read** (spec
2026-09-24 §7, `routes/login.tsx` + `hooks/use-auth-providers.ts`): `GET
/api/settings/instance`'s `providers` list draws the provider buttons above
the passkey block, `emailSignIn` gates the password form AND the passkey
button (passkeys are credential accounts), and when no provider is open the page
says so rather than showing an empty card. The OAuth round trip is a
full-page redirect (`authClient.signIn.social`), and better-auth returns to
`errorCallbackURL=/login` with the outcome as `?error=…`.
`lib/sign-in-diagnosis.ts` is the ONLY mapper, pure and tested:
`pending_approval` navigates to `/pending` carrying the echoed email, and
that code's `error_description` is the only free text that may render as an
address; `unable_to_create_session` (the first arrival at a
`require_approval` provider; the redirect cannot tell pending from disabled)
renders one honest line true for both, and a fresh sign-in attempt retires
the consumed refusal. Everything else the trip can carry renders too:
the `refused` reading shows the sanitized, capped `error_description` as
prose, or the generic fallback sentence, above the provider block; unrecognized
codes used to be stripped and paint NOTHING (final review, Important 2),
which is what `routes/__tests__/login.test.tsx` now pins, render and param-
strip and clear-on-attempt together. Button labels wear the provider's NAME for every kind
(`signInButtonLabel`: same-kind rows are legal, and a kind-first label makes
them a mis-click lottery). `/pending` is the third bare frame beside
`/login` and `/setup`; its "Sign in again" navigates to `/login`, and the
next round trip re-lands here while the row is still pending, which is how
the wait re-checks the provider for free; it is also exactly how a rejected
person sees the identical screen (rejected and
pending are indistinguishable from the visitor's side; the truth lives on
Settings → Auth and the Users page's **Pending approval** tab, which reads
`GET /api/users/pending` and whose Approve/Reject buttons drive
`PATCH /api/users/:id/approval`). The Users table's Provider column renders
each member's linked providers as badges, and the row-action menu hides "Reset
password" for rows with no credential account.
