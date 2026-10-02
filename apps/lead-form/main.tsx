import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import App, { FORM_CONFIG } from "./src/App";
import "./src/index.css";
import { initSentry } from "./src/lib/sentry";
import { initPostHog } from "./src/lib/analytics";
import { initTrafficTelemetry } from "./src/lib/traffic-telemetry";
import { resolveVariant } from "./src/lib/experiment";
import { RUNTIME_CONFIG } from "./src/lib/runtime-config";

// Build identity (the git SHA in CI). Not a brand identifier; "unknown" in local builds.
const RELEASE = (import.meta.env.VITE_FORM_RELEASE as string | undefined) || "unknown";

// Sentry before React mounts so early errors are captured. Only through the brand's
// first-party tunnel path; no tunnel in the runtime config = Sentry stays off.
initSentry(RUNTIME_CONFIG.proxies?.sentry, RELEASE);

// PostHog only through the brand's first-party proxy path, with a placeholder key that the
// brand Worker swaps server-side. No proxy path = PostHog stays off.
initPostHog(RUNTIME_CONFIG.proxies?.posthog);

// Our own funnel telemetry (POST /api/telemetry, same origin). This call is load-bearing:
// without it sendTraffic() is a no-op and the build tree-shakes the module away.
initTrafficTelemetry("/api/telemetry", {
  formVersion: FORM_CONFIG.formVersion,
  // The arm this visitor actually sees (server-assigned), so funnel rows split by A/B variant.
  formVariant: resolveVariant(),
  buildId: RELEASE,
});

const embedded = new URLSearchParams(window.location.search).get("embedded") === "true";

// The brand comes from the brand Worker's runtime config (read inside App), never from the URL.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App embedded={embedded} />
  </StrictMode>,
);
