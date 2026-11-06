/**
 * faq.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FAQ content — maps directly to FaqItem components from Magic Pattern designs.
 * All answers use compliance-safe language (no guarantee claims).
 *
 * USAGE: Import into FAQSection.tsx and map over FAQ_ITEMS.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SITE } from "./siteConfig";

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  category: "general" | "process" | "rates" | "credit" | "safety" | "privacy";
}

export const FAQ_ITEMS: FaqItem[] = [
  // ── General ───────────────────────────────────────────────────────────────
  {
    id: "faq-what-is",
    category: "general",
    question: `What is ${SITE.name}?`,
    answer:
      `${SITE.name} is an online lead generation service. We are not a lender, loan broker, or financial institution. ` +
      "When you submit a loan request through our website, your information may be shared with one or more participating lenders, " +
      "lending partners, affiliate networks, or marketing partners who may contact you with a loan offer. " +
      "We do not make credit decisions and we do not guarantee that you will receive a loan offer.",
  },
  {
    id: "faq-not-lender",
    category: "general",
    question: "Is this a direct lender?",
    answer:
      `No. ${SITE.name} is not a direct lender. ` +
      "We are an advertising-supported lead generation service. " +
      "If you submit a request, your information may be shared with third-party lenders and lending partners " +
      "who will make their own independent credit decisions. " +
      "We are not involved in the lending decision, loan terms, or funding process.",
  },
  {
    id: "faq-cost",
    category: "general",
    question: "Does it cost anything to submit a request?",
    answer:
      "Submitting a loan request through this website is free. " +
      `${SITE.name} is compensated by participating lenders and marketing partners. ` +
      "You are never charged a fee by us for submitting a request. " +
      "However, if you are matched with a lender, the lender may charge origination fees, late payment fees, " +
      "or other fees as described in their loan agreement. Review the lender's offer carefully before accepting.",
  },
  {
    id: "faq-how-much",
    category: "general",
    question: "How much can I request?",
    answer:
      `You may submit a loan request for amounts between ${SITE.loanRange.min.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} ` +
      `and ${SITE.loanRange.max.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}. ` +
      "However, the actual loan amount you may be offered, if any, depends entirely on the lender's review of your application, " +
      "your creditworthiness, income, state of residence, and the lender's own lending limits. " +
      "Submitting a request for a specific amount does not guarantee that amount will be offered.",
  },

  // ── Process ───────────────────────────────────────────────────────────────
  {
    id: "faq-process",
    category: "process",
    question: "What happens after I submit my request?",
    answer:
      "After you submit your loan request, your information may be reviewed by participating lenders or partners. " +
      "If a lender is interested in working with you, they may contact you directly by phone, email, or text message " +
      "(if you provided consent). " +
      "They may present you with a loan offer. You are under no obligation to accept any offer. " +
      "If you accept, the lender will walk you through their application and funding process. " +
      `${SITE.name} is not involved in this process after your information is submitted.`,
  },
  {
    id: "faq-obligation",
    category: "process",
    question: "Am I obligated to accept an offer?",
    answer:
      "No. You are never obligated to accept any loan offer. " +
      "Submitting a request through this website is exploratory — it allows you to see whether participating lenders " +
      "may be interested in working with you. " +
      "Before accepting any offer, you should carefully review all loan terms including the APR, fees, repayment schedule, " +
      "and consequences of late or missed payments.",
  },
  {
    id: "faq-how-fast",
    category: "process",
    question: "How quickly could I receive funds?",
    answer:
      "Funding timelines vary by lender and are not controlled by this website. " +
      "Some lenders may deposit funds as quickly as one business day after loan approval, while others may take longer. " +
      "We cannot guarantee any specific funding timeline. " +
      "After receiving a loan offer, ask the lender directly about their expected disbursement timeline.",
  },
  {
    id: "faq-states",
    category: "process",
    question: "Is this service available in my state?",
    answer:
      "Loan availability varies by state due to state lending laws and regulations. " +
      "Not all lenders in our network operate in all states, and certain loan products may not be available in your state. " +
      `${SITE.excludedStates.length > 0
        ? `This service is not available to residents of: ${SITE.excludedStates.join(", ")}.`
        : "Please submit your request to find out whether participating lenders are available in your area."
      }`,
  },

  // ── Rates & Terms ─────────────────────────────────────────────────────────
  {
    id: "faq-apr",
    category: "rates",
    question: "What interest rates (APR) can I expect?",
    answer:
      "Interest rates are set by individual lenders, not by this website. " +
      `Rates available through participating lenders in our network may range from approximately ${SITE.aprRange.min} to ${SITE.aprRange.max} APR, ` +
      "depending on the lender, loan amount, loan term, your creditworthiness, and state of residence. " +
      "This range is not guaranteed. Your rate may be higher or lower than this range. " +
      "You will receive the lender's specific rate disclosure before you accept any offer.",
  },
  {
    id: "faq-fees",
    category: "rates",
    question: "Are there any hidden fees?",
    answer:
      `${SITE.name} does not charge you any fees. ` +
      "However, lenders to whom you are connected may charge origination fees, late payment fees, prepayment penalties, " +
      "returned payment fees, or other fees as described in their loan agreement. " +
      "All fees must be disclosed in the lender's Truth-in-Lending disclosure (TILA) before you accept the loan. " +
      "Review all fees carefully before signing any loan agreement.",
  },
  {
    id: "faq-terms",
    category: "rates",
    question: "What are the loan repayment terms?",
    answer:
      "Repayment terms are set by the individual lender and vary by loan amount and creditworthiness. " +
      `Terms available through participating lenders may range from ${SITE.termRange.min} to ${SITE.termRange.max} months. ` +
      "Your specific repayment schedule will be detailed in the lender's loan agreement. " +
      "Review your repayment schedule carefully to ensure the monthly payment fits your budget.",
  },

  // ── Credit ────────────────────────────────────────────────────────────────
  {
    id: "faq-credit-impact",
    category: "credit",
    question: "Will submitting a request affect my credit score?",
    answer:
      `Submitting a loan request through ${SITE.name} alone does not affect your credit score. ` +
      "However, if a lender receives your request and decides to pull your credit report as part of their review process, " +
      "that credit inquiry may appear on your credit report and could have a minor impact on your credit score. " +
      "The lender will disclose whether they will perform a hard or soft credit inquiry before processing your application.",
  },
  {
    id: "faq-credit-score",
    category: "credit",
    question: "What credit score do I need to qualify?",
    answer:
      "Credit score requirements are set by individual lenders, not by this website. " +
      "Different lenders have different minimum credit score requirements, and some lenders specialize in " +
      "working with borrowers across a range of credit profiles. " +
      "Submitting a request does not guarantee that any lender will offer you a loan, regardless of your credit score.",
  },
  {
    id: "faq-bad-credit",
    category: "credit",
    question: "Can I submit a request if I have poor credit?",
    answer:
      "You may submit a request regardless of your credit profile. " +
      "Some participating lenders may consider applicants with a range of credit histories. " +
      "However, a poor credit history may affect the loan offers you receive, including higher interest rates or lower loan amounts. " +
      "We cannot guarantee that you will receive an offer if you have poor credit or a limited credit history.",
  },

  // ── Safety & Privacy ──────────────────────────────────────────────────────
  {
    id: "faq-safety",
    category: "safety",
    question: "Is this website legitimate?",
    answer:
      `${SITE.name} is a legally operating online lead generation service. ` +
      "We use industry-standard security measures to protect your submitted information. " +
      "We encourage you to read our Privacy Policy and Important Disclosures pages before submitting any information. " +
      "If you have questions or concerns, please contact us at " + `${SITE.email}.`,
  },
  {
    id: "faq-data",
    category: "privacy",
    question: "What happens to my personal information?",
    answer:
      "When you submit a loan request, your information may be shared with participating lenders, " +
      "lending partners, affiliate networks, and marketing partners for the purpose of presenting you with loan offers. " +
      "Your information is handled in accordance with our Privacy Policy. " +
      `California residents have additional rights under CCPA — see our <a href="/do-not-sell/">Do Not Sell</a> page. ` +
      `For full details, please review our <a href="/privacy/">Privacy Policy</a>.`,
  },
  {
    id: "faq-ssn",
    category: "privacy",
    question: "Do I need to provide my Social Security Number?",
    answer:
      "This initial loan request form does not require your Social Security Number. " +
      "If a lender decides to process your request further, they may ask for your SSN as part of their own " +
      "credit application process. Any request for your SSN would come directly from the lender, " +
      "not from this website. Never provide sensitive financial information unless you have verified the lender's legitimacy.",
  },
];

/** Returns FAQs filtered by category */
export function getFaqsByCategory(category: FaqItem["category"]): FaqItem[] {
  return FAQ_ITEMS.filter((faq) => faq.category === category);
}

/** Returns the first N FAQ items (for homepage preview) */
export function getTopFaqs(count = 6): FaqItem[] {
  return FAQ_ITEMS.slice(0, count);
}
