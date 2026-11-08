/**
 * ratesTerms.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Content for the /rates-and-terms page.
 * All values are CONFIGURABLE unless marked LOCKED.
 *
 * IMPORTANT:
 *  - Do NOT publish specific APR numbers unless verified by your lender network.
 *  - If you cannot confirm APR range, use the WITHOUT_RANGE disclosure from disclosures.ts.
 *  - The TILA example must be mathematically accurate if published.
 *  - Consult legal counsel before finalizing this page for live traffic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SITE } from "./siteConfig";
import { APR_DISCLOSURE, STATE_DISCLOSURE } from "./disclosures";

export const RATES_AND_TERMS_PAGE = {
  title: "Rates, Terms & Important Loan Information",
  subtitle:
    "Understanding loan costs before you apply is important. " +
    "This page explains what to expect — but remember, all actual terms are set by the lender, not by us.",

  sections: [
    {
      id: "loan-amounts",
      heading: "Loan Amounts",
      body: `Loan amounts available through participating lenders in our network may range from ` +
        `${SITE.loanRange.min.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} ` +
        `to ${SITE.loanRange.max.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}. ` +
        "The actual loan amount you may be offered depends on the lender's review of your application, " +
        "creditworthiness, income, and state of residence. " +
        "Not all lenders can provide the maximum loan amount shown.",
    },
    {
      id: "apr-rates",
      heading: "Annual Percentage Rate (APR)",
      body: APR_DISCLOSURE.WITH_RANGE,
    },
    {
      id: "repayment-terms",
      heading: "Repayment Terms",
      body:
        `Repayment terms available through participating lenders may range from ` +
        `${SITE.termRange.min} to ${SITE.termRange.max} months, ` +
        "depending on the lender, loan amount, and your credit profile. " +
        "Your specific repayment schedule will be set out in the lender's loan agreement. " +
        "Review your monthly payment amount carefully to ensure it fits your budget before accepting any offer.",
    },
    {
      id: "fees",
      heading: "Fees",
      body:
        `${SITE.name} does not charge any fees for submitting a loan request. ` +
        "However, lenders may charge origination fees, which are typically deducted from your loan proceeds. " +
        "Other potential fees charged by lenders may include: " +
        "late payment fees, returned payment (NSF) fees, and prepayment penalties (though many lenders do not charge these). " +
        "All fees must be disclosed in the lender's Truth-in-Lending Act (TILA) disclosure before you accept the loan. " +
        "Review all fees carefully before signing.",
    },
    {
      id: "late-payments",
      heading: "Late and Missed Payments",
      body:
        "Making late payments or missing payments on a loan can have serious consequences, including: " +
        "late payment fees as specified in your loan agreement, " +
        "negative impact on your credit score (lenders typically report to one or more credit bureaus), " +
        "increased interest costs if your agreement includes a penalty rate, " +
        "and potential referral to a collections agency. " +
        "If you are having difficulty making payments, contact your lender immediately — many lenders offer hardship programs.", // LOCKED guidance
    },
    {
      id: "non-payment",
      heading: "Consequences of Non-Payment",
      body:
        "Failure to repay a loan according to the agreed terms may result in: " +
        "the full loan balance becoming immediately due and payable, " +
        "collection activity by the lender or a third-party collection agency, " +
        "legal action against you by the lender, " +
        "a negative mark on your credit report for up to 7 years, " +
        "and wage garnishment or bank levy, depending on state law. " +
        "We strongly encourage you to borrow only what you can afford to repay.", // LOCKED guidance
    },
    {
      id: "renewal",
      heading: "Loan Renewal and Refinancing",
      body:
        "Some lenders may offer the option to renew or refinance your loan. " +
        "Renewal or refinancing policies vary by lender and state law. " +
        "In some states, loan renewals may not be permitted or may be subject to restrictions. " +
        "Renewing or refinancing a loan may result in additional fees and interest costs. " +
        "Review any renewal offer carefully before agreeing.",
    },
    {
      id: "state-availability",
      heading: "State Availability and Regulations",
      body: STATE_DISCLOSURE.FULL,
    },
    {
      id: "representative-example",
      heading: "Representative Example",
      body:
        "The following example is for illustrative purposes only. " +
        "Your actual loan terms will depend on your creditworthiness, the lender's criteria, and applicable state law.\n\n" +
        "Example: A loan of $10,000 with a 36-month repayment term and an APR of 19.99% " +
        "would result in 36 monthly payments of approximately $371.64. " +
        "Total amount repaid: $13,379.04. Total interest charged: $3,379.04.\n\n" +
        "This example does not represent an actual loan offer. " +
        "Actual APR, payment amount, and total cost will vary.",
    },
    {
      id: "responsible-borrowing",
      heading: "Responsible Borrowing",
      body:
        "Before accepting any loan offer, we encourage you to: " +
        "compare offers from multiple lenders; " +
        "read the full loan agreement, including all fees and the repayment schedule; " +
        "make sure the monthly payment is affordable given your income and existing obligations; " +
        "understand the consequences of late or missed payments; " +
        "and consider whether a loan is the right financial product for your situation. " +
        "If you are struggling with debt, free non-profit credit counseling is available through the " +
        "National Foundation for Credit Counseling (nfcc.org) and the CFPB (consumerfinance.gov).", // LOCKED guidance
    },
  ],
} as const;
