import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { APP_BASE_URL } from "@/constants.js";
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from "@/modules/auth/session-cookie.js";

/** The live schema is served locally, so automation needs no external documentation service. */
export const openApiPlugin = new Elysia({ name: "api-documentation" })
  .use(
    openapi({
      path: "/docs",
      specPath: "/openapi.json",
      // A root-relative schema URL also works when the browser opens /docs/.
      scalar: { url: "/openapi.json" },
      documentation: {
        info: {
          title: "Subshell API",
          version: "1",
          description:
            "Use Authorization: Bearer <API key> for automation. System keys act as the shared system account, not their creator. New system keys require explicit permissions selected by an admin; unselected permissions are denied. POST /api/nodes/setup-keys creates a single-use, 24-hour setup key; redeem it with subshell setup on the target machine (or POST /api/nodes/enroll). Enabled keys can configure only system-owned machine nodes, never the server host or another user's nodes. Instance enrollment policy still applies. Browser-only administrative and node lifecycle operations reject API keys. See each operation's x-api-key-permission for its required grant. Scoped keys cannot call authenticated routes without an explicit grant. Selecting all grants stores the current list, not future permissions. This schema and /docs are available on this server without a login.",
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "System API key with the permission named by the operation’s x-api-key-permission.",
            },
            sessionCookie: {
              type: "apiKey",
              in: "cookie",
              name: new URL(APP_BASE_URL).protocol === "https:" ? SECURE_SESSION_COOKIE : SESSION_COOKIE,
              description: "Browser session. Administrative operations require an admin session.",
            },
          },
        },
      },
    }),
  )
  // Preserve the plugin's previous JSON URL for existing consumers.
  .get("/docs/json", ({ redirect }) => redirect("/openapi.json"), { detail: { hide: true } });
