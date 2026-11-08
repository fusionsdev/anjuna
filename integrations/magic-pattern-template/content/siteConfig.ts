/**
 * Template defaults. The install replaces the brand name, contact details and
 * legal slots per brand (docs/template-contract.md sections 3.3 and 3.4).
 * Ported from the Magic Pattern content bundle; platform-specific fields
 * (design IDs, analytics IDs, apply URL) are removed because a brand site
 * may not carry them.
 */
export type BrandPreset =
  | "navy-green"
  | "trust-blue"
  | "forest-amber"
  | "plum-violet"
  | "slate-teal";

export const SITE = {
  name: "Brand Name",
  tagline: "A Simple Way to Request a Loan Online",
  brandPreset: "navy-green" as BrandPreset,
  email: "support@example.com",
  phone: "1-800-000-0000",
  address: "123 Main Street, Suite 100, City, State 00000",
  nmls: "",
  entityName: "Brand Name",
  aprRange: { min: "5.99%", max: "35.99%" },
  termRange: { min: "12", max: "84" },
  // Matches the canonical requested_amount buckets accepted by /go.
  loanRange: { min: 350, max: 5000 },
  excludedStates: [] as string[],
  seo: {
    defaultTitle: "Brand Name | Submit a Loan Request Online",
    defaultDescription:
      "Brand Name is an online lead generation service that may connect you with participating lenders. Not a lender. No guarantee of approval.",
  },
} as const;
