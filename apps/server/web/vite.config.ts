import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Hostnames the dev server may be reached under, comma-separated — set
  // DEV_ALLOWED_HOSTS in .env.local when a reverse proxy sits in front of
  // it (otherwise Vite's dev-server host check answers "Blocked request").
  // No VITE_ prefix on purpose: it configures the server and must never
  // ship inside the client bundle. Unset keeps the localhost-only default.
  const allowedHosts = (loadEnv(mode, __dirname, "").DEV_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    // Bundle stamp shown on Preferences → "This device". iOS PWA caches are
    // sticky enough to have poisoned on-device debugging before; this line is
    // how a device proves which build it is actually running.
    define: {
      __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
    },
    plugins: [
      TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5174,
      // All interfaces, so a proxy on another host (or a NetBird peer) can
      // reach the dev server; the port itself stays dev-only.
      host: "0.0.0.0",
      allowedHosts,
      // Dev: proxy API + WS to the Elysia backend so the browser talks to
      // one origin (cookies + WS auth just work).
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3080",
          changeOrigin: true,
        },
        "/ws": {
          target: "ws://127.0.0.1:3080",
          ws: true,
        },
      },
    },
  };
});
