# Build

## When to Run `turbo build`

Run `turbo build` after making changes to:

- **Backend API routes or schemas** - `@internal/backend-client` is an Eden Treaty
  client (`treaty<App>()`), so its types are *inferred* from the backend's exported
  `App` type. Rebuilding the backend is what makes a new route visible to the client.
  Nothing is generated from the OpenAPI spec — a route's `operationId` only feeds the
  runtime `/docs` page, and no named client function is ever emitted for it.
- **Any package in `packages/`** - ensures dependent apps receive the updates

```bash
turbo build
```

The Turbo pipeline handles the correct build order automatically.
