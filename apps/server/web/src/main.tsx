import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotFoundPage } from "@/components/not-found-page";
import { desktopShell } from "@/lib/desktop";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

// Subshell is dark-only (no light theme exists).
document.documentElement.classList.add("dark");
// Stamp the shell on the root element BEFORE React mounts, so CSS can key off
// it without a frame of the wrong chrome. `desktopShell()` reads the
// User-Agent, which is present on the very first request.
const shell = desktopShell();
document.documentElement.dataset.shell = shell ? "desktop" : "web";
if (shell) document.documentElement.dataset.platform = shell.platform;

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
