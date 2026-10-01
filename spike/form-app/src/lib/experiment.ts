// Phase D variant assignment.
//
// CURRENT MODE: 100% lite_v1 (LITE_SHARE = 1). This is a full rollout, not a split test — the
// owner's call on 2026-09-09, because at ~40-60 paid clicks/day a 50/50 split needs two weeks to
// read anything while the portfolio is losing money daily. The comparison is therefore
// week-over-week PER BRAND against the full_v1 baseline already in D1 and in the LeadsGate
// report, not a concurrent control group.
//
// What that costs, stated plainly so nobody reads more into the result than it can carry:
// a before/after has no control for anything else that moved in the same week — PawPayFund was
// stopped (it was 73% of spend), conversion actions are being rebuilt, and the LeadsGate
// postbacks were only just restored. A large effect will still be obvious; a small one will not
// be attributable. `?variant=full` remains the escape hatch for spot-checking the incumbent.
//
// SCOPE AND HONESTY: assignment is CLIENT-SIDE and **not immutable**. localStorage is clearable
// and forgeable, and the arm follows the browser, not the paid click. At 100% that no longer
// biases anything (everyone gets the same arm), but it still matters if the share is ever moved
// off 1. The immutable design is specified in docs/phase-d-server-assignment.md: assign in
// functions/_middleware.ts at the moment the server mints the 256-bit fo_click token, derive the
// bucket from that token, and store it on click_sessions. Build that before running a real split.

export const VARIANTS = {
  FULL: "aurum-14-step", // the incumbent — this exact string is already in historical rows,
  //                        so keeping it means full_v1 data stays comparable across the release
  LITE: "lite_v1",
} as const;

export type Variant = (typeof VARIANTS)[keyof typeof VARIANTS];

const STORAGE_KEY = "aurum_variant";

/**
 * Share of visitors on lite_v1. 1 = full rollout, 0.5 = even split, 0 = incumbent only.
 * At 1 the stored assignment is deliberately ignored (see resolveVariant) so browsers that were
 * pinned to the incumbent during QA do not silently sit out the rollout.
 */
const LITE_SHARE = 1;

type Source = "rollout" | "stored" | "assigned" | "forced" | "fallback";
let _resolved: Variant | null = null;
let _source: Source = "fallback";

function isVariant(v: unknown): v is Variant {
  return v === VARIANTS.FULL || v === VARIANTS.LITE;
}

/**
 * The arm for this visitor. Safe to call repeatedly — the answer is memoised for the page's
 * lifetime so a mid-session storage failure can never flip the arm underneath a half-finished
 * application.
 */
export function resolveVariant(): Variant {
  if (_resolved) return _resolved;

  // Everything below is best-effort. Any throw (private mode, disabled storage, blocked
  // cross-origin access) must land on the incumbent rather than break the funnel — and must not
  // silently bias the split, which is why the fallback is recorded rather than hidden.
  try {
    if (typeof window !== "undefined") {
      // QA override. Deliberately NOT persisted: a forced session must not poison the real
      // assignment stored for that browser. This is also how the incumbent is spot-checked
      // during a 100% rollout.
      const forced = new URLSearchParams(window.location.search).get("variant");
      if (forced === "lite" || forced === VARIANTS.LITE) {
        _resolved = VARIANTS.LITE;
        _source = "forced";
        return _resolved;
      }
      if (forced === "full" || forced === VARIANTS.FULL) {
        _resolved = VARIANTS.FULL;
        _source = "forced";
        return _resolved;
      }

      // Full rollout: everyone gets lite, and a stale stored value does not get a veto. Still
      // written back so that dialling the share down later finds a consistent assignment.
      if (LITE_SHARE >= 1) {
        try { window.localStorage.setItem(STORAGE_KEY, VARIANTS.LITE); } catch { /* non-fatal */ }
        _resolved = VARIANTS.LITE;
        _source = "rollout";
        return _resolved;
      }

      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isVariant(stored)) {
        _resolved = stored;
        _source = "stored";
        return _resolved;
      }

      const assigned = Math.random() < LITE_SHARE ? VARIANTS.LITE : VARIANTS.FULL;
      window.localStorage.setItem(STORAGE_KEY, assigned);
      _resolved = assigned;
      _source = "assigned";
      return _resolved;
    }
  } catch {
    /* fall through to the incumbent */
  }

  _resolved = VARIANTS.FULL;
  _source = "fallback";
  return _resolved;
}

/**
 * How this visitor's arm was decided. "forced" marks a QA session that must be excluded from any
 * comparison; "fallback" marks a browser where storage failed, so that session ran the incumbent
 * even during a full rollout and its denominator is not clean.
 */
export function getAssignmentSource(): Source {
  if (!_resolved) resolveVariant();
  return _source;
}

export function isLite(): boolean {
  return resolveVariant() === VARIANTS.LITE;
}

// Test seam only. Never called from application code.
export function __resetForTests(): void {
  _resolved = null;
  _source = "fallback";
}
