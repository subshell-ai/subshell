import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

/**
 * One client, no devtools, no persistence.
 *
 * `refetchOnWindowFocus` is OFF: focusing this window is the single most
 * frequent thing a user does to it (it is a status panel they alt-tab back to),
 * and every refocus would otherwise cost two CLI spawns. The probe polls on its
 * own interval and every action re-probes; there is nothing a focus refetch
 * would learn first.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

// Subshell is dark-only (no light theme exists); `index.html` carries the same
// class so the first paint is never the wrong chrome.
document.documentElement.classList.add("dark");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
