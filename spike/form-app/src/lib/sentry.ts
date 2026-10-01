import * as Sentry from "@sentry/react";
import { sanitizeKeys, stripSensitivePatterns } from "./privacy";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

export function initSentry() {
  if (!DSN) return;

  Sentry.init({
    dsn: DSN,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string) || "production",
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.05),

    sendDefaultPii: false,

    // Propagate traces only to same-origin API
    tracePropagationTargets: [/^\/api\//],

    integrations: integrations =>
      integrations.filter(i =>
        // Disable session replay (not installed, but guard anyway)
        !["Replay", "BrowserProfilingIntegration"].includes(i.name)
      ),

    beforeSend(event) {
      // Strip cookies, auth, request bodies
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
        if (event.request.headers) {
          const h = event.request.headers as Record<string, string>;
          delete h["authorization"];
          delete h["cookie"];
          delete h["set-cookie"];
        }
      }
      // Sanitize exception messages for PII patterns
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = stripSensitivePatterns(ex.value);
        }
      }
      // Strip unsafe extra/context keys
      if (event.extra) {
        event.extra = sanitizeKeys(event.extra as Record<string, unknown>) as typeof event.extra;
      }
      // Never include user PII
      if (event.user) {
        event.user = {};
      }
      return event;
    },

    beforeBreadcrumb(crumb) {
      // Drop form input and paste breadcrumbs
      if (crumb.category === "ui.input" || crumb.category === "ui.click") return null;
      if (crumb.category === "xhr" || crumb.category === "fetch") {
        if (crumb.data?.url) {
          try {
            const u = new URL(crumb.data.url as string, window.location.origin);
            crumb.data.url = u.origin + u.pathname;
          } catch { /* noop */ }
        }
        delete crumb.data?.body;
        delete crumb.data?.response;
      }
      return crumb;
    },
  });
}

export function captureOperationalError(
  error: unknown,
  context: {
    operation: string;
    submission_stage?: string;
    http_status?: number;
    failure_category?: string;
    opaque_request_id?: string;
    duration_ms?: number;
  }
) {
  if (!DSN) return;
  Sentry.withScope(scope => {
    const safeCtx = sanitizeKeys(context as Record<string, unknown>);
    scope.setContext("operation", safeCtx);
    scope.setTag("operation", context.operation);
    scope.setTag("failure_category", context.failure_category ?? "unknown");
    if (context.submission_stage) scope.setTag("submission_stage", context.submission_stage);
    if (context.http_status) scope.setTag("http_status", String(context.http_status));
    Sentry.captureException(error);
  });
}
