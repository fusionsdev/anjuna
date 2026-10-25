/**
 * In-memory stand-ins for CORE_LIFECYCLE, FACTORY_WORKER and TEMPLATE_MCP, for local preview (spec D8.4).
 * With MOCK_CORE=1 each binding that is missing gets one; a binding that is present is never replaced.
 * Every answer is parsed with the schema the caller parses it with, so a contract change breaks the
 * mock loudly. No mock makes a network call and none simulates progress.
 */
import {
  RuntimeListRequest,
  RuntimeListResponse,
  TemplateApproveResponse,
  TemplateSubmitResult,
  VerifySoldLeadRequest,
  VerifySoldLeadResponse,
  templateSlug,
} from "@anjuna/contracts";
import { ZoneCheckRequest, ZoneCheckResponse } from "../shared/wizard.js";
import type { Env } from "./env.js";
import { mockCoreFetch } from "./mock-core.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = (path: string): Response => json(404, { error: "not_found", resource: "route", path });
const invalid = (): Response => json(400, { error: "invalid" });

type Handler = (request: Request, path: string) => Promise<Response>;

/** A Fetcher whose POST routes are answered by `routes`; any other path is a 404 JSON. */
function stub(routes: Record<string, Handler>): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      const route = request.method === "POST" ? routes[path] : undefined;
      return route ? route(request, path) : notFound(path);
    },
  } as unknown as Fetcher;
}

const body = (request: Request): Promise<unknown> => request.json().catch(() => null);

/** Deterministic id: the same input always yields the same instance id, like the real workflow ids. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function coreLifecycle(env: Env): Fetcher {
  return stub({
    // The mock core brands, each applied at the factory's current revision so the panel shows them ready.
    "/lifecycle/runtime-list": async (request) => {
      const parsed = RuntimeListRequest.safeParse(await body(request));
      if (!parsed.success) return invalid();
      const core = await mockCoreFetch(new Request("https://core.internal/admin/brands", { headers: request.headers }));
      if (!core.ok) return json(core.status, await core.json().catch(() => ({ error: "mock_core_failed" })));
      const { brands } = await core.json() as { brands: { brand_id: string; hostnames: string[]; status: string; form_version: string | null }[] };
      const applied = new Map<string, string | null>();
      try {
        const { results } = await env.FACTORY.prepare("SELECT brand_id, current_revision_id FROM brands").all<{ brand_id: string; current_revision_id: string | null }>();
        for (const row of results) applied.set(row.brand_id, row.current_revision_id);
      } catch { /* no factory rows: every brand stays unapplied */ }
      return json(200, RuntimeListResponse.parse({
        brands: brands.map((b) => ({
          brand_id: b.brand_id, account: parsed.data.account, hostnames: b.hostnames,
          applied_revision_id: applied.get(b.brand_id) ?? null, paused: b.status === "paused", bundle_form_version: b.form_version,
        })),
      }));
    },
    "/lifecycle/test-sold": async (request) => {
      const parsed = VerifySoldLeadRequest.safeParse(await body(request));
      if (!parsed.success) return invalid();
      return json(200, VerifySoldLeadResponse.parse({ verified: true, event_id: `mock-event-${parsed.data.lead_id}`, event_at: new Date().toISOString() }));
    },
  });
}

function factoryWorker(): Fetcher {
  // install and rollback: lifecycle.ts dispatch() wraps the body as `workflow`; the callers read nothing else.
  const dispatched: Handler = async (request) => {
    const input = await body(request) as { install_id?: unknown } | null;
    return typeof input?.install_id === "string" ? json(200, { ok: true, install_id: input.install_id }) : invalid();
  };
  return stub({
    "/install": dispatched,
    "/rollback": dispatched,
    "/recover": async (request) => {
      const input = await body(request) as { brand_id?: unknown } | null;
      if (typeof input?.brand_id !== "string") return invalid();
      return json(201, { install_id: `mock-recover-${await sha256Hex(input.brand_id).then((h) => h.slice(0, 12))}`, brand_id: input.brand_id, status: "queued" });
    },
    "/upgrade-all": async (request) => {
      const input = await body(request) as Record<string, unknown> | null;
      if (!input || typeof input.canary_brand_id !== "string") return invalid();
      const key = [input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, input.canary_brand_id].join("|");
      return json(200, { ok: true, instance_id: `mock-upgrade-${(await sha256Hex(key)).slice(0, 12)}` });
    },
    "/seal-template": async (request) => {
      const input = await body(request) as { template_version_id?: unknown; sealed_by?: unknown } | null;
      if (typeof input?.template_version_id !== "string" || typeof input.sealed_by !== "string") return invalid();
      return json(200, TemplateApproveResponse.parse({
        ok: true, template_version_id: input.template_version_id, sealed_by: input.sealed_by, sealed_at: new Date().toISOString(), already_sealed: false,
      }));
    },
    "/zone-check": async (request) => {
      const parsed = ZoneCheckRequest.safeParse(await body(request));
      if (!parsed.success) return invalid();
      return json(200, ZoneCheckResponse.parse({
        zone_active: true, zone_name: parsed.data.domain, nameservers: ["mock-ns1.cloudflare.test", "mock-ns2.cloudflare.test"], conflicting_records: [],
      }));
    },
  });
}

async function submitted(templateId: string, templateName: string): Promise<Response> {
  return json(200, TemplateSubmitResult.parse({
    status: "awaiting_approval",
    template_version_id: `${templateId}-v1`,
    version: 1,
    sha256: await sha256Hex(templateId),
    dashboard_url: null,
    issues: [],
    warnings: [],
    text_defaults: null,
    similarity: null,
    next_step: `Mock import of "${templateName}" for local preview. Approve it on the Templates screen.`,
  }));
}

function templateMcp(): Fetcher {
  return stub({
    "/submit-zip": async (request) => {
      const form = await request.formData().catch(() => null);
      const id = form?.get("template_id");
      const name = form?.get("template_name");
      return typeof id === "string" && typeof name === "string" ? submitted(id, name) : invalid();
    },
    "/submit-url": async (request) => {
      const input = await body(request) as { template_id?: unknown; template_name?: unknown } | null;
      const name = typeof input?.template_name === "string" ? input.template_name : null;
      if (name === null) return invalid();
      return submitted(typeof input?.template_id === "string" ? input.template_id : templateSlug(name), name);
    },
  });
}

/** With MOCK_CORE=1, fills each missing lifecycle, factory and template binding. Otherwise returns `env` itself. */
export function withMockBindings(env: Env): Env {
  if (env.MOCK_CORE !== "1") return env;
  if (env.CORE_LIFECYCLE && env.FACTORY_WORKER && env.TEMPLATE_MCP) return env;
  return {
    ...env,
    CORE_LIFECYCLE: env.CORE_LIFECYCLE ?? coreLifecycle(env),
    FACTORY_WORKER: env.FACTORY_WORKER ?? factoryWorker(),
    TEMPLATE_MCP: env.TEMPLATE_MCP ?? templateMcp(),
  };
}
