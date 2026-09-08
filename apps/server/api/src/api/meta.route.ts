import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SERVER_VERSION } from "@/version.js";

const MetaStatusSchema = t.Object({
  appVersion: t.String({
    description: "Server app version (apps/server/api package.json) — per-app, not instance-wide",
  }),
  serverTime: t.String({ description: "Server time (ISO)" }),
});

export const metaRoutes = new Elysia({ prefix: "/api/meta" }).use(authGuard).get(
  "/status",
  async () => {
    return { appVersion: SERVER_VERSION, serverTime: new Date().toISOString() } as const;
  },
  {
    response: MetaStatusSchema,
    detail: {
      operationId: "getMetaStatus",
      tags: ["meta"],
      description: "App version + server time",
    },
  },
);
