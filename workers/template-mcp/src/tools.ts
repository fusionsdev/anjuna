import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InputError, type FileMap } from "./archive";
import { checkTemplate, type CheckReport, type Issue, type OtherBrand } from "./checker";
import { contractForBuilders } from "./contract";
import { certifyTemplateVersion, importTemplateVersion, sealTemplateVersion } from "./certifier";
import type { Env } from "./env";
import { SIGNAL_FIXES, compareFingerprints, computeFingerprint, type Fingerprint, type SignalScores } from "./fingerprint";
import { measurePayload, probePublishedUrl } from "./probe";
import { loadFromGithub, loadFromUrl, loadZipBase64, type Loaded } from "./input";

const SOURCE_SHAPE = {
  zip_base64: z.string().min(1).optional().describe("Base64 of a .zip of the static build (the CONTENTS of dist/, index.html at the archive root). Max 30 MB / 2000 files."),
  url: z.string().url().optional().describe("https URL of a .zip of the static build, or of the deployed static site (HTML is fetched, JavaScript is never executed)."),
};
const BRAND_SHAPE = {
  brand_id: z.string().min(1).max(64).optional().describe("The brand this template is for, if known. Its own earlier templates are excluded from other-brand checks."),
};

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

function failure(error: unknown) {
  if (error instanceof InputError) {
    return text({ pass: false, error: error.code, message: error.message, fix: "Fix the input and call the tool again." }, true);
  }
  console.error("template-mcp tool error", error instanceof Error ? error.message : String(error));
  return text({ pass: false, error: "internal_error", message: "The checker failed unexpectedly. Try again; if it persists, report it to the Anjuna owner." }, true);
}

function loadSource(args: { zip_base64?: string; url?: string }): Promise<Loaded> | Loaded {
  const given = [args.zip_base64, args.url].filter((v) => v !== undefined).length;
  if (given !== 1) throw new InputError("bad_input", "Provide exactly one of zip_base64 or url.");
  return args.zip_base64 !== undefined ? loadZipBase64(args.zip_base64) : loadFromUrl(args.url!);
}

export async function otherBrands(env: Pick<Env, "FACTORY">, brandId?: string): Promise<OtherBrand[]> {
  const { results } = await env.FACTORY.prepare("SELECT name, domain FROM brands WHERE brand_id != ?1 AND status != 'retired'")
    .bind(brandId ?? "")
    .all<OtherBrand>();
  return results;
}

export interface SimilarityMatch {
  brands: { brand_id: string; name: string; domain: string }[];
  template: string;
  version: number;
  template_version_id: string;
  score: number;
  signals: SignalScores;
  shared_images: number;
  similar: boolean;
}

export interface SimilarityReport {
  pass: boolean;
  summary: string;
  threshold: number;
  compared: number;
  closest: SimilarityMatch[];
  fixes: string[];
}

export function similarityThreshold(env: Pick<Env, "SIMILARITY_THRESHOLD">): number {
  const n = Number.parseFloat(env.SIMILARITY_THRESHOLD ?? "");
  return Number.isFinite(n) ? Math.min(0.95, Math.max(0.1, n)) : 0.5;
}

/** Per-signal hard limits: a near copy of one aspect fails even when the overall score is low. */
const HARD = { text: 0.5, imagesShared: 3 } as const;

export async function similarityCheck(env: Env, files: FileMap, brandId?: string): Promise<SimilarityReport> {
  const threshold = similarityThreshold(env);
  const candidate = await computeFingerprint(files);
  const { results } = await env.FACTORY.prepare(
    `SELECT f.template_version_id, f.fingerprint_json, t.name AS template, tv.version,
            b.brand_id, b.name AS brand_name, b.domain
       FROM template_fingerprints f
       JOIN template_versions tv ON tv.template_version_id = f.template_version_id
       JOIN templates t ON t.template_id = tv.template_id
       LEFT JOIN brand_revisions br ON br.template_version_id = tv.template_version_id
       LEFT JOIN brands b ON b.brand_id = br.brand_id
      WHERE tv.status = 'sealed'`,
  ).all<{ template_version_id: string; fingerprint_json: string; template: string; version: number; brand_id: string | null; brand_name: string | null; domain: string | null }>();

  const byVersion = new Map<string, { fingerprint: string; template: string; version: number; brands: SimilarityMatch["brands"] }>();
  for (const row of results) {
    const entry = byVersion.get(row.template_version_id) ?? { fingerprint: row.fingerprint_json, template: row.template, version: row.version, brands: [] };
    if (row.brand_id) entry.brands.push({ brand_id: row.brand_id, name: row.brand_name ?? "", domain: row.domain ?? "" });
    byVersion.set(row.template_version_id, entry);
  }
  const matches: SimilarityMatch[] = [];
  for (const [id, entry] of byVersion) {
    if (brandId && entry.brands.some((b) => b.brand_id === brandId)) continue; // the brand's own earlier template
    let other: Fingerprint;
    try {
      other = JSON.parse(entry.fingerprint) as Fingerprint;
    } catch {
      continue;
    }
    const { score, signals, sharedImages } = compareFingerprints(candidate, other);
    matches.push({
      brands: entry.brands,
      template: entry.template,
      version: entry.version,
      template_version_id: id,
      score: round(score),
      signals: roundSignals(signals),
      shared_images: sharedImages,
      similar: score >= threshold || signals.text >= HARD.text || sharedImages >= HARD.imagesShared,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  const similar = matches.filter((m) => m.similar);
  const fixes = new Set<string>();
  for (const m of similar) {
    for (const key of Object.keys(SIGNAL_FIXES) as (keyof SignalScores)[]) {
      const v = m.signals[key];
      if (v !== null && v >= (key === "images" ? 0.3 : 0.4)) fixes.add(`${label(m)}: ${SIGNAL_FIXES[key]} (${key} similarity ${v})`);
    }
    if (m.score >= threshold && fixes.size === 0) fixes.add(`${label(m)}: redesign the layout, copy and imagery; overall similarity ${m.score} is above ${threshold}.`);
  }
  const pass = similar.length === 0;
  return {
    pass,
    summary: matches.length === 0
      ? "PASS: no sealed templates to compare against yet."
      : pass
        ? `PASS: compared with ${matches.length} sealed template(s); closest is ${matches[0]!.score} (limit ${threshold}).`
        : `FAIL: too similar to ${similar.map(label).join(", ")}. Make the design clearly different and re-run similarity_check.`,
    threshold,
    compared: matches.length,
    closest: matches.slice(0, 5),
    fixes: [...fixes],
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const roundSignals = (s: SignalScores): SignalScores => ({ text: round(s.text), dom: round(s.dom), classes: round(s.classes), sections: round(s.sections), images: s.images === null ? null : round(s.images) });
const label = (m: SimilarityMatch) => (m.brands.length ? m.brands.map((b) => b.name || b.brand_id).join("/") : `template "${m.template}" v${m.version}`);

export async function runCheck(env: Env, loaded: Loaded, brandId?: string): Promise<CheckReport & { source: string; notes?: string[] }> {
  const report = checkTemplate(loaded.files, { otherBrands: await otherBrands(env, brandId) });
  return { ...report, source: loaded.source, ...(loaded.notes.length ? { notes: loaded.notes } : {}) };
}

export function registerTools(server: McpServer, env: Env): void {
  server.registerTool(
    "get_template_contract",
    {
      title: "Get the template contract",
      description: "Returns the Anjuna landing template contract: required pages, keyword slot, CTA form, banned content and the build-check-fix workflow. Read it BEFORE designing the template.",
      inputSchema: {},
    },
    async () => text(contractForBuilders()),
  );

  server.registerTool(
    "check_template",
    {
      title: "Check a template against the contract",
      description: "Checks a static build (zip as base64, or a URL) against the Anjuna template contract and returns pass/fail with an actionable fix for every issue. Static analysis only: template JavaScript is never executed. Fix all errors and call again until pass is true.",
      inputSchema: { ...SOURCE_SHAPE, ...BRAND_SHAPE },
    },
    async (args) => {
      try {
        return text(await runCheck(env, await loadSource(args), args.brand_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_github_repo",
    {
      title: "Check a template in a GitHub repo",
      description:
        "Fetches a GitHub repo at a ref, finds the BUILT static output (dist/, out/ or build/, or a repo/branch whose root is the built site) and runs check_template on it. It does not run builds: commit the built dist/ (git add -f dist) to the ref, or pass `path` to the folder that holds the build.",
      inputSchema: {
        owner: z.string().min(1).max(39),
        repo: z.string().min(1).max(100),
        ref: z.string().min(1).max(200).optional().describe("Branch, tag or commit SHA. Defaults to the default branch."),
        path: z.string().min(1).max(200).optional().describe("Folder inside the repo that holds the built site (default: dist, out, build or the repo root)."),
        ...BRAND_SHAPE,
      },
    },
    async (args) => {
      try {
        const loaded = await loadFromGithub(args, env);
        if (loaded.needsBuild) {
          const nb = loaded.needsBuild;
          const issue: Issue = {
            rule: "static-output",
            severity: "error",
            message: `No built output found in ${args.owner}/${args.repo}. It looks like ${nb.framework === "unknown" ? "a source project" : `an ${nb.framework} project`}, and this checker never runs builds or template code.`,
            fix: `Run \`${nb.command}\`, commit the ${nb.output_dir}/ folder (git add -f ${nb.output_dir} if it is gitignored) on the ref you want checked, then call check_github_repo again. Or zip the contents of ${nb.output_dir}/ and use check_template.`,
          };
          return text({ pass: false, summary: "FAIL: no built output to check.", errors: 1, warnings: 0, issues: [issue], source: loaded.source, stats: { files: 0, html_pages: 0, bytes: 0 } });
        }
        return text(await runCheck(env, loaded, args.brand_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "similarity_check",
    {
      title: "Check the design is unique across brands",
      description: "Compares a template with all sealed templates of other brands (DOM structure, CSS classes, section order, images, visible text). Fails when it resembles another brand's site, and says which brand and what to change. Every brand needs its own design; identical sites risk ad-account bans.",
      inputSchema: { ...SOURCE_SHAPE, ...BRAND_SHAPE },
    },
    async (args) => {
      try {
        const loaded = await loadSource(args);
        return text({ ...(await similarityCheck(env, loaded.files, args.brand_id)), source: loaded.source });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── Certification pipeline (T11) ──────────────────────────────────────────

  server.registerTool(
    "import_template_version",
    {
      title: "Import a template version",
      description:
        "Upload a static dist/ ZIP to R2 and register it as a new template_version row in D1 (status = 'draft'). " +
        "Returns the template_version_id to pass to certify_template_version. " +
        "The ZIP must contain index.html at the root (the contents of dist/, not the dist/ folder itself).",
      inputSchema: {
        zip_base64: z.string().min(1).describe("Base64 of the dist/ ZIP archive. Max 30 MB."),
        template_id: z.string().min(1).max(64).describe("Unique identifier for the template (e.g. 'harbor-v1'). Created if it does not exist."),
        template_name: z.string().min(1).max(128).describe("Human-readable name shown in the control panel."),
        framework: z.enum(["astro", "next_export", "react_spa"]).describe("The build framework used."),
        created_by: z.string().min(1).max(64).describe("Auth user id of the person uploading."),
      },
    },
    async (args) => {
      try {
        if (!env.ARTIFACTS) return text({ pass: false, error: "no_r2", message: "ARTIFACTS R2 bucket is not bound on this deployment." }, true);
        const zipBytes = Uint8Array.from(atob(args.zip_base64), (c) => c.charCodeAt(0));
        const result = await importTemplateVersion(env.FACTORY, env.ARTIFACTS, zipBytes, {
          template_id: args.template_id,
          template_name: args.template_name,
          framework: args.framework,
          created_by: args.created_by,
        });
        return text({ pass: true, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "certify_template_version",
    {
      title: "Run certification checks on a template version",
      description:
        "Run lint, identity scan, and required desktop/mobile Browser Rendering screenshots on a template_version. " +
        "Writes certification rows to D1 and sets status to 'certified' or 'rejected'. " +
        "Pass all checks before calling seal_template_version. " +
        "Returns a repair_messages array with actionable fixes for every failing check.",
      inputSchema: {
        template_version_id: z.string().min(1).describe("The template_version_id returned by import_template_version."),
        brand_id: z.string().min(1).max(64).optional().describe("When set, the brand's own earlier sealed templates are excluded from the similarity check."),
      },
    },
    async (args) => {
      try {
        if (!env.ARTIFACTS) return text({ pass: false, error: "no_r2", message: "ARTIFACTS R2 bucket is not bound on this deployment." }, true);
        const result = await certifyTemplateVersion(env, args.template_version_id, args.brand_id);
        return text({ pass: result.status === "certified", ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "seal_template_version",
    {
      title: "Seal a certified template version (owner only)",
      description:
        "Mark a certified template version as sealed and immutable. " +
        "Sealed versions can be used in brand installs; the SHA-256 of the ZIP is locked forever. " +
        "Requires the OWNER_SECRET configured on this deployment. Owner-only action.",
      inputSchema: {
        template_version_id: z.string().min(1).describe("The template_version_id to seal (must have status = 'certified')."),
        owner_secret: z.string().min(1).describe("The owner secret configured in OWNER_SECRET."),
        sealed_by: z.string().min(1).max(64).describe("Auth user id of the owner performing the seal."),
      },
    },
    async (args) => {
      try {
        const result = await sealTemplateVersion(env.FACTORY, env.ARTIFACTS, args.owner_secret, env.OWNER_SECRET, args.template_version_id, args.sealed_by);
        return text({ pass: true, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── Diagnostics kept from the bolt.new spike ─────────────────────────────

  server.registerTool(
    "measure_payload",
    {
      title: "Measure one tool argument",
      description: "Diagnostic: send text of a chosen size (for example 10,000, 20,000 or 50,000 characters) and get back how many characters arrived. It sizes upload_files batches.",
      inputSchema: { text: z.string().describe("Any text; only its length is measured.") },
    },
    async (args) => {
      const measured = measurePayload(args.text);
      console.log(JSON.stringify({ event: "measure_payload", ...measured }));
      return text(measured);
    },
  );

  server.registerTool(
    "probe_url",
    {
      title: "Check a published site URL",
      description: "Diagnostic: requests the URL (at most 3 redirects) and reports every status, the final URL, the first 500 visible characters, and whether the page has visible text or is an empty JavaScript shell. ok must be true before submit_template_url.",
      inputSchema: { url: z.string().url().describe("https URL of the published site, as bolt.new shows it after publishing.") },
    },
    async (args) => {
      try {
        const probe = await probePublishedUrl(args.url);
        console.log(JSON.stringify({ event: "probe_url", final_url: probe.final_url, status: probe.status, hops: probe.hops.length, ok: probe.ok }));
        return text(probe);
      } catch (error) {
        return failure(error);
      }
    },
  );
}
