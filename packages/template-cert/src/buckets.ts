/**
 * The canonical requested-amount buckets a landing CTA may offer (T11 brief). Every value in the
 * `requested_amount` select/radio group must be one of these. `/go` rejects anything else, so
 * offering a non-canonical value would silently bounce real leads.
 */
export const CANONICAL_AMOUNT_BUCKETS = [
  350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000,
] as const;

const BUCKET_SET = new Set<string>(CANONICAL_AMOUNT_BUCKETS.map((n) => String(n)));

export function isCanonicalAmount(value: string): boolean {
  return BUCKET_SET.has(value);
}