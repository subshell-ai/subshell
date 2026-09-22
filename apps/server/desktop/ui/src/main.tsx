import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Host } from "./host";
import "./styles.css";

/**
 * The assistant page's entry (spec 2026-09-21; plan Task 8).
 *
 * One mount, no providers: the host owns its own state and reaches the
 * runners through its context, and there is no query client to install — the
 * 1500 ms poll is the page's own effect. StrictMode mirrors the client app's
 * entry; the host tolerates the dev double-mount by construction (the boot
 * probe and the `desktop_pending_screen` pull are reads, and every effect
 * tears its subscription down).
 */
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
