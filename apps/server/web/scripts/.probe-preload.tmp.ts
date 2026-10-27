// Minimal happy-dom registration for the manual probe scripts (test-setup.ts
// is test-runner-only since the location-reset afterEach landed).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/", settings: { disableIframePageLoading: true } });
