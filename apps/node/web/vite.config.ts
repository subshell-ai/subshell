import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The node's own loopback dashboard. There is no auth and no cookie to carry:
// the dev server proxies /api to the daemon's dashboard port (`subshell run`,
// default 127.0.0.1:3090) so the browser talks to one origin, exactly as the
// server SPA's dev proxy does for :3080. No /ws — the dashboard has no live
// terminal, only polled reads and mutations.
export default defineConfig({
  plugins: [TanStackRouterVite({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5175,
    // Loopback only: this app drives the machine's node with no login, so the
    // dev surface keeps the same listen rule as the binary it previews.
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3090",
        changeOrigin: true,
      },
    },
  },
});
