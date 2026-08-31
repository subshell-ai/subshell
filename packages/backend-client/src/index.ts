import { treaty } from "@elysiajs/eden";
import type { App } from "@internal/backend";

export type { App } from "@internal/backend";

export type BackendClient = ReturnType<typeof treaty<App>>;

export function createBackendClient(baseUrl: string): BackendClient {
  return treaty<App>(baseUrl);
}
