/** Shared by the mailing cron and the read-only mailing status route. */
export function listMapFrom(raw: string | undefined): Record<string, number> | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length === 0 || entries.some(([, id]) => !Number.isInteger(id) || (id as number) <= 0)) return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

/**
 * The tenant fallback map, for a brand without its own list (brand_runtime.listmonk_list_id). Unset means no fallback ({}).
 * A value that is set but invalid is null, and the cron skips rather than guess.
 */
export function fallbackListMap(raw: string | undefined): Record<string, number> | null {
  return raw === undefined || raw.trim() === "" ? {} : listMapFrom(raw);
}

/** True only when the cron would actually sync. Credentials missing, or a list map that is set but invalid, skips the run. */
export function listmonkConfigured(env: {
  LISTMONK_URL?: string;
  LISTMONK_USER?: string;
  LISTMONK_TOKEN?: string;
  LISTMONK_LIST_MAP?: string;
}): boolean {
  return Boolean(env.LISTMONK_URL && env.LISTMONK_USER && env.LISTMONK_TOKEN && fallbackListMap(env.LISTMONK_LIST_MAP));
}
