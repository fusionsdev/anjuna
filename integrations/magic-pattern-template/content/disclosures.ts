/**
 * disclosures.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for ALL compliance copy.
 *
 * USAGE RULES (read before editing):
 *  1. Never soften, shorten, or paraphrase the LOCKED strings without legal review.
 *  2. LOCKED strings are marked // LOCKED — DO NOT EDIT.
 *  3. CONFIGURABLE strings are marked // CONFIGURABLE — safe to edit brand/domain details.
 *  4. Use the shortest variant (SHORT) when space is tight (e.g. mobile trust strip).
 *  5. Use the FULL variant in footer, /important-disclosures page, and form consent.
 *
 * Policy references:
 *  - Google Ads Financial Products and Services policy
 *  - Google Ads loan advertising policy
 *  - Google Ads Misrepresentation policy
 *  - FTC Endorsement Guides (16 CFR Part 255) — affiliate disclosure
 *  - CFPB TILA / Regulation Z — APR disclosure
 *  - TCPA (47 U.S.C. § 227) — phone/SMS consent
 *  - CCPA / CPRA (Cal. Civ. Code § 1798.100) — do-not-sell
 *  - GLBA (15 U.S.C. § 6801) — financial data privacy
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SITE } from "./siteConfig";

// ─────────────────────────────────────────────────────────────────────────────
// 1. NOT-A-LENDER DISCLOSURE
//    Required near the lead form, in the footer, and on /important-disclosures.
//    Google Ads loan advertising policy requires this to be clearly visible.
// ─────────────────────────────────────────────────────────────────────────────

export const NOT_A_LENDER = {
  /** Use on trust strip, hero badges — 1 line max. */
  SHORT: "Not a lender. No credit decisions made here.", // LOCKED

  /** Use below hero form, below CTA buttons — 2–3 lines. */
  MEDIUM:
    `${SITE.name} is not a lender and does not make credit decisions. ` +
    "We may connect you with participating lenders, lending partners, affiliate networks, or marketing partners. " +
    "Submitting a request does not guarantee approval, loan terms, or funding.", // LOCKED

  /** Use in footer, /important-disclosures — full paragraph. */
  FULL:
    `${SITE.name} is not a lender, loan broker, or agent for any lender or loan broker. ` +
    "We do not make credit decisions, and we do not guarantee that you will be connected with a lender or that any lender will offer you a loan. " +
    "By submitting your information, you may be matched with one or more participating lenders, lending partners, affiliate networks, or marketing partners. " +
    "We are not responsible for the actions, products, services, or content of any third party to whom your information is submitted. " +
    "Submitting a request through this website does not constitute an application for credit with any particular lender.", // LOCKED
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 2. AFFILIATE DISCLOSURE
//    FTC requires clear and conspicuous disclosure of material connections.
//    Must appear on every page that contains affiliate links or lead forms.
// ─────────────────────────────────────────────────────────────────────────────

export const AFFILIATE_DISCLOSURE = {
  SHORT: "We may earn a fee when you are connected with a lending partner.", // LOCKED

  FULL:
    `${SITE.name} is an advertising-supported comparison and lead generation service. ` +
    "This site is compensated through third-party advertiser relationships, including lenders, lending networks, affiliate networks, and marketing partners. " +
    "This compensation may affect which offers appear on this site and the order in which they appear. " +
    `${SITE.name} does not include all available lenders or loan products in the marketplace. ` +
    "Our goal is to help you find loan options by connecting you with participating partners — we are not a licensed lender.", // LOCKED
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO-GUARANTEE DISCLOSURE
//    Required near the form and CTA buttons per Google Ads Misrepresentation policy.
//    Never imply guaranteed approval, guaranteed rates, or guaranteed funding.
// ─────────────────────────────────────────────────────────────────────────────

export const NO_GUARANTEE = {
  /** 1-liner, use directly below submit button. */
  BELOW_BUTTON:
    "Submitting a request does not guarantee approval, loan terms, or funding. " +
    "If matched, review the lender's terms before accepting any offer.", // LOCKED

  /** Use in form step consent area. */
  FORM_CONSENT:
    "Approval and loan terms are determined solely by the lender based on their own criteria. " +
    "We do not guarantee that submitting this form will result in a loan offer, approval, specific rates, fees, or funding timeline. " +
    "Loan products and availability vary by state.", // LOCKED

  /** Use in hero section near benefit bullets. */
  HERO_INLINE:
    "No guarantee of approval or funding. Loan terms depend on lender review.", // LOCKED
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 4. APR & FEE DISCLOSURE
//    TILA / Regulation Z requires clear APR disclosure.
//    Google Ads loan advertising policy requires APR info on destination page.
//    IMPORTANT: Do not invent specific APR numbers unless verified by legal/compliance.
//    Use the placeholder range or remove the range entirely if unknown.
// ─────────────────────────────────────────────────────────────────────────────

export const APR_DISCLOSURE = {
  /**
   * CONFIGURABLE — Edit the APR range and term range to match your lender network.
   * If you cannot verify the range, use the UNKNOWN_RANGE variant below.
   * APR and terms shown must be typical of offers available through your network.
   */
  WITH_RANGE:
    `Loan amounts, APR, fees, and repayment terms vary by lender, loan amount, credit profile, and state of residence. ` +
    `Annual Percentage Rates (APR) on loans available through ${SITE.name}'s participating lenders typically range from ` +
    `${SITE.aprRange.min} to ${SITE.aprRange.max} APR. ` +
    `Repayment terms range from ${SITE.termRange.min} to ${SITE.termRange.max} months. ` +
    "This range is not guaranteed and does not represent all available loan products.", // LOCKED structure, CONFIGURABLE numbers via siteConfig

  /**
   * Use this variant if you cannot confirm your lender network's APR range.
   * This is the safer option and satisfies Google's destination requirements.
   */
  WITHOUT_RANGE:
    `Loan amounts, APR, fees, and repayment terms vary by lender, loan amount, credit profile, and state of residence. ` +
    `${SITE.name} does not set or negotiate interest rates, fees, or loan terms. ` +
    "All terms are determined by the lender to whom you are connected. " +
    "Review the lender's offer carefully before accepting.", // LOCKED

  /** Minimum required on every page — use in footer. */
  FOOTER_MIN:
    "Loan amounts, APR, fees, and repayment terms vary by lender and state. " +
    "This site does not set loan terms. Review all terms with your lender.", // LOCKED

  /** TILA example disclosure for /rates-and-terms page. */
  TILA_EXAMPLE:
    "Representative example: A $5,000 loan with a 24-month repayment term and an APR of 29.99% " +
    "would result in 24 monthly payments of approximately $282.10. " +
    "Total amount repaid: $6,770.40. Total interest paid: $1,770.40. " +
    "This example is for illustrative purposes only. " +
    "Your actual rate, payment, and total cost will depend on your credit profile, lender, and state.", // LOCKED — update numbers via /rates-and-terms page
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 5. TCPA CONSENT
//    Required before calling or texting users.
//    Must be obtained at or before the time of data collection.
//    Do not use pre-checked consent boxes.
// ─────────────────────────────────────────────────────────────────────────────

export const TCPA_CONSENT = {
  /**
   * FULL TCPA consent — use verbatim in the form consent checkbox.
   * The checkbox must be unchecked by default (opt-in, not pre-checked).
   * CONFIGURABLE: update ${SITE.name}, ${SITE.phone}, ${SITE.email}.
   */
  CHECKBOX_LABEL:
    `By checking this box and clicking the submit button, I provide my express written consent to ` +
    `${SITE.name} and its participating lenders, lending partners, affiliate networks, and marketing partners ` +
    `to contact me by telephone (including mobile phone), SMS/text message, email, and/or automated dialing systems ` +
    `at the number(s) and email address I have provided, even if my number is on a Do Not Call registry. ` +
    `I understand this consent is not a condition of purchasing any goods or services. ` +
    `Message and data rates may apply. I may opt out at any time by replying STOP to any text message or ` +
    `contacting us at ${SITE.email}.`, // LOCKED structure, CONFIGURABLE via siteConfig

  /** Shorter version for SMS-only opt-in (if separate from call consent). */
  SMS_ONLY:
    `By providing your phone number, you consent to receive SMS/text messages from ${SITE.name} and its partners. ` +
    "Message and data rates may apply. Reply STOP to opt out.", // LOCKED structure

  /** Displayed below the TCPA checkbox — reinforces non-coercion. */
  NON_COERCION_NOTE:
    "Consent is optional. You may submit your request without providing telephone consent " +
    "by contacting us directly at " + `${SITE.email}.`, // LOCKED structure
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 6. STATE AVAILABILITY DISCLOSURE
//    Loan products are not available in all states.
//    This site must not imply nationwide availability unless verified.
// ─────────────────────────────────────────────────────────────────────────────

export const STATE_DISCLOSURE = {
  SHORT: "Not available in all states. Loan availability varies by state.", // LOCKED

  FULL:
    "Loan products and the availability of loan offers vary by state. " +
    "Residents of some states may not be eligible for certain loan products based on state law and lender restrictions. " +
    `${SITE.name} does not guarantee that loan offers will be available in your state. ` +
    "This service is intended for residents of the United States only.", // LOCKED structure

  /** If you have a known excluded states list — CONFIGURABLE. */
  EXCLUDED_STATES:
    `This service is not available to residents of the following states: ${SITE.excludedStates.join(", ")}. ` +
    "If you reside in one of these states, please do not submit a request through this site.", // CONFIGURABLE list via siteConfig
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 7. PRIVACY & DATA SHARING DISCLOSURE
//    GLBA requires financial websites to disclose data sharing practices.
//    CCPA requires disclosure of data sales/sharing to California residents.
// ─────────────────────────────────────────────────────────────────────────────

export const PRIVACY_DISCLOSURE = {
  SHORT:
    "Your information may be shared with participating lenders and partners. " +
    `See our <a href="/privacy/">Privacy Policy</a>.`, // LOCKED structure

  CCPA_NOTICE:
    "California residents: Under the California Consumer Privacy Act (CCPA), " +
    "you have the right to know what personal information we collect, to request deletion of your data, " +
    "and to opt out of the sale or sharing of your personal information. " +
    `To exercise your rights, visit our <a href="/do-not-sell/">Do Not Sell or Share My Personal Information</a> page ` +
    `or contact us at ${SITE.email}.`, // LOCKED structure

  GLBA_NOTICE:
    `${SITE.name} collects personal and financial information from you to help connect you with participating lending partners. ` +
    "We may share your information with third-party lenders, lending networks, affiliate networks, and marketing partners " +
    "to facilitate your loan request. " +
    "We take reasonable measures to protect your information, but we cannot guarantee the security practices of third-party partners. " +
    `For full details, please review our <a href="/privacy/">Privacy Policy</a>.`, // LOCKED structure
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 8. FORM MICROCOPY
//    Short copy used within and immediately around the lead form.
//    Reduces user anxiety and sets correct expectations.
// ─────────────────────────────────────────────────────────────────────────────

export const FORM_COPY = {
  FORM_TITLE: "Submit a Loan Request",
  FORM_SUBTITLE: "Tell us about your loan needs — it only takes a few minutes.",

  STEP_LABELS: ["Loan Details", "Your Information", "Contact & Consent"],

  CTA_LABELS: {
    step1: "Continue",
    step2: "Almost Done",
    step3: "Submit My Request",
  },

  /** Displayed directly below the submit button — LOCKED. */
  BELOW_SUBMIT:
    "Submitting a request does not guarantee approval, loan terms, or funding. " +
    "If matched with a lender, review their terms carefully before accepting any offer.", // LOCKED

  /** Short trust line inside the form card. */
  FORM_TRUST_LINE: "🔒 Your information is encrypted and handled securely.", // CONFIGURABLE icon

  /** Displayed when form submission is being processed. */
  LOADING_MESSAGE: "Submitting your request securely…",

  /** Displayed on successful submission (before redirect or result). */
  SUCCESS_MESSAGE:
    "Your request has been received. You may be contacted by participating lenders or partners. " +
    "If matched, review any loan offer terms carefully before accepting.", // LOCKED

  /** Error state message. */
  ERROR_MESSAGE:
    "There was a problem submitting your request. Please try again or contact us at " +
    `${SITE.email}.`, // LOCKED structure
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 9. FOOTER DISCLOSURE (FULL)
//    The most complete disclosure block.
//    Must appear in the footer of every page.
//    Google Ads destination requirements demand visible, accessible disclosures.
// ─────────────────────────────────────────────────────────────────────────────

export const FOOTER_DISCLOSURE = {
  /**
   * Full footer disclosure — use verbatim in Footer.tsx.
   * This single block satisfies: not-a-lender, affiliate, APR, state, GLBA.
   */
  FULL: `
${SITE.name} is not a lender and does not make credit decisions or loan offers. We are an advertising-supported lead generation and comparison service that may connect you with participating lenders, lending partners, affiliate networks, or marketing partners. This website is compensated through third-party relationships. Submitting a loan request through this site does not constitute an application for credit with any particular lender, and does not guarantee that you will be connected with a lender or receive a loan offer.

Loan amounts, Annual Percentage Rates (APR), fees, repayment terms, and loan availability vary by lender, loan amount, creditworthiness, and state of residence. ${SITE.name} does not set or negotiate loan terms. Not all lenders can provide loan amounts up to the maximum shown. Not all applicants will qualify. Loan products are not available in all states.

By submitting your information, you may be matched with one or more third-party lenders or partners who may contact you using automated calling technology, SMS/text messages, or email. Consent to be contacted is not a condition of receiving services through this site.

This service is intended for adult residents of the United States only. We encourage you to review your lender's terms and conditions carefully before accepting any loan offer.

${SITE.name} operates in accordance with applicable federal and state law. ${SITE.nmls ? `NMLS ID: ${SITE.nmls}.` : ""} © ${new Date().getFullYear()} ${SITE.name}. All rights reserved.
  `.trim(), // LOCKED structure, CONFIGURABLE via siteConfig

  /** One-line copyright + compliance shorthand for narrow footers. */
  COMPACT:
    `© ${new Date().getFullYear()} ${SITE.name}. Not a lender. ` +
    "Loan terms vary. Submitting a request does not guarantee approval.", // LOCKED structure
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 10. HERO SECTION COPY — Compliance-safe headlines and bullets
//     Use ONLY the pre-approved copy below to avoid Google Ads disapproval.
// ─────────────────────────────────────────────────────────────────────────────

export const HERO_COPY = {
  /**
   * Pre-approved headlines — pick one per site variant.
   * All comply with Google Ads loans + Misrepresentation policies.
   * NEVER use: "Guaranteed", "No Credit Check", "Instant Approval", "Get Cash Now"
   */
  HEADLINES: [
    "Submit a Loan Request and See If You May Qualify",       // safe: conditional language
    "Compare Available Loan Options Online",                   // safe: comparison framing
    "Connect With Participating Lending Partners",             // safe: network framing
    "A Simple Way to Request a loan Online",          // safe: process framing
    "Find Out If You May Be Eligible for a loan",     // safe: eligibility check framing
    "Explore Loan Options From Participating Lenders",         // safe: exploration framing
  ],

  /**
   * Pre-approved subheadlines — pick one per site variant.
   */
  SUBHEADLINES: [
    "Simple online request process. No commitment required.",
    "Participating lenders may review your request and respond with an offer.",
    "See potential options — no obligation to accept any offer.",
    "A straightforward process designed to save you time.",
    "Transparent process. Review all terms before deciding.",
  ],

  /**
   * Pre-approved benefit bullets — mix and match, 3–5 bullets max.
   * All use conditional/exploratory language. Never imply guaranteed outcomes.
   */
  BULLETS: [
    "Simple online request process",
    "Participating lenders may review your request",
    "Loan terms depend on lender review and state law",
    "No obligation to accept an offer if matched",
    "Funds disbursement timing depends on the lender",
    "Review lender terms before accepting any offer",
    "Not a lender — we connect you with participating partners",
    "Designed for convenience — complete your request online",
    "Mobile-friendly form — takes just a few minutes",
    "Transparent process — no hidden steps",
  ],

  /**
   * BANNED copy — never use these phrases anywhere on the site.
   * Google Ads will disapprove ads and may suspend accounts.
   */
  BANNED_PHRASES: [
    "Guaranteed Approval",
    "No Credit Check",
    "Instant Approval",
    "Instant Cash",
    "Get Cash Now",
    "Everyone Approved",
    "100% Approval",
    "Pre-Approved",
    "Direct Lender",              // unless legally true
    "Official Lender",
    "Lowest Rates Guaranteed",
    "Best Rates",
    "Government Loan",            // unless legally true
    "Free Money",
    "No Fees",                    // unless the lender network genuinely has zero fees
    "Same Day Cash",
    "Bad Credit OK",              // can imply guaranteed approval
    "Claim Your Cash",
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 11. TRUST STRIP COPY
//     Compliance-safe trust points for TrustBar component.
// ─────────────────────────────────────────────────────────────────────────────

export const TRUST_COPY = {
  POINTS: [
    { icon: "🔒", text: "Encrypted request form" },
    { icon: "📋", text: "Clear disclosures provided" },
    { icon: "🚫", text: "No obligation to accept any offer" },
    { icon: "📝", text: "Review lender terms before accepting" },
    { icon: "🌐", text: "Transparent, straightforward process" },
  ],

  /**
   * BANNED trust claims — never use fake badges, ratings, or certifications.
   * Using unauthorized logos or fake security seals violates Google Ads policy.
   */
  BANNED: [
    "BBB Accredited",           // unless actually accredited
    "FDIC Insured",             // only true for actual banks
    "Government Approved",
    "Verified Lender",
    "4.9 Stars",                // unless from a real, verifiable review source
    "As Seen On [Network]",     // unless actually featured
    "Authorized Partner",
    "Licensed by [State]",      // unless actually licensed — add real license info if true
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 12. IMPORTANT DISCLOSURES PAGE — /important-disclosures
//     Full text for the dedicated disclosures page.
//     Google Ads loan advertising policy may require this page to be linked.
// ─────────────────────────────────────────────────────────────────────────────

export const IMPORTANT_DISCLOSURES_PAGE = {
  TITLE: "Important Disclosures",
  SECTIONS: [
    {
      heading: "Not a Lender",
      body: NOT_A_LENDER.FULL,
    },
    {
      heading: "Affiliate & Advertising Disclosure",
      body: AFFILIATE_DISCLOSURE.FULL,
    },
    {
      heading: "No Guarantee of Approval or Loan Terms",
      body:
        "Submitting a loan request through this website does not guarantee that you will receive a loan offer, " +
        "be approved for a loan, receive any particular loan amount, interest rate, fee structure, or repayment term. " +
        "All lending decisions are made solely by the lender to whom your information is submitted, " +
        "based on the lender's own criteria and applicable state law. " +
        "We encourage you to review any loan offer carefully and to borrow only what you can afford to repay.", // LOCKED
    },
    {
      heading: "APR and Fee Disclosure",
      body: APR_DISCLOSURE.WITHOUT_RANGE,
    },
    {
      heading: "State Availability",
      body: STATE_DISCLOSURE.FULL,
    },
    {
      heading: "Privacy and Data Sharing",
      body: PRIVACY_DISCLOSURE.GLBA_NOTICE,
    },
    {
      heading: "California Residents — CCPA Notice",
      body: PRIVACY_DISCLOSURE.CCPA_NOTICE,
    },
    {
      heading: "Responsible Borrowing",
      body:
        "We encourage all users to borrow responsibly. " +
        "Before accepting any loan offer, carefully review the loan agreement, including the interest rate, APR, fees, " +
        "repayment schedule, and consequences of late or missed payments. " +
        "If you are struggling with debt, you may wish to contact a non-profit credit counseling agency " +
        "or visit the Consumer Financial Protection Bureau (CFPB) at consumerfinance.gov for free resources.", // LOCKED
    },
  ],
} as const;
