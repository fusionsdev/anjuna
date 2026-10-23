import { z } from "zod";

const Instant = z.iso.datetime();

/**
 * D1 holds both `...Z` and `...+07:00` strings, and the contract timestamp accepts only the first form.
 * Returns null for text that is not a date at all, so one bad stored row can be skipped instead of failing a response.
 */
export const asTimestamp = (value: string): string | null => {
  if (Instant.safeParse(value).success) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
