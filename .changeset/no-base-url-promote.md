---
"@internal/server": patch
---

The publish flow no longer offers to set the server's base URL

One checkbox that moved the passkey rpID turned out to be the most confusing
control on the Networking page: it sat in a flow about REACHING the server
while its consequence was about the server's IDENTITY, and every card carried
its own copy competing for the instance's single `APP_BASE_URL`. Publishing
now only widens `TRUSTED_ORIGINS`, as it always did. The base URL is set
where the rest of the server's config is set — Server Settings → Service —
and that field names the passkey consequence the checkbox buried.
