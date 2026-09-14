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
// `desktop` means Subshell SERVER, matching what `isServerDesktop()` gates:
// the chrome any stylesheet would key off this is that app's (overlay title
// bar, traffic-light inset). Subshell Client is a shell too, but renders the
// web chrome, so it stamps `client` rather than joining either bucket — a
// third value, so a later rule reading `[data-shell="desktop"]` cannot pick it
// up by accident and one reading `[data-shell="web"]` cannot either.
const shell = desktopShell();
document.documentElement.dataset.shell = shell ? (shell.app === "server" ? "desktop" : "client") : "web";
if (shell) document.documentElement.dataset.platform = shell.platform;

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
