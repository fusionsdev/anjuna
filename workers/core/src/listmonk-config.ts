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

/** True only when the cron would actually sync. A missing or invalid list map skips the run. */
export function listmonkConfigured(env: {
  LISTMONK_URL?: string;
  LISTMONK_USER?: string;
  LISTMONK_TOKEN?: string;
  LISTMONK_LIST_MAP?: string;
}): boolean {
  return Boolean(env.LISTMONK_URL && env.LISTMONK_USER && env.LISTMONK_TOKEN && listMapFrom(env.LISTMONK_LIST_MAP));
}
