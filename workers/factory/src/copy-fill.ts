import { COPY_KEYWORD_MARKER, validateCopy, type BrandCopy, type CopyField, type CopyIssue } from "@anjuna/contracts";

export interface CopyDraft {
  brand_name: string;
  keyword_default: string;
  copy?: Partial<Record<CopyField, string | null>>;
}

export interface CopyAdapterInput {
  readonly brand_name: string;
  readonly keyword_default: string;
  readonly keyword_marker: typeof COPY_KEYWORD_MARKER;
  readonly fields: readonly CopyField[];
}

/** An adapter returns an object with plain-text h1/cta/sub values; its output is untrusted. */
export type CopyAdapter = (input: CopyAdapterInput) => Promise<unknown>;
export interface CopyFillDeps { generate?: CopyAdapter }
export interface CopyFillResult { copy: BrandCopy; issues: CopyIssue[] }

/**
 * Render-time helper for the install caller. No bindings, storage, request context or network.
 * No AI binding exists yet: absent adapter uses deterministic copy. A failed adapter does not
 * silently fall back. Reject the whole proposed fill on validation failure; retain employee bytes.
 */
export async function fillCopy(draft: CopyDraft, deps: CopyFillDeps = {}): Promise<CopyFillResult> {
  // The h1 marker becomes the brand name on the page, so the length rule counts it, as the wizard and the render do.
  const slotText = draft.brand_name.trim() || draft.keyword_default;
  const original: BrandCopy = {
    h1: draft.copy?.h1 ?? "",
    cta: draft.copy?.cta ?? "",
    sub: draft.copy?.sub ?? "",
  };
  const fields = (Object.keys(original) as CopyField[]).filter((field) => !original[field].trim());
  if (!fields.length) return { copy: original, issues: validateCopy(original, draft.keyword_default, slotText) };

  let generated: unknown;
  try {
    generated = deps.generate ? await deps.generate({
      brand_name: draft.brand_name, keyword_default: draft.keyword_default,
      keyword_marker: COPY_KEYWORD_MARKER, fields: [...fields],
    }) : {
      h1: `${COPY_KEYWORD_MARKER} | Check Your Options`,
      cta: "Check Your Options",
      sub: `Explore ${draft.keyword_default} with ${draft.brand_name}. Rates and terms vary by lender.`,
    };
  } catch {
    return { copy: original, issues: [
      { field: "adapter", code: "adapter_failed", message: "Copy generation failed. Retry or fill the empty fields yourself." },
      ...validateCopy(original, draft.keyword_default, slotText),
    ] };
  }

  const candidate = { ...original };
  const values = generated && typeof generated === "object" && !Array.isArray(generated)
    ? generated as Record<string, unknown> : {};
  for (const field of fields) {
    if (Object.hasOwn(values, field) && typeof values[field] === "string") candidate[field] = values[field];
  }
  const issues = validateCopy(candidate, draft.keyword_default, slotText);
  return { copy: issues.length ? original : candidate, issues };
}
