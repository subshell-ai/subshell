---
"@internal/server": minor
---

Add categorized API key permissions with individual, category-wide, and global selection. New keys default to no permissions and require an explicit grant for each endpoint, including node enrollment and configuration. Preserve permission ceilings on child credentials and expose required grants through local OpenAPI JSON at `/openapi.json`.
