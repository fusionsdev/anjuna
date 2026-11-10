import React, { useState, useEffect, useRef } from "react";
import { trackEvent, trackFormStarted, registerSessionContext } from "./lib/analytics";
import { sendTraffic } from "./lib/traffic-telemetry";
import { captureOperationalError } from "./lib/sentry";
import { 
  Shield, 
  ChevronLeft, 
  ChevronRight, 
  Eye, 
  EyeOff, 
  Lock, 
  CheckCircle2, 
  Check,
  Edit2, 
  Info, 
  DollarSign, 
  Calendar, 
  Briefcase, 
  MapPin, 
  CreditCard,
  Phone,
  Mail,
  Award,
  AlertCircle,
  Clock,
  Layers,
  Zap,
  Car,
  Home,
  Stethoscope,
  Receipt,
  KeyRound,
  MoreHorizontal
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { FormValues, StepConfig } from "./types";
import { resolveVariant, VARIANTS } from "./lib/experiment";
import { RUNTIME_CONFIG } from "./lib/runtime-config";

// Static step configs mapping all form sections (14 steps, mirroring LeadsGate's proven
// pre-screen question order/content 1:1 so answers pre-fill the LeadsGate widget after handoff.
// LeadsGate's own step 6 "last 4 of SSN" is intentionally omitted — compliance decision, see BRAIN.md).
const STEPS_FULL_V1: StepConfig[] = [
  {
    id: 1,
    title: "Desired Loan Amount",
    guidance: "How much funding are you looking to borrow?",
    fields: ["requested_amount"]
  },
  {
    id: 2,
    title: "Loan Purpose",
    guidance: "Select the primary reason for your funding request.",
    fields: ["loan purpose"]
  },
  {
    id: 3,
    title: "Legal Name & Date of Birth",
    guidance: "Enter your full legal name and date of birth exactly as they appear on your ID.",
    fields: ["first name", "last_name", "birth date"]
  },
  {
    id: 4,
    title: "Email Address",
    guidance: "Where should we send your loan confirmation?",
    fields: ["email"]
  },
  {
    id: 5,
    title: "Phone Number",
    guidance: "Please provide a phone number where we can reach you to review terms.",
    fields: ["home phone"]
  },
  {
    id: 6,
    title: "Current Residential Address",
    guidance: "Enter your current physical ZIP code and street address (P.O. Boxes are not permitted).",
    fields: ["zip", "address", "apt", "city", "state"]
  },
  {
    id: 7,
    title: "Time At Current Address",
    guidance: "How long have you lived at your current address?",
    fields: ["address_length_months"]
  },
  {
    id: 8,
    title: "Housing Status",
    guidance: "Do you rent or own your residence?",
    fields: ["own_home"]
  },
  {
    id: 9,
    title: "Income Type",
    guidance: "Select your primary source of income-generating activity.",
    fields: ["income_type"]
  },
  {
    id: 10,
    title: "Employer Information",
    guidance: "Please provide your current employer's information.",
    fields: ["employer", "job_title", "work phone"]
  },
  {
    id: 11,
    title: "Time With Current Employer",
    guidance: "How long have you been with your current employer?",
    fields: ["employed_months"]
  },
  {
    id: 12,
    title: "Paycheck Information",
    guidance: "Select your next payday, how often you're paid, and how your paycheck is received.",
    fields: ["pay_date1", "pay_frequency", "direct_deposit"]
  },
  {
    id: 13,
    title: "Monthly Income",
    guidance: "Specify your average gross (before-tax) monthly earnings.",
    fields: ["monthly_income"]
  },
  {
    id: 14,
    title: "Final Review & Agreement",
    guidance: "Review your information and accept the conditions to submit your secure inquiry.",
    fields: []
  }
];

// PHASE D — the minimal variant. Measured 2026-09-08: LeadsGate's own pre-screen form auto-submits
// whatever it is handed and qualifies the rest itself (4 fields reached 29% of its progress bar and
// still filed an application), so the fields dropped here are collected by the buyer rather than
// lost. See _release-2026-09-08/LEADSGATE-FIELD-OVERLAP.md.
//
// Screen 1 is normally never seen in production: every brand landing page already collects the
// amount and ZIP and hands them over as `?requested_amount=&zip=`, which starts the app on step 2.
// It exists for direct/organic arrivals that carry no handoff params.
//
// Why each surviving field survives — none of these is a style choice:
//   requested_amount  the one question LeadsGate surfaces at every prepop level
//   zip               ZIP and state never block routing. An unknown ZIP is prepopped without
//                     state. The ZIP yields city and state through the existing lookup,
//                     so one input returns three fields.
//   first name / last_name   kept as TWO inputs rather than one "Full name". Splitting a single
//                     name string would need a parsing heuristic, and heuristics mangle real
//                     names (multi-part surnames, hyphens, particles). One extra tap is cheaper
//                     than corrupting the applicant's legal name on a credit application.
//   home phone, email contact channel; LeadsGate continues qualification by SMS after handoff.
const STEPS_LITE_V1: StepConfig[] = [
  {
    id: 1,
    title: "Requested Amount",
    guidance: "Choose an amount and enter your ZIP code.",
    fields: ["requested_amount", "zip"]
  },
  {
    id: 2,
    title: "Contact Details",
    guidance: "How lenders in our network can reach you.",
    fields: ["first name", "last_name", "home phone", "email"]
  },
  {
    id: 3,
    title: "Review & Agreement",
    guidance: "Confirm your details and accept the disclosures.",
    fields: []
  }
];

// The active step set. Resolved once at module load so the arm cannot change mid-application.
// Every existing STEPS[...] / STEPS.length call site keeps working unchanged.
const STEPS: StepConfig[] = resolveVariant() === VARIANTS.LITE ? STEPS_LITE_V1 : STEPS_FULL_V1;

// Chrome that earns its space on a 14-section application but not on a 3-screen one. Scoped to
// the variant on purpose: full_v1 is the incumbent under measurement and must not move.
const IS_LITE = STEPS === STEPS_LITE_V1;

// Total step count, used everywhere instead of a hardcoded number.
const TOTAL_STEPS = STEPS.length;

// Translations matching high-converting lead-gen standards with formal USA Financial terminology
const TRANSLATIONS = {
  progress: "Application Progress",
  changesSaved: "securely encrypted & saved",
  stepOf: "Section {current} of {total}",
  seeOptions: "Evaluate Pre-Qualified Offers",
  continue: "Proceed Securely",
  checkEligibility: "Verify Prequalification Status",
  sendResults: "Request Formal Underwriting",
  reviewApp: "Review Consumer Disclosures",
  submitApp: "Submit Secure Inquiry",
  verifying: "Processing under secure SSL protocols...",
  back: "Previous Section",
  required: "This disclosure field is required.",
  whyRequired: "Regulatory & Compliance Notice",
  steps: [
    {
      title: "Desired Capital Allocation",
      guidance: "Select your requested principal loan amount. This figure represents the total initial disbursement requested."
    },
    {
      title: "Intended Use of Proceeds",
      guidance: "Indicate the primary consumer purpose of the credit extension."
    },
    {
      title: "About You",
      guidance: "Enter your legal first name, last name, and date of birth. Lenders in our network use these to check your eligibility."
    },
    {
      title: "Primary Contact Email",
      guidance: "Enter your secure primary email address to receive your loan confirmation."
    },
    {
      title: "Telecommunication & Contact Verification",
      guidance: "Provide your primary home or mobile telephone line to facilitate necessary communication regarding your request."
    },
    {
      title: "Primary Residential Address",
      guidance: "Provide your physical residential address (no P.O. Boxes). Availability of offers varies by state."
    },
    {
      title: "Duration At Current Residence",
      guidance: "Indicate how long you have resided at your current address."
    },
    {
      title: "Housing Status",
      guidance: "Indicate whether you rent, own, or reside with parents or relatives at your current address."
    },
    {
      title: "Employment Status",
      guidance: "Select your primary category of income-generating activity."
    },
    {
      title: "Employer Information",
      guidance: "Provide your current employer's name, your job title, and a work telephone line."
    },
    {
      title: "Duration With Current Employer",
      guidance: "Indicate how long you have been with your current employer."
    },
    {
      title: "Paycheck Information",
      guidance: "Select your next scheduled payday, your pay frequency, and how your paycheck is received."
    },
    {
      title: "Earned Monthly Income",
      guidance: "Specify your average gross (before-tax) monthly earnings."
    },
    {
      title: "Final Review & Consumer Attestation",
      guidance: "Review your information and complete the required consumer authorization to submit your secure inquiry."
    }
  ],
  amount: "Requested Loan Principal",
  purpose: "Intended Use of Proceeds",
  purposePlaceholder: "Select primary purpose of funds...",
  zip: "5-Digit Residential ZIP Code",
  incomeType: "Primary Source of Verified Income",
  incomePlaceholder: "Select primary source of earnings...",
  incomeValue: "Verified Gross Monthly Earnings",
  incomeRangePlaceholder: "Select verified gross monthly range...",
  birthDate: "Date of Birth (MM/DD/YYYY)",
  firstName: "Legal First Name (as on ID)",
  email: "Primary Contact Email Address",
  phone: "Primary Mobile Phone (10-Digit)",
  workPhone: "Work Phone (10-Digit)",
  phoneAnxiety: "🔒 Your contact details are used only to process your request and help prevent fraud. Your information is protected with industry-standard TLS encryption.",
  lastName: "Legal Last Name (as on ID)",
  streetAddress: "Physical Residential Address (No P.O. Boxes)",
  apt: "Suite, Apartment, or Unit Number (optional)",
  city: "City of Residence",
  state: "State of Residence (2-Letter USPS Code)",
  addressDuration: "Time At Current Address",
  ownHome: "Housing Status",
  employer: "Current Employer Name",
  jobTitle: "Job Title",
  employedDuration: "Time With Current Employer",
  payDate: "Next Payday",
  payFrequency: "Pay Frequency",
  directDeposit: "How Is Your Paycheck Received?",
  consentText: (brand: string) =>
    `By submitting, I provide my express written consent under the Fair Credit Reporting Act (FCRA) for ${brand} and its qualified financial partners to obtain consumer report information. I certify that all representations made herein are true and correct.`,
  tcpaConsentText: (brand: string) =>
    `I also consent to receive telephone calls and text messages (including via automated dialing technology) from ${brand} and its qualified financial partners at the phone number(s) I provided regarding my inquiry and loan or financial offers. I understand that consent is not a condition of purchase, that message and data rates may apply, and that I may reply STOP at any time to opt out of text messages.`,
  successTitle: "Inquiry Successfully Logged",
  successDesc: "Your formal credit inquiry has been safely compiled. You are being redirected to our compliance-certified primary underwriting platform for match evaluation.",
  redirecting: "Initializing secure transfer to matching system...",
};

// Sensitive fields to exclude from browser storage
const SENSITIVE_FIELDS: string[] = [
  "first name", // Applicant given name (PII)
  "last_name", // Applicant surname (PII)
  "birth date", // Date of birth
  "address", // Full street address
  "apt", // Suite/unit number (part of residential address)
  "city", // Residential city (address component)
  "zip", // Residential ZIP (address component / quasi-identifier)
  "email", // Contact email
  "home phone", // Phone number
  "work phone", // Phone number
  "employer", // Employer name (PII)
  "monthly_income", // Financial detail
];

// Same-origin lead-intake configuration.
// The browser talks ONLY to /api/leads. The server (Cloudflare Worker/Pages Function)
// owns the buyer (LeadsGate) submission and the tracker (ClickFlare) postback.
// No affiliate JS, no tracker credentials, and no PII ever leave the browser except to same-origin.
export const FORM_CONFIG = {
  endpoint: "/api/leads",
  errorEndpoint: "/api/errors",
  formVersion: "2026-01",
  // Neutral site id shared by every brand; core validates it against its FORM_SITE_ID.
  siteId: "form-default",
  // Neutral fallback when the runtime config carries no brand (never a real brand name).
  brand: "Secure Request",
  consentVersion: "consent-2026-02",
  partnerListVersion: "partners-2026-01",
  requestTimeoutMs: 12000,
  // Deliberately much shorter than requestTimeoutMs: "Proceed"/"Submit" block on this lookup,
  // so it must give up long before the applicant concludes the button is broken.
  zipLookupTimeoutMs: 4000,
  thankYouPath: "/thank-you.html",
};

// Display brand shown in the form UI and recorded on the lead (FO-2). It comes ONLY from the
// brand Worker's runtime config, which the Worker fills from its own environment - never from a
// hostname map in this bundle and never from the query string. The bundle is shared by every
// brand, so it must not know any brand's name or domain.
function resolveBrandName(): string {
  return (RUNTIME_CONFIG.brand || "").trim() || FORM_CONFIG.brand;
}


// Attribution keys preserved from the landing URL and submitted (server-side only) with the lead.
const TRACKING_KEYS = [
  "clickid", "click_id", "gclid", "gbraid", "wbraid", "msclkid", "fbclid",
  "ref_id",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "campaign_id", "adgroup_id", "ad_id", "keyword",
  "sub1", "sub2", "sub3", "sub4", "sub5",
];

// Loan-amount values a landing page may hand off via `?requested_amount=` and be trusted to
// skip Step 1. The original buckets {350,750,1750,3250,4500} plus the round amounts the
// brand skins offer ({500,1000,1500,2000,2500,3000,5000}). Server still validates the real
// 100–5000 range on submit; this set only gates the client-side skip.
//
// KEEP IN SYNC WITH EVERY LANDING'S AMOUNT PICKER. A value a landing offers but this set omits is
// silently dropped: the applicant lands on Step 1 and must re-pick from the range options, which
// may not even contain the figure they just clicked. 2500 was exactly that case — it is a chip on
// two brand landings (chips: 500/1000/2500/5000), so one in four selections on
// those domains lost the handoff. Verified live before the fix.
const REQUESTED_AMOUNT_BUCKETS = new Set([350, 500, 750, 1000, 1500, 1750, 2000, 2500, 3000, 3250, 4500, 5000]);

// The Step 1 amount picker (see the "requested_amount" case in renderField) only offers these five
// canonical range-midpoint values as selectable cards. A landing-page handoff amount validated
// above against the broader REQUESTED_AMOUNT_BUCKETS set (e.g. 2000, 3000) does not necessarily
// match one of these five exactly, which would prefill the field with a value no card highlights.
// Snap it to whichever of these covers the handed-off amount so the matching card renders selected.
function snapToAmountOption(amount: number): number {
  if (amount <= 500) return 350;
  if (amount <= 1000) return 750;
  if (amount <= 2500) return 1750;
  if (amount <= 4000) return 3250;
  return 4500;
}

// Stable idempotency/tracking identifier generator.
const genId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};


// Helper Tooltip Component for labels
const LabelTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center ml-1.5 leading-none">
      <button
        type="button"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setIsOpen(!isOpen);
        }}
        onBlur={() => setIsOpen(false)}
        className="text-zinc-400 hover:text-zinc-600 transition-colors focus:outline-none inline-flex items-center"
        aria-label="Info explanation"
      >
        <Info className="w-3.5 h-3.5 cursor-help" />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.span
            initial={{ opacity: 0, y: 5, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-zinc-900 text-white text-[11px] rounded-lg shadow-lg z-50 leading-relaxed font-sans normal-case tracking-normal block text-left"
          >
            <span className="font-semibold text-zinc-100 mb-1 block">Why is this required?</span>
            <span className="block font-normal text-zinc-300">{content}</span>
            <span className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-zinc-900 block" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
};

// Tap-to-select option cards — mobile-first replacement for native <select> dropdowns.
// One tap selects the value (the caller's onSelect wires into the existing auto-advance path).
type CardOption = { value: string | number; label: string; icon?: React.ReactNode };
const OptionCards: React.FC<{
  options: CardOption[];
  value: string | number;
  onSelect: (value: string | number) => void;
  columns?: 1 | 2;
  // Two columns at EVERY width, including phones. `columns={2}` deliberately stays
  // single-column below the sm breakpoint, and changing that would move the incumbent form's
  // loan-purpose field — its only caller. This is the opt-in for lite_v1, where five stacked
  // amount cards cost ~250px and push the ZIP field and the CTA out of the first screen.
  dense?: boolean;
}> = ({ options, value, onSelect, columns = 1, dense = false }) => (
  <div
    role="radiogroup"
    className={`grid gap-2.5 ${dense ? "grid-cols-2" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}
  >
    {options.map((opt) => {
      const selected = String(value) !== "" && String(value) === String(opt.value);
      return (
        <button
          key={String(opt.value)}
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => onSelect(opt.value)}
          className={`w-full flex items-center rounded-xl border text-left font-semibold transition-all duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 ${
            dense ? "gap-2 px-3 py-2.5 min-h-[48px] text-[13px]" : "gap-3 px-4 py-3 min-h-[52px] text-sm"
          } ${
            selected
              ? "border-emerald-600 ring-1 ring-emerald-600 bg-emerald-50/60 text-zinc-900 shadow-sm"
              : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50/50"
          }`}
        >
          <span
            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all duration-150 ${
              selected ? "border-emerald-600 bg-emerald-600" : "border-zinc-300 bg-white"
            }`}
          >
            {selected && <Check className="w-3 h-3 text-white stroke-[3.5]" />}
          </span>
          {opt.icon && (
            <span className={`flex-shrink-0 ${selected ? "text-emerald-700" : "text-zinc-400"}`}>
              {opt.icon}
            </span>
          )}
          <span className="flex-1 leading-snug">{opt.label}</span>
        </button>
      );
    })}
  </div>
);

// Helper to translate field names to short user-friendly labels
const getFieldLabel = (field: string): string => {
  const labels: Record<string, string> = {
    requested_amount: "Amount",
    "loan purpose": "Purpose",
    zip: "ZIP Code",
    income_type: "Income Type",
    monthly_income: "Monthly Income",
    "birth date": "Birth Date",
    "first name": "First Name",
    email: "Email",
    "home phone": "Phone",
    "work phone": "Work Phone",
    last_name: "Last Name",
    address: "Street Address",
    apt: "Apt / Unit",
    city: "City",
    state: "State",
    address_length_months: "Time At Address",
    own_home: "Housing Status",
    employer: "Employer",
    job_title: "Job Title",
    employed_months: "Employer Duration",
    pay_date1: "Next Payday",
    pay_frequency: "Pay Frequency",
    direct_deposit: "Paycheck Method"
  };
  return labels[field] || field;
};

// Props this file reads/sets on the input elements it wraps with validation feedback.
type FieldElementProps = {
  id?: string;
  className?: string;
  children?: React.ReactNode;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void;
};

// Helper to estimate time remaining based on current step
const getEstimatedTimeRemaining = (step: number): string => {
  const times: Record<number, string> = {
    1: "approx 2 mins left",
    2: "approx 2 mins left",
    3: "approx 1.5 mins left",
    4: "approx 1.5 mins left",
    5: "approx 1.5 mins left",
    6: "approx 1 min left",
    7: "approx 1 min left",
    8: "approx 1 min left",
    9: "approx 45 secs left",
    10: "approx 45 secs left",
    11: "approx 30 secs left",
    12: "approx 30 secs left",
    13: "approx 15 secs left",
    14: "approx 10 secs left",
  };
  return times[step] || "";
};

// `embedded` = the form is mounted inline inside a brand site's own page (no iframe, no
// navigation). In that mode the App renders ONLY the application card: no full-height
// shell, no disclaimer bar / portal header / legal footer / fixed sticky bar —
// the host page owns all of that chrome. The brand always comes from the runtime config.
export interface AppProps {
  embedded?: boolean;
}

export default function App({ embedded = false }: AppProps = {}) {
  const brandName = resolveBrandName();
  // The tab title shows the brand's own keyword when the ad link carried a keyword; otherwise the page keeps its title.
  useEffect(() => {
    if (RUNTIME_CONFIG.label) document.title = RUNTIME_CONFIG.label;
  }, []);
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [showStickyBar, setShowStickyBar] = useState<boolean>(false);

  useEffect(() => {
    const handleScroll = () => {
      const container = document.getElementById("active-step-container");
      if (container) {
        const rect = container.getBoundingClientRect();
        // Calculate form midpoint or scrolling offset
        const formMidpoint = container.offsetTop + (container.offsetHeight / 2);
        const scrolledPastHalf = window.scrollY > formMidpoint || window.scrollY > 150;
        setShowStickyBar(scrolledPastHalf);
      } else {
        setShowStickyBar(window.scrollY > 200);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [currentStep]);

  // When mounted inside a host page (embedded=true), report the document height
  // to the parent frame so the host can resize the iframe. Only height is sent —
  // no sensitive data. '*' is intentional: height values carry no PII.
  useEffect(() => {
    if (!embedded) return;
    const send = () =>
      window.parent.postMessage(
        { type: "form:resize", height: document.body.scrollHeight },
        "*"
      );
    send();
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [embedded]);

  const [values, setValues] = useState<FormValues>(() => {
    const defaults: FormValues = {
      requested_amount: "",
      "loan purpose": "",
      "first name": "",
      last_name: "",
      "birth date": "",
      address: "",
      apt: "",
      city: "",
      state: "",
      zip: "",
      email: "",
      "home phone": "",
      "work phone": "",
      address_length_months: "",
      own_home: "",
      income_type: "",
      employer: "",
      job_title: "",
      employed_months: "",
      pay_date1: "",
      pay_frequency: "",
      direct_deposit: "",
      monthly_income: ""
    };

    try {
      const saved = localStorage.getItem("form_app_progress");
      if (saved) {
        const parsed = JSON.parse(saved);
        // Exclude sensitive fields from being restored
        SENSITIVE_FIELDS.forEach(field => {
          delete parsed[field];
        });
        return { ...defaults, ...parsed };
      }
    } catch (e) {
      console.error("Failed to parse saved autosave progress", e);
    }
    return defaults;
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [consentChecked, setConsentChecked] = useState<boolean>(false);
  const [shake, setShake] = useState<boolean>(false);
  const [showSaved, setShowSaved] = useState<boolean>(false);
  const saveTimeoutRef = useRef<any>(null);
  const isFirstMount = useRef<boolean>(true);

  const triggerShake = () => {
    setShake(false);
    setTimeout(() => {
      setShake(true);
    }, 10);
  };
  
  // Reference for storing initial page URL query parameters to preserve them
  const trackingParamsRef = useRef<Record<string, string>>({});
  // Stable idempotency key (LeadsGate txid) and session id for this application attempt
  const leadIdRef = useRef<string>(genId());
  const sessionIdRef = useRef<string>("");
  // Synchronous companion to the `submitting` state — see handleSubmit. State updates are
  // batched, so several clicks in one tick all observe `submitting === false`; a ref does not.
  const submitInFlightRef = useRef<boolean>(false);

  // Capture URL parameters on load
  useEffect(() => {
    // Persist a session id across reloads within the same tab
    try {
      const existing = window.sessionStorage.getItem("form_session_id");
      sessionIdRef.current = existing || genId();
      if (!existing) window.sessionStorage.setItem("form_session_id", sessionIdRef.current);
    } catch {
      sessionIdRef.current = genId();
    }

    // Preserve only the allowlisted attribution keys from the landing URL
    const params: Record<string, string> = {};
    const urlParams = new URLSearchParams(window.location.search);
    TRACKING_KEYS.forEach((key) => {
      const val = urlParams.get(key);
      if (val) params[key] = val;
    });
    trackingParamsRef.current = params;

    // Handoff from the brand landing page: it already collected the loan amount and ZIP, so pick up its values and prefill Step 1 with them. We
    // deliberately do NOT auto-advance past Step 1 — the visitor reviews the prefilled amount
    // and ZIP and presses Continue themselves.
    //
    // These params win over autosaved progress. The visitor picked this amount and ZIP on
    // the landing page seconds ago; the autosave may be weeks old. Gating the handoff on
    // `!hasSavedProgressRef.current` (as this did) meant any returning visitor silently got
    // their *previous* amount and state back — landing on Step 1 with a stale selection, and
    // able to submit a lead for an amount they never chose in this session, with a `state`
    // left over from an old ZIP. Restoring the autosave is still worthwhile for the ~20
    // fields the landing page does NOT collect; it just must not outrank an explicit,
    // in-URL handoff for the two fields that it does.
    {
      // The brand Worker already validated amount + ZIP at the flow gate and repeats them in the
      // runtime config; the URL values (V1 behaviour) win, the config is the fallback.
      const amountParam = Number(urlParams.get("requested_amount")) || RUNTIME_CONFIG.amount || 0;
      const zipHandoff = (urlParams.get("zip") || RUNTIME_CONFIG.zip || "").trim();
      const amountOk = REQUESTED_AMOUNT_BUCKETS.has(amountParam) || (amountParam > 0 && amountParam === RUNTIME_CONFIG.amount);
      const zipOk = /^\d{5}$/.test(zipHandoff);

      if (amountOk) {
        // Snap to one of the amount picker's five canonical option values (see
        // snapToAmountOption) so the matching card actually renders selected, rather than
        // prefilling a raw bucket value no card highlights.
        setValues(prev => ({ ...prev, requested_amount: snapToAmountOption(amountParam) }));
      }
      // The lookup runs exactly as if the ZIP had been typed, so city/state autofill and their
      // errors clear the same way — which also repairs a `state` restored from an older,
      // unrelated ZIP. Applied independently of the amount: a landing may hand off one without
      // the other.
      if (zipOk) {
        setValues(prev => ({ ...prev, zip: zipHandoff }));
        void lookupZipCityState(zipHandoff);
      }
    }

    // Register PostHog session context, then fire landing_viewed (the form's
    // first paint for this session — was allowlisted with no call site before this) followed
    // by form_started.
    registerSessionContext(sessionIdRef.current, params);
    trackEvent("landing_viewed", { entry_source: params.utm_source || params.source });
    trackFormStarted(sessionIdRef.current);

    // D1-backed traffic telemetry (independent of PostHog account access — see
    // lib/traffic-telemetry.ts). Mirrors the two PostHog events above.
    const trafficAttrs = {
      brand: brandName,
      source: params.utm_source || params.source,
      campaign: params.utm_campaign,
    };
    sendTraffic("landing_viewed", sessionIdRef.current, trafficAttrs);
    sendTraffic("form_started", sessionIdRef.current, trafficAttrs);

    // Initialize browser state for back/forward navigation
    window.history.replaceState({ step: 1 }, "", "");
  }, []);

  // Implement auto-scroll on input focus and track active field
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA") &&
        (target as HTMLInputElement).type !== "range"
      ) {
        // Track which field is currently focused
        const fieldId = target.id || target.getAttribute("name");
        if (fieldId) {
          setActiveField(fieldId);
        }

        // Smoothly scroll the focused element to the center of the viewport
        setTimeout(() => {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 150); // slight delay to allow mobile keyboard to display/resize
      }
    };

    window.addEventListener("focusin", handleFocusIn);
    return () => {
      window.removeEventListener("focusin", handleFocusIn);
    };
  }, []);

  // Sync state changes with browser history
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state && typeof event.state.step === "number") {
        setCurrentStep(event.state.step);
      } else {
        setCurrentStep(1);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Track when a step is viewed
  useEffect(() => {
    const stepConfig = STEPS[currentStep - 1];
    if (stepConfig) {
      trackEvent("form_step_viewed", {
        form_step: currentStep,
        requested_amount_bucket: values.requested_amount || undefined,
      });
      // Mirror into our own store. PostHog transmits nothing on production as of
      // 2026-09-07, so trackEvent above is currently write-only.
      sendTraffic("form_step_viewed", sessionIdRef.current, {
        form_step: currentStep,
        brand: brandName,
      });
    }

    // Auto-focus the first editable input or select element on active step
    setTimeout(() => {
      const container = document.getElementById("active-step-container");
      if (container) {
        const firstInput = container.querySelector(
          'input:not([type="range"]):not([readonly]), select'
        ) as HTMLInputElement | HTMLSelectElement | null;
        if (firstInput) {
          firstInput.focus();
        }
      }
    }, 100);
  }, [currentStep]);

  // Persist non-sensitive form state to local storage on changes
  useEffect(() => {
    try {
      const cleanData: Record<string, any> = { ...values };
      // Remove sensitive fields entirely before storing
      SENSITIVE_FIELDS.forEach(field => {
        delete cleanData[field];
      });
      localStorage.setItem("form_app_progress", JSON.stringify(cleanData));

      // Show temporary subtle "Changes saved" indicator, skipping the first mount
      if (isFirstMount.current) {
        isFirstMount.current = false;
      } else {
        setShowSaved(true);
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => {
          setShowSaved(false);
        }, 1500);
      }
    } catch (e) {
      console.error("Failed to write to localStorage", e);
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [values]);

  // Only auto-advance native <select> steps on a real pointer/tap, never on keyboard navigation
  // (arrow keys fire `change` on a closed native select, which would skip steps — WCAG 3.2.2).
  useEffect(() => {
    const onPointer = () => { selectAdvanceOkRef.current = true; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" ||
          e.key === "ArrowRight" || e.key === "Tab" || e.key === " " || e.key === "Enter") {
        selectAdvanceOkRef.current = false;
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // Dynamic minimum and maximum birth dates for standard 18-95 age checks relative to current year 2026
  const getBirthDateLimits = () => {
    const today = new Date();
    const currentYear = today.getUTCFullYear();
    const minBirthYear = currentYear - 95;
    const maxBirthYear = currentYear - 18;
    const pad = (num: number) => String(num).padStart(2, "0");
    const formatted = (year: number) => `${year}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    return {
      min: formatted(minBirthYear),
      max: formatted(maxBirthYear)
    };
  };

  // Dynamic min/max for the next-payday date picker: today through +45 days.
  const getPayDateLimits = () => {
    const pad = (num: number) => String(num).padStart(2, "0");
    const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const today = new Date();
    const max = new Date(today);
    max.setUTCDate(max.getUTCDate() + 45);
    return { min: fmt(today), max: fmt(max) };
  };

  // Dynamic birth date validator
  const validateBirthDate = (val: string): string => {
    if (!val) return "This field is required.";
    const birthDate = new Date(val);
    if (isNaN(birthDate.getTime())) return "Invalid date.";
    
    const today = new Date();
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const m = today.getUTCMonth() - birthDate.getUTCMonth();
    if (m < 0 || (m === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
      age--;
    }
    
    if (age < 18 || age > 95) {
      return "Applicant must be between 18 and 95 years old.";
    }
    return "";
  };

  // Central validation dispatcher
  const validateField = (name: keyof FormValues, value: any): string => {
    const strVal = String(value || "").trim();
    
    switch (name) {
      case "requested_amount": {
        const amt = Number(value);
        if (isNaN(amt) || amt < 100 || amt > 5000) {
          return "Amount must be between 100 and 5,000.";
        }
        return "";
      }
      case "loan purpose":
        if (!strVal) return "Please select a loan purpose.";
        return "";
      case "first name":
        if (!strVal) return "First name is required.";
        if (strVal.length < 2 || strVal.length > 128) return "First name must be between 2 and 128 characters.";
        if (!/^[a-zA-Z\s\-\']+$/.test(strVal)) return "Please enter letters and spaces only.";
        return "";
      case "last_name":
        if (!strVal) return "Last name is required.";
        if (strVal.length < 2 || strVal.length > 128) return "Last name must be between 2 and 128 characters.";
        if (!/^[a-zA-Z\s\-\']+$/.test(strVal)) return "Please enter letters and spaces only.";
        return "";
      case "birth date":
        return validateBirthDate(strVal);
      case "email":
        if (!strVal) return "Email address is required.";
        if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(strVal)) {
          return "Please enter a valid email address (e.g. name@domain.com).";
        }
        return "";
      case "home phone": {
        const ph = strVal.replace(/\D/g, "");
        if (!ph) return "Home phone number is required.";
        if (ph.length !== 10) return "Phone number must be exactly 10 digits.";
        return "";
      }
      case "work phone": {
        const ph = strVal.replace(/\D/g, "");
        if (!ph) return "Work phone number is required.";
        if (ph.length !== 10) return "Phone number must be exactly 10 digits.";
        return "";
      }
      case "address":
        if (!strVal) return "Street address is required.";
        if (strVal.length < 2) return "Address must be at least 2 characters.";
        return "";
      case "city":
        if (!strVal) return "City is required.";
        return "";
      case "state":
        if (!strVal) return "State is required.";
        if (!/^[a-zA-Z]{2}$/.test(strVal)) return "Please enter a 2-letter state abbreviation (e.g. NY).";
        return "";
      case "zip": {
        const zipDigits = strVal.replace(/\D/g, "");
        if (!zipDigits) return "ZIP code is required.";
        if (zipDigits.length !== 5) return "ZIP code must be exactly 5 digits.";
        return "";
      }
      case "income_type":
        if (!strVal) return "Please select income type.";
        return "";
      case "monthly_income": {
        const inc = Number(value);
        if (!strVal) return "Income is required.";
        if (isNaN(inc) || inc < 1126 || inc > 6000) return "Monthly income must be between $1,126 and $6,000.";
        return "";
      }
      case "address_length_months":
        if (!strVal) return "Please select how long you've lived at this address.";
        return "";
      case "own_home":
        if (!strVal) return "Please select your housing status.";
        return "";
      case "employer":
        if (!strVal) return "Employer name is required.";
        if (strVal.length < 2 || strVal.length > 128) return "Employer name must be between 2 and 128 characters.";
        return "";
      case "job_title":
        if (!strVal) return "Job title is required.";
        if (strVal.length < 2 || strVal.length > 128) return "Job title must be between 2 and 128 characters.";
        return "";
      case "employed_months":
        if (!strVal) return "Please select how long you've been with your employer.";
        return "";
      case "pay_date1": {
        if (!strVal) return "Please select your next payday.";
        const limits = getPayDateLimits();
        if (strVal < limits.min || strVal > limits.max) return "Please select a date within the next 45 days.";
        return "";
      }
      case "pay_frequency":
        if (!strVal) return "Please select your pay frequency.";
        return "";
      case "direct_deposit":
        if (!strVal) return "Please select how your paycheck is received.";
        return "";
      default:
        return "";
    }
  };

  // Helper to move focus to the next field in the current step or advance the step
  const moveToNextFieldOrStep = (name: keyof FormValues, currentVal?: any) => {
    if (!activeStepConfig) return;
    const fields = activeStepConfig.fields;
    const currentIndex = fields.indexOf(name);
    const val = currentVal !== undefined ? currentVal : values[name];
    
    // Set field as touched and validate
    setTouched(prev => ({ ...prev, [name]: true }));
    const errorMsg = validateField(name, val);
    setErrors(prev => {
      const copy = { ...prev };
      if (errorMsg) {
        copy[name] = errorMsg;
      } else {
        delete copy[name];
      }
      return copy;
    });

    if (errorMsg) return; // do not advance if invalid

    if (currentIndex !== -1 && currentIndex < fields.length - 1) {
      const nextField = fields[currentIndex + 1];
      setTimeout(() => {
        const nextEl = document.getElementById(nextField);
        if (nextEl) {
          nextEl.focus();
        }
      }, 80);
    } else if (currentIndex === fields.length - 1) {
      // It's the last field in the step. Auto-advance step if all fields in this step are valid.
      const allOtherFieldsValid = fields.every(f => {
        if (f === name) return true;
        if (f === "apt") return true; // optional
        const fVal = values[f];
        if (!fVal) return false;
        return validateField(f, fVal) === "";
      });

      if (allOtherFieldsValid && currentStep < TOTAL_STEPS) {
        setTimeout(() => {
          // Pass the just-set value explicitly — the `values` in this closure is stale
          // (React state hasn't re-rendered into this callback), so without it the first
          // selection on a single-field step validates as empty and shakes.
          handleContinue(undefined, { [name]: val } as Partial<FormValues>);
        }, 350); // slight delay to allow the user to see the success checkmark
      }
    }
  };

  // ZIP -> city/state autofill (server-side lookup; keeps the 2 MB dataset off the client).
  const zipLookupRef = useRef<string>("");
  // Gate native-<select> auto-advance to a real pointer/tap (see the effect above) so keyboard
  // arrow navigation never skips a step (WCAG 3.2.2); toggled by the document pointer/key listeners.
  const selectAdvanceOkRef = useRef<boolean>(false);
  // Latest ZIP-autofill result, so handleContinue/handleSubmit see city/state even when they resume
  // from a pre-lookup `values` closure after awaiting the in-flight lookup.
  const zipFillRef = useRef<Partial<FormValues>>({});
  // Tracks the in-flight lookup so handleContinue/handleSubmit can wait for it — otherwise
  // hitting "Proceed" right after typing the ZIP validates city/state as empty a split
  // second before this fills them in, showing a false red error + shake.
  const zipLookupPromiseRef = useRef<Promise<void> | null>(null);
  const lookupZipCityState = (zip: string): Promise<void> => {
    if (zip.length !== 5 || zipLookupRef.current === zip) return Promise.resolve();
    zipLookupRef.current = zip;
    // Named rather than an IIFE so the `finally` below can compare against `promise`.
    const run = async () => {
      // Bounded: handleContinue and handleSubmit both `await` this promise before they will
      // advance or submit, so an unbounded lookup (cold start, captive portal, dropped
      // connection) would leave "Proceed"/"Submit" permanently inert — no spinner, no error,
      // no telemetry, nothing the applicant can do. The lookup is a convenience; city/state
      // remain typable by hand, so give up quickly rather than block the funnel.
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), FORM_CONFIG.zipLookupTimeoutMs);
      try {
        const res = await fetch(`/api/zip?zip=${encodeURIComponent(zip)}`, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.found && data.city && data.state) {
          const filledState = String(data.state).toUpperCase().slice(0, 2);
          zipFillRef.current = { city: data.city, state: filledState };
          setValues(prev => ({ ...prev, city: data.city, state: filledState }));
          setErrors(prev => { const copy = { ...prev }; delete copy.city; delete copy.state; return copy; });
          // Mark as touched so the revealed fields immediately show the green "verified" state.
          setTouched(prev => ({ ...prev, city: true, state: true }));
        }
      } catch {
        /* non-blocking (incl. AbortError on timeout): the user can still type city/state manually */
      } finally {
        window.clearTimeout(timeoutId);
        // Let a later attempt for this same ZIP retry rather than being suppressed by the
        // zipLookupRef guard, and never leave a settled promise pinned as "in flight".
        if (zipLookupPromiseRef.current === promise) zipLookupPromiseRef.current = null;
      }
    };
    const promise = run();
    zipLookupPromiseRef.current = promise;
    return promise;
  };

  // Handle field updates
  const handleFieldChange = (name: keyof FormValues, value: any) => {
    let sanitizedVal = value;
    
    // Restrict numerical input constraints dynamically
    if (["home phone", "work phone"].includes(name as string)) {
      const digits = String(value).replace(/\D/g, "").slice(0, 10);
      if (digits.length <= 3) {
        sanitizedVal = digits;
      } else if (digits.length <= 6) {
        sanitizedVal = `${digits.slice(0, 3)}-${digits.slice(3)}`;
      } else {
        sanitizedVal = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
    } else if (name === "zip") {
      sanitizedVal = String(value).replace(/\D/g, "").slice(0, 5);
    } else if (name === "state") {
      sanitizedVal = String(value).replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2);
    }

    setValues(prev => ({
      ...prev,
      [name]: sanitizedVal
    }));

    // On a complete 5-digit ZIP, look up and prefill city + state.
    if (name === "zip" && String(sanitizedVal).length === 5) {
      lookupZipCityState(String(sanitizedVal));
    }

    // Perform live validation on touched fields
    if (touched[name]) {
      const errorMsg = validateField(name, sanitizedVal);
      setErrors(prev => {
        const copy = { ...prev };
        if (errorMsg) {
          copy[name] = errorMsg;
        } else {
          delete copy[name];
        }
        return copy;
      });
    }

    // Check for auto-focus/advance eligibility
    const errorMsgForAdvance = validateField(name, sanitizedVal);
    if (!errorMsgForAdvance && sanitizedVal !== "") {
      const isSelect = [
        "requested_amount", "loan purpose", "income_type", "address_length_months", "own_home",
        "employed_months", "pay_frequency", "direct_deposit",
      ].includes(name as string);
      const isFixedLength = (
        (name === "zip" && sanitizedVal.length === 5) ||
        (name === "state" && sanitizedVal.length === 2) ||
        (name === "birth date" && sanitizedVal.length === 10) ||
        (name === "pay_date1" && sanitizedVal.length === 10) ||
        (["home phone", "work phone"].includes(name as string) && sanitizedVal.replace(/\D/g, "").length === 10)
      );

      if ((isSelect && selectAdvanceOkRef.current) || isFixedLength) {
        moveToNextFieldOrStep(name, sanitizedVal);
      }
    }
  };

  const handleBlur = (name: keyof FormValues) => {
    setTouched(prev => ({ ...prev, [name]: true }));
    const errorMsg = validateField(name, values[name]);
    setErrors(prev => {
      const copy = { ...prev };
      if (errorMsg) {
        copy[name] = errorMsg;
      } else {
        delete copy[name];
      }
      return copy;
    });
  };

  // Step progression handler. `freshValues` lets auto-advance callers (setTimeout closures)
  // supply just-set field values that this render's `values` doesn't contain yet.
  const handleContinue = async (e?: React.FormEvent, freshValues?: Partial<FormValues>) => {
    if (e) e.preventDefault();

    // Let any in-flight ZIP autofill lookup finish before validating this step's fields
    // (see zipLookupPromiseRef above) — avoids a false city/state error + shake.
    if (zipLookupPromiseRef.current) {
      await zipLookupPromiseRef.current;
    }

    const activeStep = STEPS[currentStep - 1];
    let isStepValid = true;
    const newErrors: Record<string, string> = {};
    const newTouched: Record<string, boolean> = {};
    const effectiveValues = { ...values, ...zipFillRef.current, ...(freshValues || {}) };

    activeStep.fields.forEach(field => {
      newTouched[field] = true;
      const errorMsg = validateField(field, effectiveValues[field]);
      if (errorMsg) {
        isStepValid = false;
        newErrors[field] = errorMsg;
        
        trackEvent("form_validation_failed", {
          form_step: currentStep,
          failure_category: "field_validation",
        });
      }
    });

    setTouched(prev => ({ ...prev, ...newTouched }));
    setErrors(prev => ({ ...prev, ...newErrors }));

    if (!isStepValid) {
      triggerShake();
      // Fired once per invalid step-advance attempt (not once per invalid field — the
      // per-field trackEvent above already covers that granularity for PostHog).
      sendTraffic("form_validation_failed", sessionIdRef.current, {
        form_step: currentStep,
        brand: brandName,
        // CODE only. The per-field message can contain what the applicant typed.
        error_code: "field_validation",
      });
      return;
    }

    trackEvent("form_step_completed", { form_step: currentStep });
    sendTraffic("form_step_completed", sessionIdRef.current, {
      form_step: currentStep,
      brand: brandName,
    });

    // Advance
    if (currentStep < TOTAL_STEPS) {
      const nextStep = currentStep + 1;
      setCurrentStep(nextStep);
      window.history.pushState({ step: nextStep }, "", "");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // Step regression handler
  const handleBack = () => {
    if (currentStep > 1) {
      // Calling history.back will trigger popstate listener which decrements currentStep
      window.history.back();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // Submission handler
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    // `submitting` is React state, so it is stale for every click that lands in the same tick as
    // the first one — three rapid clicks all read `false` and all POST. The server's
    // Idempotency-Key makes the extra ones return "duplicate" (one lead, one conversion), but
    // they are still real requests carrying full PII. A ref updates synchronously, so it closes
    // the window that state cannot. Cleared in the finally below on every path that stays on the
    // page; deliberately NOT cleared on success, where we navigate away.
    if (submitting || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      await runSubmit();
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const runSubmit = async () => {
    // Same race guard as handleContinue — final validation must not run while a ZIP
    // autofill lookup is still in flight.
    if (zipLookupPromiseRef.current) {
      await zipLookupPromiseRef.current;
    }

    if (!consentChecked) {
      triggerShake();
      return;
    }

    // Validate ALL fields on submission to be 100% sure
    let isAllValid = true;
    const allErrors: Record<string, string> = {};
    const allTouched: Record<string, boolean> = {};

    // Merge the latest ZIP autofill so final validation doesn't see stale-empty city/state.
    const merged = { ...values, ...zipFillRef.current };
    STEPS.forEach(step => {
      step.fields.forEach(field => {
        allTouched[field] = true;
        const errorMsg = validateField(field, merged[field]);
        if (errorMsg) {
          isAllValid = false;
          allErrors[field] = errorMsg;
        }
      });
    });

    if (!isAllValid) {
      setErrors(allErrors);
      setTouched(allTouched);
      // Locate the first step containing an error and jump to it
      for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i];
        const stepHasError = step.fields.some(f => allErrors[f]);
        if (stepHasError) {
          setCurrentStep(step.id);
          window.scrollTo({ top: 0, behavior: "smooth" });
          triggerShake();
          return;
        }
      }
      triggerShake();
      return;
    }

    setSubmitting(true);
    trackEvent("lead_submission_started", {
      requested_amount_bucket: values.requested_amount,
    });
    sendTraffic("lead_submission_started", sessionIdRef.current);

    // Build a LeadsGate-shaped lead. The browser posts this ONLY to same-origin /api/leads;
    // the server forwards it to the buyer and fires the ClickFlare postback. No PII leaves
    // the browser except to our own origin, and nothing is placed in a URL query string.
    const digitsOnly = (v: any) => String(v || "").replace(/\D/g, "");
    const streetWithApt = values.apt ? `${values.address}, ${values.apt}` : values.address;

    const tracking: Record<string, string> = {};
    TRACKING_KEYS.forEach((key) => {
      const val = trackingParamsRef.current[key];
      if (val) tracking[key] = String(val);
    });

    const payload = {
      lead_id: leadIdRef.current,
      session_id: sessionIdRef.current,
      form_version: FORM_CONFIG.formVersion,
      // The arm this visitor actually saw — NOT FORM_CONFIG.formVariant, which is the static
      // contract identity. The worker's variant-scoped validation keys off this exact string:
      // send the wrong one and it enforces the 14-step rules against a 4-field payload and
      // rejects every lite lead.
      form_variant: resolveVariant(),
      site: {
        site_id: FORM_CONFIG.siteId,
        // Store the SAME brand the user actually saw and consented to, not the shared neutral
        // default — otherwise the FCRA/TCPA consent record can't prove which brand was shown.
        // This is `brandName`, the exact value rendered into the consent paragraphs above, rather
        // than a second independent brand lookup that could disagree with it.
        brand: brandName,
        hostname: window.location.hostname,
      },
      // Field names + values already match the LeadsGate GET-param spec.
      lead: {
        requested_amount: String(values.requested_amount),
        loan_purpose: values["loan purpose"],
        first_name: values["first name"],
        last_name: values.last_name,
        birth_date: values["birth date"],
        email: String(values.email || "").trim().toLowerCase(),
        home_phone: digitsOnly(values["home phone"]),
        work_phone: digitsOnly(values["work phone"]),
        address: streetWithApt,
        city: values.city,
        state: values.state,
        zip: values.zip,
        address_length_months: String(values.address_length_months),
        own_home: values.own_home === "2" ? "0" : values.own_home,
        income_type: values.income_type,
        employer: values.employer,
        job_title: values.job_title,
        employed_months: String(values.employed_months),
        pay_date1: values.pay_date1,
        pay_frequency: values.pay_frequency,
        direct_deposit: values.direct_deposit,
        monthly_income: String(values.monthly_income),
      },
      consent: {
        application_consent: true,
        consent_version: FORM_CONFIG.consentVersion,
        partner_list_version: FORM_CONFIG.partnerListVersion,
        accepted_at: new Date().toISOString(),
        page_url: `${window.location.origin}${window.location.pathname}`,
      },
      tracking,
      metadata: {
        landing_page_url: `${window.location.origin}${window.location.pathname}`,
        referrer: document.referrer ? new URL(document.referrer).origin : "",
        hostname: window.location.hostname,
        submitted_at: new Date().toISOString(),
      },
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FORM_CONFIG.requestTimeoutMs);

    try {
      const response = await fetch(FORM_CONFIG.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": leadIdRef.current,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let result: any = {};
      try { result = await response.json(); } catch { /* tolerate empty body */ }

      if (!response.ok) {
        throw new Error(result?.message || `Lead intake failed (${response.status})`);
      }

      if (result.status === "accepted" || result.status === "duplicate") {
        // Clear recovery state only after the server has accepted the lead. Best-effort:
        // every other localStorage touch in this file is already wrapped, and this one sits
        // INSIDE the submit try{} whose catch renders "something went wrong". Unguarded, a
        // browser that throws on storage access (Safari Private Browsing, storage disabled by
        // policy, a partitioned third-party iframe context — this form is iframed by
        // a partner site) would turn an ACCEPTED, already-delivered lead into a permanent
        // failure screen: the retry returns "duplicate", throws here again, and never redirects.
        try {
          localStorage.removeItem("form_app_progress");
        } catch (e) {
          console.error("Failed to clear saved progress", e);
        }
        trackEvent("lead_submitted", {
          submission_stage: result.status === "duplicate" ? "duplicate" : "accepted",
        });
        sendTraffic("lead_submitted", sessionIdRef.current);
        const ref = encodeURIComponent(
          result.reference || String(result.lead_id || leadIdRef.current).slice(-8)
        );
        // redirect_started/redirect_succeeded both fire here, immediately before the browser
        // navigates away: the page unloads before any later code could run, so there is no
        // client-observable moment after navigation to confirm "succeeded" against. Both
        // events describe the same true, verifiable fact — the server accepted the lead and
        // returned a redirect target, and the client is now dispatching it — as distinct from
        // redirect_failed below, which fires only on a genuine network/submission error before
        // any redirect target was ever obtained.
        trackEvent("redirect_started", { submission_stage: result.status });
        trackEvent("redirect_succeeded", { submission_stage: result.status });
        sendTraffic("redirect_started", sessionIdRef.current);
        window.location.assign(result.redirect_url || `${FORM_CONFIG.thankYouPath}?ref=${ref}`);
        return;
      }

      throw new Error(result?.message || "We could not complete your request. Please try again.");
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      setSubmitting(false);
      setErrors(prev => ({
        ...prev,
        submit: isTimeout
          ? "The request timed out. Please check your connection and try again."
          : (err?.message || "Something went wrong while submitting. Please try again."),
      }));
      triggerShake();

      captureOperationalError(err, {
        operation: "form_submission_transport",
        failure_category: isTimeout ? "timeout" : "submission_error",
        submission_stage: `step-${TOTAL_STEPS}`,
        // NOT actually opaque as previously written: leadIdRef.current is the exact D1
        // lead_id UUID (it's sent verbatim as the Idempotency-Key header and, on success,
        // becomes leads.lead_id). Sending the full value to Sentry would let anyone with
        // Sentry access pinpoint the exact D1 row. Truncate to the same last-8 "reference"
        // this codebase already treats as safe to expose (see the ref/reference values used
        // in redirect URLs and the admin leads table) — enough to correlate repeated Sentry
        // events from one submission attempt without granting Sentry a full lead lookup key.
        opaque_request_id: leadIdRef.current.slice(-8),
      });
      const failureCategory = isTimeout ? "timeout" : "submission_error";
      trackEvent("redirect_failed", { failure_category: failureCategory });
      sendTraffic("redirect_failed", sessionIdRef.current, {
        brand: brandName,
        error_code: isTimeout ? "submit_timeout" : "submit_network_error",
      });

      // Best-effort, non-blocking error telemetry (no PII).
      fetch(FORM_CONFIG.errorEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error_type: isTimeout ? "timeout" : "submission_error",
          error_message: String(err?.message || "unknown").slice(0, 200),
          session_id: sessionIdRef.current,
          screen_id: `step-${TOTAL_STEPS}`,
          occurred_at: new Date().toISOString(),
        }),
      }).catch(() => {});
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  // Jump helper for summary review links
  const jumpToStep = (stepId: number) => {
    setCurrentStep(stepId);
    window.history.pushState({ step: stepId }, "", "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const activeStepConfig = STEPS[currentStep - 1];

  // City + State stay hidden until a full 5-digit ZIP is entered — they are then revealed,
  // normally already auto-filled by the /api/zip lookup (manual entry stays possible as fallback).
  const zipComplete = String(values.zip || "").length === 5;
  const visibleStepFields = activeStepConfig
    ? activeStepConfig.fields.filter(f => (f !== "city" && f !== "state") || zipComplete)
    : [];

  // Helper to determine the currently active field within the step
  const currentActiveField = activeStepConfig && activeStepConfig.fields.includes((activeField || "") as keyof FormValues)
    ? activeField
    : activeStepConfig
    ? activeStepConfig.fields.find(f => {
        const val = values[f];
        const hasVal = val !== undefined && val !== null && String(val).trim() !== "";
        return !hasVal || errors[f];
      }) || activeStepConfig.fields[0]
    : "";

  // Helper to check if current step fields are valid to toggle the Continue button state
  const isCurrentStepValid = () => {
    if (currentStep === TOTAL_STEPS) return consentChecked;
    return activeStepConfig.fields.every(field => {
      const val = values[field];
      if (field === "apt") return true; // apt is optional
      if (!val) return false;
      const err = validateField(field, val);
      return err === "";
    });
  };

  // Step mapping progress percent
  const progressPercent = Math.min(100, Math.round(((currentStep - 1) / (TOTAL_STEPS - 1)) * 100));

  // Wrap field components to inject instant validation border styles and success checkmarks
  const wrapWithValidationFeedback = (fieldName: keyof FormValues, element: React.ReactNode): React.ReactNode => {
    if (!React.isValidElement<FieldElementProps>(element)) return element;

    const errorMsg = errors[fieldName];
    const isFieldTouched = touched[fieldName];
    const hasError = isFieldTouched && !!errorMsg;
    const isFieldValid = isFieldTouched && !errorMsg && String(values[fieldName] || "").trim() !== "";

    const children = React.Children.toArray(element.props.children);
    const updatedChildren = children.map((child, index) => {
      if (!React.isValidElement<FieldElementProps>(child)) return child;

      // Check if child is direct input/select
      if (child.type === "input" || child.type === "select") {
        let validationClasses = "";
        if (hasError) {
          validationClasses = " !border-red-300 focus:!ring-red-500 focus:!border-red-500 bg-red-50/5 pr-10";
        } else if (isFieldValid) {
          validationClasses = " !border-emerald-500 focus:!ring-emerald-500 focus:!border-emerald-500 bg-emerald-50/10 pr-10";
        }

        const existingClassName = child.props.className || "";
        const clonedInput = React.cloneElement(child as React.ReactElement<FieldElementProps>, {
          id: fieldName,
          className: `${existingClassName}${validationClasses}`,
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              moveToNextFieldOrStep(fieldName);
            }
            if (child.props.onKeyDown) {
              child.props.onKeyDown(e);
            }
          }
        });

        return (
          <div key={`wrapper-${index}`} className="relative w-full">
            {clonedInput}
            {isFieldValid && (
              <div className="absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none flex items-center">
                <Check className="w-4 h-4 text-emerald-600" />
              </div>
            )}
          </div>
        );
      }

      // Check if child is relative container (e.g. for monthly_income, custom relative inputs)
      if (child.type === "div" && child.props.className?.includes("relative")) {
        const subChildren = React.Children.toArray(child.props.children);
        const updatedSubChildren = subChildren.map((subChild) => {
          if (!React.isValidElement<FieldElementProps>(subChild)) return subChild;

          if (subChild.type === "input") {
            let validationClasses = "";
            if (hasError) {
              validationClasses = " !border-red-300 focus:!ring-red-500 focus:!border-red-500 bg-red-50/5 pr-10";
            } else if (isFieldValid) {
              validationClasses = ` !border-emerald-500 focus:!ring-emerald-500 focus:!border-emerald-500 bg-emerald-50/10 pr-10`;
            }

            const existingClassName = subChild.props.className || "";
            return React.cloneElement(subChild as React.ReactElement<FieldElementProps>, {
              id: fieldName,
              className: `${existingClassName}${validationClasses}`,
              onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  moveToNextFieldOrStep(fieldName);
                }
                if (subChild.props.onKeyDown) {
                  subChild.props.onKeyDown(e);
                }
              }
            });
          }
          return subChild;
        });

        return React.cloneElement(child, { key: `relative-container-${index}` }, ...updatedSubChildren, isFieldValid && (
          <div key="checkmark" className="absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none flex items-center">
            <Check className="w-4 h-4 text-emerald-600" />
          </div>
        ));
      }

      return child;
    });

    return React.cloneElement(element, {}, ...updatedChildren);
  };

  // Interface mapper for custom fields
  const renderField = (fieldName: keyof FormValues) => {
    const errorMsg = errors[fieldName];
    const isFieldTouched = touched[fieldName];
    const hasError = isFieldTouched && !!errorMsg;

    switch (fieldName) {
      case "requested_amount": {
        return (
          <div className="w-full">
            {/* On lite_v1 the section heading two lines above already reads "Requested Amount",
                so this label only repeats it. The labels stay as RANGES on every variant: the
                stored values (350, 750, 1750 …) are range midpoints, so collapsing them to a
                single figure the way the reference sites do would state an amount the applicant
                did not choose. */}
            {!IS_LITE && (
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Desired Loan Amount <span className="text-red-500">*</span></label>
            )}
            <OptionCards
              dense={IS_LITE}
              options={[
                { value: 350, label: "$200 — $500" },
                { value: 750, label: "$500 — $1,000" },
                { value: 1750, label: "$1,000 — $2,500" },
                { value: 3250, label: "$2,500 — $4,000" },
                { value: 4500, label: "More than $4,000" },
              ]}
              value={values.requested_amount}
              onSelect={(v) => handleFieldChange("requested_amount", Number(v))}
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "loan purpose": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Loan Purpose <span className="text-red-500">*</span></label>
            <OptionCards
              columns={2}
              options={[
                { value: "DEBT_CONSOLIDATION", label: "Debt Consolidation", icon: <Layers className="w-4 h-4" /> },
                { value: "EMERGENCY_SITUATION", label: "Emergency Situation", icon: <Zap className="w-4 h-4" /> },
                { value: "CREDIT_CARD_CONSOLIDATION", label: "Credit Card Consolidation", icon: <CreditCard className="w-4 h-4" /> },
                { value: "AUTO_PURCHASE", label: "Auto Purchase or Repair", icon: <Car className="w-4 h-4" /> },
                { value: "HOME_IMPROVEMENT", label: "Home Improvement", icon: <Home className="w-4 h-4" /> },
                { value: "MEDICAL", label: "Medical Expense", icon: <Stethoscope className="w-4 h-4" /> },
                { value: "BUSINESS", label: "Business Investment", icon: <Briefcase className="w-4 h-4" /> },
                { value: "TAXES", label: "Taxes Payment", icon: <Receipt className="w-4 h-4" /> },
                { value: "RENT_OR_MORTGAGE", label: "Rent or Mortgage", icon: <KeyRound className="w-4 h-4" /> },
                { value: "OTHER", label: "Other Purpose", icon: <MoreHorizontal className="w-4 h-4" /> },
              ]}
              value={values["loan purpose"]}
              onSelect={(v) => handleFieldChange("loan purpose", String(v))}
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "first name": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">First Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values["first name"]}
              onChange={(e) => handleFieldChange("first name", e.target.value)}
              onBlur={() => handleBlur("first name")}
              placeholder="e.g. John"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "last_name": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Last Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.last_name}
              onChange={(e) => handleFieldChange("last_name", e.target.value)}
              onBlur={() => handleBlur("last_name")}
              placeholder="e.g. Smith"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "birth date": {
        const limits = getBirthDateLimits();
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Birth Date <span className="text-red-500">*</span></label>
            <input
              type="date"
              value={values["birth date"]}
              min={limits.min}
              max={limits.max}
              onChange={(e) => handleFieldChange("birth date", e.target.value)}
              onBlur={() => handleBlur("birth date")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "email": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Email Address <span className="text-red-500">*</span></label>
            <input
              type="email"
              inputMode="email"
              value={values.email}
              onChange={(e) => handleFieldChange("email", e.target.value)}
              onBlur={() => handleBlur("email")}
              placeholder="example@domain.com"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "home phone": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">
              {TRANSLATIONS.phone} <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              inputMode="numeric"
              value={values["home phone"]}
              onChange={(e) => handleFieldChange("home phone", e.target.value)}
              onBlur={() => handleBlur("home phone")}
              placeholder="e.g. 555-123-4567"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "work phone": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">
              {TRANSLATIONS.workPhone} <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              inputMode="numeric"
              value={values["work phone"]}
              onChange={(e) => handleFieldChange("work phone", e.target.value)}
              onBlur={() => handleBlur("work phone")}
              placeholder="e.g. 555-765-4321"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
            
            {/* High-converting, compliance-friendly anxiety reducer text */}
            <p className="mt-3 text-[11px] text-zinc-400 font-normal leading-relaxed flex items-start gap-1.5 bg-zinc-50/50 border border-zinc-200/50 p-2.5 rounded-lg select-text">
              <span>{TRANSLATIONS.phoneAnxiety}</span>
            </p>
          </div>
        );
      }

      case "address": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Street Address <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.address}
              onChange={(e) => handleFieldChange("address", e.target.value)}
              onBlur={() => handleBlur("address")}
              placeholder="e.g. 123 Main St"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "apt": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Apartment, Unit, Suite, etc. <span className="text-zinc-400 text-[10px] lowercase font-normal">(optional)</span></label>
            <input
              type="text"
              value={values.apt || ""}
              onChange={(e) => handleFieldChange("apt", e.target.value)}
              placeholder="e.g. Apt 4B"
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
          </div>
        );
      }

      case "city": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">City <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.city}
              onChange={(e) => handleFieldChange("city", e.target.value)}
              onBlur={() => handleBlur("city")}
              placeholder="e.g. New York"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "state": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2 whitespace-nowrap">State <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.state}
              onChange={(e) => handleFieldChange("state", e.target.value)}
              onBlur={() => handleBlur("state")}
              placeholder="e.g. NY"
              required
              maxLength={2}
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm font-sans"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "zip": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">ZIP Code (5 Digits) <span className="text-red-500">*</span></label>
            <input
              type="text"
              inputMode="numeric"
              value={values.zip}
              onChange={(e) => handleFieldChange("zip", e.target.value)}
              onBlur={() => handleBlur("zip")}
              placeholder="e.g. 10001"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm font-mono"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
            {String(values.zip || "").length < 5 && (
              <p className="text-[11px] text-zinc-400 mt-2 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                City &amp; state are detected automatically from your ZIP code.
              </p>
            )}
          </div>
        );
      }

      case "income_type": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">Primary Income Type <span className="text-red-500">*</span></label>
            <select
              value={values.income_type}
              onChange={(e) => handleFieldChange("income_type", e.target.value)}
              onBlur={() => handleBlur("income_type")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select income type...</option>
              <option value="EMPLOYMENT">Regular Employment</option>
              <option value="BENEFITS">Social Security / Benefits</option>
              <option value="SELF_EMPLOYED">Self-Employed / Freelance</option>
              <option value="MILITARY">Military Service</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "monthly_income": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">
              {TRANSLATIONS.incomeValue} <span className="text-red-500">*</span>
            </label>
            <select
              value={values.monthly_income}
              onChange={(e) => handleFieldChange("monthly_income", e.target.value)}
              onBlur={() => handleBlur("monthly_income")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>{TRANSLATIONS.incomeRangePlaceholder}</option>
              <option value="1200">Under $1,500 / month</option>
              <option value="2000">$1,500 - $2,500 / month</option>
              <option value="3250">$2,501 - $4,000 / month</option>
              <option value="5000">$4,001 - $6,000 / month</option>
              <option value="6000">Over $6,000 / month</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "address_length_months": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.addressDuration} <span className="text-red-500">*</span></label>
            <select
              value={values.address_length_months}
              onChange={(e) => handleFieldChange("address_length_months", e.target.value)}
              onBlur={() => handleBlur("address_length_months")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select duration...</option>
              <option value="72">Over 5 Years</option>
              <option value="36">2 to 5 Years</option>
              <option value="18">1 to 2 Years</option>
              <option value="6">Less Than A Year</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "own_home": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.ownHome} <span className="text-red-500">*</span></label>
            <select
              value={values.own_home}
              onChange={(e) => handleFieldChange("own_home", e.target.value)}
              onBlur={() => handleBlur("own_home")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select housing status...</option>
              <option value="0">Rent</option>
              <option value="1">Own</option>
              <option value="2">I Live With Parents Or Relatives</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "employer": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.employer} <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.employer}
              onChange={(e) => handleFieldChange("employer", e.target.value)}
              onBlur={() => handleBlur("employer")}
              placeholder="e.g. Acme Corporation"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "job_title": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.jobTitle} <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={values.job_title}
              onChange={(e) => handleFieldChange("job_title", e.target.value)}
              onBlur={() => handleBlur("job_title")}
              placeholder="e.g. Sales Associate"
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "employed_months": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.employedDuration} <span className="text-red-500">*</span></label>
            <select
              value={values.employed_months}
              onChange={(e) => handleFieldChange("employed_months", e.target.value)}
              onBlur={() => handleBlur("employed_months")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select duration...</option>
              <option value="60">5 Years Or More</option>
              <option value="42">3 &ndash; 4 Years</option>
              <option value="18">1 &ndash; 2 Years</option>
              <option value="6">3 &ndash; 12 Months</option>
              <option value="2">3 Months Or Less</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "pay_date1": {
        const limits = getPayDateLimits();
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.payDate} <span className="text-red-500">*</span></label>
            <input
              type="date"
              value={values.pay_date1}
              min={limits.min}
              max={limits.max}
              onChange={(e) => handleFieldChange("pay_date1", e.target.value)}
              onBlur={() => handleBlur("pay_date1")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            />
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "pay_frequency": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.payFrequency} <span className="text-red-500">*</span></label>
            <select
              value={values.pay_frequency}
              onChange={(e) => handleFieldChange("pay_frequency", e.target.value)}
              onBlur={() => handleBlur("pay_frequency")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select pay frequency...</option>
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Every 2 Weeks</option>
              <option value="TWICEMONTHLY">Twice A Month</option>
              <option value="MONTHLY">Monthly</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      case "direct_deposit": {
        return (
          <div className="w-full">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-700 mb-2">{TRANSLATIONS.directDeposit} <span className="text-red-500">*</span></label>
            <select
              value={values.direct_deposit}
              onChange={(e) => handleFieldChange("direct_deposit", e.target.value)}
              onBlur={() => handleBlur("direct_deposit")}
              required
              className="w-full px-4 py-3 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus-ring transition-all text-sm h-[48px]"
            >
              <option value="" disabled>Select paycheck method...</option>
              <option value="1">Electronic Deposit</option>
              <option value="0">Check</option>
            </select>
            {hasError && <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5" />{errorMsg}</p>}
          </div>
        );
      }

      default:
        return null;
    }
  };

  const stickyBarActive = showStickyBar && !embedded;

  return (
    <div
      data-embedded={embedded ? "" : undefined}
      className={embedded ? "w-full select-none" : "min-h-screen flex flex-col justify-between bg-zinc-50/20 select-none"}
    >
      <div className={embedded ? "w-full" : `flex-grow flex flex-col justify-center px-4 transition-all duration-300 ${stickyBarActive ? "pt-6 md:pt-12 pb-28 md:pb-36" : "py-6 md:py-12"}`}>
        {/* Brand Header (host page owns its own header when embedded) */}
        {!embedded && (
        <header className="w-full max-w-lg mx-auto mb-6 text-center">
          <div className="inline-flex items-center gap-2 mb-1">
            <svg className="w-7 h-7 text-zinc-800" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
            {/* The page's only h1. It shows the brand's own keyword when the ad link had one, else the brand name; never the ad's keyword. */}
            <h1 className="font-display font-bold text-lg md:text-xl tracking-[0.15em] text-zinc-900 uppercase">{RUNTIME_CONFIG.label || brandName}</h1>
          </div>
          <p className="font-display text-[9px] tracking-widest text-zinc-500 uppercase font-bold mb-1">CREDIT-MATCHING SERVICE · NOT A LENDER</p>
        </header>
        )}

        {/* Main card */}
        <motion.main
          animate={shake ? { x: [-6, 6, -5, 5, -3, 3, -1, 1, 0] } : {}}
          transition={{ type: "keyframes", duration: 0.4, ease: "easeInOut" }}
          onAnimationComplete={() => setShake(false)}
          className={`w-full mx-auto bg-white border border-zinc-200/80 rounded-2xl shadow-sm p-5 md:p-8 relative overflow-hidden flex flex-col justify-between ${embedded ? "max-w-2xl" : "max-w-lg flex-grow"}`}
        >
          {/* Progress indicator. On lite_v1 both children below are suppressed, so the wrapper
              must not keep contributing its bottom margin to an otherwise empty box. */}
          <div className={IS_LITE ? "" : "mb-6"}>
            {/* Hidden on lite_v1. It costs ~90px to show a step counter that is repeated verbatim
                two lines below, plus a time estimate from a table keyed by step number — on a
                3-screen form that table reads "approx 2 mins left" for a form that takes about
                thirty seconds, so it is not merely redundant, it is wrong. */}
            {!IS_LITE && (
            <div className="flex justify-between items-center text-[11px] font-bold text-zinc-400 uppercase tracking-wider mb-3 font-mono relative">
              <div className="flex items-center gap-1.5 h-4">
                <span>{TRANSLATIONS.progress}</span>
                <AnimatePresence>
                  {showSaved && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.9, x: -3 }}
                      animate={{ opacity: 1, scale: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.9, x: -3 }}
                      transition={{ duration: 0.2 }}
                      className="text-emerald-600 font-semibold text-[10px] lowercase flex items-center gap-1 normal-case tracking-normal"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      {TRANSLATIONS.changesSaved}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500 bg-zinc-100/80 px-2 py-0.5 rounded-md text-[10px] flex items-center gap-1 normal-case tracking-normal font-sans font-medium">
                  <Clock className="w-3 h-3 text-zinc-400 shrink-0" />
                  {getEstimatedTimeRemaining(currentStep)}
                </span>
                <span className="text-zinc-800 bg-zinc-100 px-2 py-0.5 rounded-md text-[10px]">
                  {TRANSLATIONS.stepOf.replace("{current}", String(currentStep)).replace("{total}", String(TOTAL_STEPS))}
                </span>
              </div>
            </div>
            )}

            {/* Field-level stepper card (hidden on the final, field-less review step).
                Also hidden on lite_v1: it costs ~107px to announce two fields the applicant can
                already see, which is the difference between the first question landing above the
                fold or below it on a 375x812 phone. */}
            {!IS_LITE && activeStepConfig.fields.length > 0 && (
              <div className="bg-zinc-50/50 border border-zinc-200/50 rounded-xl p-3 md:p-4 select-text">
                <div className="flex justify-between items-center text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-3 font-mono">
                  <span className="text-zinc-500 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-zinc-500" />
                    Section Progress
                  </span>
                  <span className="text-zinc-800 bg-zinc-200/60 px-1.5 py-0.5 rounded">
                    {visibleStepFields.filter(f => values[f] && !errors[f]).length} / {visibleStepFields.length} Fields
                  </span>
                </div>

                <div className="flex items-center justify-between relative w-full px-2">
                  {/* Connecting line backgrounds */}
                  <div className="absolute left-8 right-8 top-[14px] h-[2px] bg-zinc-100 -z-0" />
                  <div
                    className="absolute left-8 top-[14px] h-[2px] bg-zinc-900 transition-all duration-300 -z-0"
                    style={{
                      width: `${
                        visibleStepFields.length > 1
                          ? (visibleStepFields.filter(f => values[f] && !errors[f]).length / (visibleStepFields.length - 1)) * 100
                          : 0
                      }%`
                    }}
                  />

                  {visibleStepFields.map((field, idx) => {
                    const isCompleted = !!(values[field] && !errors[field]);
                    const isActive = field === currentActiveField;
                    const label = getFieldLabel(field);

                    return (
                      <div key={field} className="flex flex-col items-center relative z-10 flex-1">
                        {/* Circle icon */}
                        <motion.div
                          animate={isActive ? { scale: [1, 1.05, 1] } : {}}
                          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                          className={`w-7 h-7 rounded-full flex items-center justify-center border text-[11px] font-bold transition-all duration-300 ${
                            isCompleted
                              ? "bg-emerald-600 border-emerald-600 text-white shadow-sm shadow-emerald-100"
                              : isActive
                              ? "bg-zinc-900 border-zinc-900 text-white shadow-md shadow-zinc-200"
                              : "bg-white border-zinc-200 text-zinc-400"
                          }`}
                        >
                          {isCompleted ? (
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                          ) : (
                            idx + 1
                          )}
                        </motion.div>

                        {/* Label */}
                        <span
                          className={`text-[9px] md:text-[10px] font-bold uppercase tracking-wider mt-2 text-center transition-all duration-300 truncate max-w-[70px] md:max-w-[100px] ${
                            isActive
                              ? "text-zinc-900 font-extrabold"
                              : isCompleted
                              ? "text-emerald-700"
                              : "text-zinc-400 font-medium"
                          }`}
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Step Container Form */}
          <form onSubmit={handleContinue} className="flex-grow flex flex-col justify-between" noValidate>
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStep}
                id="active-step-container"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="flex-grow flex flex-col justify-center py-2"
              >
                {/* Contextual step heading */}
                <div className="mb-5 pr-12">
                  <span className="text-[10px] font-bold text-zinc-400 tracking-widest uppercase font-mono mb-1 block">
                    {TRANSLATIONS.stepOf.replace("{current}", String(currentStep)).replace("{total}", String(TOTAL_STEPS))}
                  </span>
                  <h2 className="font-display text-lg md:text-xl font-bold text-zinc-900 tracking-tight leading-tight">
                    {/* TRANSLATIONS.steps is a parallel array indexed by STEP NUMBER, not by the
                        step's identity, so on lite_v1 screen 2 (name/phone/email) it would render
                        the full form's screen 2 heading, "Intended Use of Proceeds". Lite therefore
                        reads its copy from its own StepConfig. The pet-brand overrides are keyed the
                        same way and have the same problem, which is why they are bypassed too. */}
                    {IS_LITE ? activeStepConfig.title : TRANSLATIONS.steps[currentStep - 1].title}
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                    {IS_LITE ? activeStepConfig.guidance : TRANSLATIONS.steps[currentStep - 1].guidance}
                  </p>
                </div>

                {/* Input rendering section */}
                {currentStep < TOTAL_STEPS ? (
                  <div className="space-y-4">
                    {visibleStepFields.map(field => {
                      // City + State appear together in one compact row once the ZIP is complete.
                      if (field === "state" && visibleStepFields.includes("city")) return null;
                      if (field === "city" && visibleStepFields.includes("state")) {
                        return (
                          <motion.div
                            key="city-state-row"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.25, ease: "easeOut" }}
                            className="w-full grid grid-cols-[1fr_110px] gap-3 items-start"
                          >
                            <div>{wrapWithValidationFeedback("city", renderField("city"))}</div>
                            <div>{wrapWithValidationFeedback("state", renderField("state"))}</div>
                          </motion.div>
                        );
                      }
                      return (
                        <div key={field} className="w-full">
                          {wrapWithValidationFeedback(field, renderField(field))}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* Final step: consent agreement only (no data fields) */
                  <div className="space-y-4">
                    {activeStepConfig.fields.map(field => (
                      <div key={field} className="w-full">
                        {wrapWithValidationFeedback(field, renderField(field))}
                      </div>
                    ))}
                    
                    {/* Security/Consent Agreement check */}
                    <div className="pt-4 border-t border-zinc-100 mt-2">
                      <label className="flex items-start gap-2.5 text-[11px] text-zinc-500 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={consentChecked}
                          onChange={(e) => setConsentChecked(e.target.checked)}
                          className="mt-0.5 accent-zinc-950 w-4 h-4 rounded cursor-pointer shrink-0"
                        />
                        <span className="select-text flex flex-col gap-1.5">
                          <span>{TRANSLATIONS.consentText(brandName)}</span>
                          <span>{TRANSLATIONS.tcpaConsentText(brandName)}</span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Submission error banner */}
            {errors.submit && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                <AlertCircle className="w-4 h-4 mt-px shrink-0" />
                <span>{errors.submit}</span>
              </div>
            )}

            {/* Bottom Controls */}
            <div className="flex items-center justify-between border-t border-zinc-100 pt-5 mt-6 shrink-0 h-16">
              <button
                type="button"
                onClick={handleBack}
                className={`px-4 py-2 rounded-lg border border-zinc-200 text-zinc-600 font-bold text-[10px] uppercase tracking-widest font-display transition-all duration-300 hover:bg-zinc-50 flex items-center gap-1.5 ${
                  currentStep === 1 ? "invisible pointer-events-none" : ""
                }`}
              >
                <ChevronLeft className="w-3.5 h-3.5" /> {TRANSLATIONS.back}
              </button>

              <div className="flex-grow" />

              {currentStep < TOTAL_STEPS ? (
                <button
                  type="submit"
                  className="px-6 py-2.5 rounded-lg font-bold text-[10px] uppercase tracking-widest font-display transition-all duration-300 flex items-center gap-1.5 shadow-sm bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer"
                >
                  {TRANSLATIONS.continue} <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSubmit()}
                  disabled={submitting || !consentChecked}
                  className={`px-8 py-3 rounded-lg font-bold text-[11px] uppercase tracking-widest font-display transition-all duration-300 flex items-center gap-2 shadow-md ${
                    submitting || !consentChecked
                      ? "bg-zinc-100 text-zinc-400 cursor-not-allowed border border-zinc-200"
                      : "bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer"
                  }`}
                >
                  {submitting ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {TRANSLATIONS.verifying}
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5 text-white animate-pulse" /> {TRANSLATIONS.submitApp}
                    </>
                  )}
                </button>
              )}
            </div>
          </form>
        </motion.main>

        {/* Trust Badges & Compliance Footer (host page owns its own footer when embedded) */}
        {!embedded && (
        <footer className="w-full max-w-lg mx-auto mt-6 text-center text-zinc-400 shrink-0">
          <div className="grid grid-cols-2 gap-2 mb-4 text-[9px] font-bold font-mono">
            <div className="flex items-center gap-1 justify-center py-1 px-2.5 bg-white border border-zinc-100 rounded-lg shadow-sm">
              <Lock className="w-3 h-3 text-emerald-600 shrink-0" />
              <span className="text-zinc-600 uppercase tracking-wider">256-Bit SSL Encrypted</span>
            </div>
            <div className="flex items-center gap-1 justify-center py-1 px-2.5 bg-white border border-zinc-100 rounded-lg shadow-sm">
              <Shield className="w-3 h-3 text-zinc-700 shrink-0" />
              <span className="text-zinc-600 uppercase tracking-wider">Not a Lender</span>
            </div>
          </div>

          <p className="text-[8px] leading-relaxed tracking-wider text-zinc-400 font-medium px-4 select-text text-justify">
            All rights reserved &copy; 2026 {brandName}. {brandName} is a marketing lead generator and credit-matching service, not a lender. We do not make credit decisions, issue loans, or charge you a fee for this service. Submitting your information does not guarantee an offer; any offer, rate, or term is set by the participating lender, subject to its credit criteria and applicable state law. Not all states are served. Your information is transmitted using TLS encryption.
          </p>
        </footer>
        )}
      </div>

      {/* Sticky Bottom Progress Bar & Floating Action Panel (disabled when embedded — the host page has its own) */}
      <AnimatePresence>
        {stickyBarActive && (
          <motion.div
            initial={{ opacity: 0, y: 80 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 80 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-zinc-200/80 shadow-[0_-10px_35px_rgba(0,0,0,0.06)]"
          >
            {/* Smooth-animating Embedded Micro Progress Bar */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-zinc-100 overflow-hidden">
              <motion.div 
                className="h-full bg-zinc-900 rounded-r-sm"
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>

            <div className="max-w-lg mx-auto w-full px-5 py-4 flex items-center justify-between gap-4">
              {/* Left Side: Real-time Segment Info & Percentage Indicator */}
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-bold text-zinc-400 tracking-wider uppercase font-mono leading-none mb-1">
                  {TRANSLATIONS.progress} ({progressPercent}%)
                </span>
                <span className="text-xs font-bold text-zinc-900 leading-none truncate">
                  Section {currentStep} of {TOTAL_STEPS}: {IS_LITE ? activeStepConfig.title : TRANSLATIONS.steps[currentStep - 1].title}
                </span>
              </div>

              {/* Right Side: Quick Action Floating Proceed Button */}
              <div className="shrink-0">
                {currentStep < TOTAL_STEPS ? (
                  <button
                    type="button"
                    onClick={() => handleContinue()}
                    className="px-5 py-2.5 rounded-lg font-bold text-[10px] uppercase tracking-widest font-display transition-all duration-300 flex items-center gap-1.5 shadow-sm bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer"
                  >
                    {TRANSLATIONS.continue} <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSubmit()}
                    disabled={submitting || !consentChecked}
                    className={`px-6 py-2.5 rounded-lg font-bold text-[10px] uppercase tracking-widest font-display transition-all duration-300 flex items-center gap-1.5 shadow-md ${
                      submitting || !consentChecked
                        ? "bg-zinc-100 text-zinc-400 cursor-not-allowed border border-zinc-200"
                        : "bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer"
                    }`}
                  >
                    {submitting ? (
                      <>
                        <svg className="animate-spin -ml-1 mr-1.5 h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {TRANSLATIONS.verifying}
                      </>
                    ) : (
                      <>
                        <Lock className="w-3.5 h-3.5 text-white animate-pulse" /> {TRANSLATIONS.submitApp}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
