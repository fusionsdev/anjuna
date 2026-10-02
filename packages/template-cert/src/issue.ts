import type { Issue, RuleId, Severity } from "./types.js";

export function issue(rule: RuleId, severity: Severity, location: string, en: string, th: string): Issue {
  return { rule, severity, location, en, th };
}

export function err(rule: RuleId, location: string, en: string, th: string): Issue {
  return issue(rule, "error", location, en, th);
}

export function warn(rule: RuleId, location: string, en: string, th: string): Issue {
  return issue(rule, "warning", location, en, th);
}