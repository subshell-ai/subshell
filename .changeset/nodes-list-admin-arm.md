---
"@internal/server": patch
---

An admin's Nodes list now shows every machine on the instance, not only the ones they own or were granted. The admin's edit access to a foreign node was already answered by the detail route, and the Updates page listed every agent, but the list query filtered owner/share rows before the admin boost could apply. A node owned by another account, in the measured case a held machine whose old agent the updated server refuses, appeared on Updates yet was absent from the one page that manages nodes: unshareable, unreachable for maintenance, invisible. The list now answers the same visibility question the detail gate answers (`edit`, never manage/delete/re-share), while non-admin lists are unchanged: a private foreign node stays absent.
