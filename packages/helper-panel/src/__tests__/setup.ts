import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun's HTMLRewriter expects its native Response, not the DOM fetch shim.
const NativeResponse = globalThis.Response;
GlobalRegistrator.register();
globalThis.Response = NativeResponse;
document.body.innerHTML = '<main id="panel"></main>';
