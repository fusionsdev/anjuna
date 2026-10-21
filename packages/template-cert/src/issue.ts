import { ruleDisposition } from "./policy.js";
import type { Issue, RuleId } from "./types.js";

export function issue(rule: RuleId, location: string, en: string, th: string, checkId: string = rule): Issue {
  return { rule, checkId, severity: ruleDisposition(checkId) === "block" ? "error" : "warning", location, en, th };
}

export function err(rule: RuleId, location: string, en: string, th: string, checkId: string = rule): Issue {
  return issue(rule, location, en, th, checkId);
}

export function warn(rule: RuleId, location: string, en: string, th: string, checkId: string = rule): Issue {
  return issue(rule, location, en, th, checkId);
}
