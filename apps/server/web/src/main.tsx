import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotFoundPage } from "@/components/not-found-page";
import { desktopShell } from "@/lib/desktop";
import { installDesktopLinkHandling } from "@/lib/desktop-links";
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

// External links are inert inside a Tauri webview (measured 2026-09-16: the
// click reaches the DOM and the webview then raises nothing at the app); the
// capture-phase relay sends them through window.open, which the shell's
// on_new_window handler answers by opening the system browser. Armed here —
// module level, not a component effect — because it cannot double-arm.
installDesktopLinkHandling();

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
