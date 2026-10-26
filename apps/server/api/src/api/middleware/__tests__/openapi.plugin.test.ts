import { describe, expect, it, spyOn } from "bun:test";
import * as staticPlugins from "@/api/middleware/static.plugin.js";
import { APP_BASE_URL } from "@/constants.js";
import { createApp } from "@/server.js";

describe("production API documentation", () => {
  it("serves the live schema before the SPA fallback and declares enrollment authentication", async () => {
    // Exercise production route ordering without requiring a prebuilt SPA on a clean checkout.
    const staticSelection = spyOn(staticPlugins, "selectStaticPlugin").mockReturnValue(
      staticPlugins.embeddedStaticPlugin({ "index.html": Buffer.from("<html>SPA fallback</html>").toString("base64") }),
    );
    let app: ReturnType<typeof createApp>;
    try {
      app = createApp();
    } finally {
      staticSelection.mockRestore();
    }
    const response = await app.handle(new Request("http://localhost/openapi.json"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const schema = (await response.json()) as {
      components: { securitySchemes: { sessionCookie: { name: string } } };
      paths: Record<string, Record<string, { security?: unknown; parameters?: unknown[] }>>;
    };
    expect(schema.paths["/api/nodes/"].get.security).toEqual([{ sessionCookie: [] }, { bearerAuth: [] }]);
    expect(schema.paths["/api/system-keys/"].post.security).toEqual([{ sessionCookie: [] }]);
    expect(schema.paths["/api/nodes/enroll"].post.security).toBeUndefined();
    expect(schema.paths["/api/nodes/{id}"].patch.parameters).toBeDefined();
    expect(schema.components.securitySchemes.sessionCookie.name).toBe(
      new URL(APP_BASE_URL).protocol === "https:" ? "__Secure-better-auth.session_token" : "better-auth.session_token",
    );
    for (const path of ["/docs", "/docs/"]) {
      const docs = await app.handle(new Request(`http://localhost${path}`));
      expect(docs.status).toBe(200);
      const html = await docs.text();
      expect(html).toContain('"url":"/openapi.json"');
    }
  });
});
