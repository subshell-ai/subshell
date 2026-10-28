---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/docs": patch
---

Bound terminal WebSocket input by frame count and UTF-8 payload bytes per connection and across the server, including dispatched writes and retries. Close connections that exceed the limits and prevent late failures from recreating retry queues after disconnect. Document the limits and recovery behavior.
