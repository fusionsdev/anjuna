export interface Rule {
  name: string;
  re: RegExp;
}
export interface Finding {
  file?: string;
  rule: string;
  match: string;
}
export const LEGACY_BRAND_DOMAINS: string[];
export const LEGACY_BRAND_NAMES: string[];
export const FORBIDDEN_WORDS: string[];
export const SECRET_PATTERNS: Rule[];
export const ALLOWED_DOMAINS: Set<string>;
export function unknownDomains(text: string, allowed?: Set<string>): string[];
export function buildRules(opts?: { extraDomains?: string[]; extraStrings?: string[] }): Rule[];
export function scanText(text: string, rules?: Rule[]): Finding[];
export function scanDir(dir: string, rules?: Rule[]): { files: number; findings: Finding[] };
