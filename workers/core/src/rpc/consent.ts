// Exact visible text in apps/lead-form/src/App.tsx, consent-2026-02.
// The authenticated brand Worker supplies its configured display name, never the form's site.brand.
export function consentText(brand: string): string {
  return `By submitting, I provide my express written consent under the Fair Credit Reporting Act (FCRA) for ${brand} and its qualified financial partners to obtain consumer report information. I certify that all representations made herein are true and correct.\nI also consent to receive telephone calls and text messages (including via automated dialing technology) from ${brand} and its qualified financial partners at the phone number(s) I provided regarding my inquiry and loan or financial offers. I understand that consent is not a condition of purchase, that message and data rates may apply, and that I may reply STOP at any time to opt out of text messages.`;
}
