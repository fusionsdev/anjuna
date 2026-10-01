// Google Ads conversion boundary — separate from lib/analytics.ts (PostHog) on purpose.
//
// Minimum PPC Leadgate contract:
// - lead_accepted is diagnostic only (browser/product analytics, no bidding signal)
// - soldLead + positive revenue is the primary conversion signal
// - primary upload is server-side from the conversion_uploads drain
//
// Keep this browser gateway inert unless/until the owner explicitly approves a new
// diagnostic-only browser conversion action. Never train Smart Bidding from accepted
// lead submit events; revenue optimization belongs to the server-side soldLead path.

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let _conversionId: string | undefined;
let _conversionLabel: string | undefined;

// Legacy initializer retained for compatibility with consumers that still import it.
// It stores the requested values for diagnostics but deliberately does not configure
// or call a browser ad tag.
export function initGoogleAdsTag(conversionId: string | undefined, conversionLabel: string | undefined) {
  _conversionId = conversionId;
  _conversionLabel = conversionLabel;
}

// leadId is intentionally unused: accepted lead submit is diagnostic, not primary.
// Primary Google Ads conversion is server-side only after LeadsGate soldLead revenue
// is present in conversion_uploads.
export function fireLeadConversion(_leadId: string) {
  void _conversionId;
  void _conversionLabel;
}
