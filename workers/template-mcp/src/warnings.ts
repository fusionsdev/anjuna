import { TemplateSubmitIssue } from "@anjuna/contracts";

export function uniqueIssues(issues: TemplateSubmitIssue[]): TemplateSubmitIssue[] {
  return [...new Map(issues.map((issue) => [JSON.stringify([issue.rule, issue.file, issue.message, issue.fix]), issue])).values()];
}

export function storedIssues(details: unknown, key: "warning_issues" | "import_warnings"): TemplateSubmitIssue[] {
  if (!details || typeof details !== "object") return [];
  const parsed = TemplateSubmitIssue.array().safeParse((details as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : [];
}

/** Latest certification per check only; a successful retry clears obsolete warnings. */
export async function readStoredWarnings(db: D1Database, versionId: string): Promise<{ warnings: TemplateSubmitIssue[]; importWarnings: TemplateSubmitIssue[] }> {
  const { results } = await db.prepare(
    "SELECT details_json FROM certifications WHERE id IN (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1 GROUP BY check_name)",
  ).bind(versionId).all<{ details_json: string | null }>();
  const details: unknown[] = results.map((row) => {
    try { return JSON.parse(row.details_json ?? "null") as unknown; } catch { return null; }
  });
  const importWarnings = uniqueIssues(details.flatMap((d) => storedIssues(d, "import_warnings")));
  return { warnings: uniqueIssues([...details.flatMap((d) => storedIssues(d, "warning_issues")), ...importWarnings]), importWarnings };
}
