import { Toaster } from "sonner";

/** Global confirmations stay above the terminal controls and use the app theme. */
export function AppToaster() {
  const top = "calc(env(safe-area-inset-top) + 1rem)";
  return (
    <Toaster
      theme="dark"
      position="top-center"
      className="app-toaster"
      offset={{ top }}
      mobileOffset={{ top, left: "1rem", right: "1rem" }}
    />
  );
}
