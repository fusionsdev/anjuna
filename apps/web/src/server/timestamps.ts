import { z } from "zod";

const Instant = z.iso.datetime();

// The ISO forms that SQLite julianday() and Date.parse() both read. Any other text must be rejected here,
// because a string only one of them reads sorts in SQL by one rule and merges in JS by another.
const IsoText = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * D1 holds both `...Z` and `...+07:00` strings, and the contract timestamp accepts only the first form.
 * Returns null for text that is not such a date, so one bad stored row can be skipped instead of failing a response.
 */
export const asTimestamp = (value: string): string | null => {
  if (Instant.safeParse(value).success) return value;
  if (!IsoText.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Years beyond 9999 come back as "+010000-...", which the contract rejects.
  return Instant.safeParse(iso).success ? iso : null;
};
