import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";

const MetaStatusSchema = t.Object({
  appVersion: t.String({ description: "App version" }),
  serverTime: t.String({ description: "Server time (ISO)" }),
});

const VERSION = "1.0.0";

export const metaRoutes = new Elysia({ prefix: "/api/meta" }).use(authGuard).get(
  "/status",
  async () => {
    return { appVersion: VERSION, serverTime: new Date().toISOString() } as const;
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
