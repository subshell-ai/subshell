---
"@internal/server": patch
---

Three node-management UI changes. The Maintenance card's essay became two sentences and the state line now appears ONLY while a machine is in maintenance — "Accepting new subshells" under an off switch restated the switch's own position, while since-when and which-end-declared-it are facts someone acts on. And the control-plane host gets its Configuration tab back for admins: the sections move orphaned the LAUNCH ALLOWLIST on `local` — a rule the host genuinely has (spec 2026-09-05) and the plane enforces on its own launches — because the Configuration page was hidden for `local` along with the daemon sections that `local` truly lacks. An admin now sees Configuration on the Server's own page (launch rules only; the Server-URL card stays agent-only — repointing is a daemon concept), while Service, Logs and the `view` grantee's nothing are gated exactly as before. Deep links keep honouring the same predicates.
