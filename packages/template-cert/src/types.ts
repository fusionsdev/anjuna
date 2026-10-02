/**
 * Shared result types for the template certification linter (T11).
 *
 * A check is a pure function over an in-memory `Source` (the static `dist/`, or the contents of
 * a ZIP unpacked into memory). Each check returns a list of `Issue`s. A check with no error
 * issues is "pass"; warnings alone make it "warn".
 */

export type Severity = "error" | "warning";

/** Stable machine id of the eight checks required by the brief. */
export type RuleId =
  | "structure"
  | "keyword"
  | "cta"
  | "pii"
  | "wording"
  | "external"
  | "brand"
  | "links";

export interface Issue {
  /** One of the eight stable rule ids, so the factory can key on it. */
  rule: RuleId;
  severity: Severity;
  /** Where the problem lives: a file path relative to dist/ and/or an element hint. */
  location: string;
  /** Plain-language English description + the fix. */
  en: string;
  /** Plain-language Thai description + the fix. */
  th: string;
}

export interface CheckOutcome {
  rule: RuleId;
  name: string;
  nameTh: string;
  status: "pass" | "warn" | "fail";
  issues: Issue[];
}

export interface CheckResult {
  label: string;
  /** Path (or zip name) the input was read from. */
  source: string;
  /** False when any issue has severity "error". Warnings alone keep this true. */
  ok: boolean;
  errors: number;
  warnings: number;
  checks: CheckOutcome[];
}

/** A fatal load problem (unreadable input / rejected archive), distinct from lint findings. */
export interface LoadFailure {
  message: string;
  messageTh: string;
}

export interface CheckerOptions {
  /** Domains the template must not mention (other brands). Lowercased hostnames preferred. */
  denyDomains?: readonly string[];
  /** Human label for the report header (defaults to the input path). */
  label?: string;
}