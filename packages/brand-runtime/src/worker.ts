import {
  ANALYTICS_LIMITS, BRAND_ASSET_PATHS, CLICK_PARAM_KEYS, CLICK_TRIGGER_KEYS, HANDOFF_TTL_SECONDS, FormLeadPayload, OpaqueToken, Keyword,
  LeadsRpc, cleanKeyword, encodeRuntimeConfig, isBrandClean,
  type ClickParams, type RuntimeConfig, type LeadsRpcMethod, type LeadsRpcRequest, type LeadsRpcResponse,
} from "@anjuna/contracts";
import { assignVariant, type Assignment } from "./assignment.js";
import { assetResponse, createAssetCache, initialResponse } from "./brand-assets.js";
import { APPLY_HTML } from "./apply.js";
import { BrandSettings, LEGAL_PATHS, STATIC_FILES, STATIC_PREFIXES, type BrandConfigSource, type BrandWorkerConfig } from "./config.js";
import { CoreError, withCoreTimeout, type AnalyticsKind, type CoreResult, type SubmitContext } from "./core-client.js";
import { createSettingsCache } from "./settings-cache.js";
import { applySiteText, effectiveSiteText, type EffectiveSiteText } from "./site-text.js";
import { cookie, json, notFound, PayloadTooLarge, readCappedBody, readCookie, redirect } from "./http.js";

const PAUSE_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1><p>Please try again later.</p></html>';
const COMPLETE_HTML = (ref: string) => `<!doctype html><html lang="en"><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Request received</title>` +
  `<h1>Thank you</h1><p>Your request has been received.</p>${ref ? `<p>Reference: ${ref}</p>` : ""}</html>`;

function adParams(url: URL): ClickParams {
  const params: ClickParams = {};
  for (const key of CLICK_PARAM_KEYS) {
    const value = url.searchParams.get(key)?.trim().slice(0, 512);
    if (value) params[key] = value;
  }
  return params;
}

function keywordFor(url: URL, settings: BrandSettings): string | null {
  const keyword = cleanKeyword(url.searchParams.get("keyword") ?? settings.keyword_default);
  // Some Unicode case expansions or a split surrogate at the cap can fail the shared schema.
  return keyword && Keyword.safeParse(keyword).success && isBrandClean(keyword) ? keyword : null;
}

function paramHandoff(url: URL, settings: BrandSettings): { amount: number; zip: string } | null {
  const raw = url.searchParams.get("requested_amount") ?? "";
  const amount = Number(raw);
  const zip = url.searchParams.get("zip") ?? "";
  return /^\d+$/.test(raw) && settings.amount_buckets.includes(amount) && /^\d{5}$/.test(zip) ? { amount, zip } : null;
}

function gateFail(url: URL): Response {
  const query = new URLSearchParams(adParams(url)).toString();
  return redirect(query ? `/?${query}` : "/");
}

function attribution(assignment: Assignment) {
  return { experiment_id: assignment.experiment_id, variant: assignment.variant };
}

async function rpc<M extends LeadsRpcMethod>(config: BrandWorkerConfig, method: M, input: LeadsRpcRequest<M>, context?: SubmitContext): Promise<CoreResult<M>> {
  const call = config.core[method] as (body: LeadsRpcRequest<M>, context?: SubmitContext) => Promise<CoreResult<M>>;
  const request = LeadsRpc[method].request.parse(input) as LeadsRpcRequest<M>;
  const result = await withCoreTimeout(() => call.call(config.core, request, context), config.coreTimeoutMs);
  // Validate custom/mock clients too. Never reflect unknown core response fields to browsers.
  const parsed = LeadsRpc[method].response.safeParse(result.data);
  const zipNotFound = method === "zip" && result.status === 404 && parsed.success && "found" in parsed.data && !parsed.data.found;
  if (!parsed.success || (method !== "submitLead" && !zipNotFound && (result.status < 200 || result.status >= 300))) {
    throw new CoreError(result.status);
  }
  return { status: result.status, data: parsed.data as LeadsRpcResponse<M> };
}

function fallback(config: BrandWorkerConfig, operation: "issueHandoff" | "verifyHandoff", error: unknown): boolean {
  if (error instanceof CoreError && error.status < 500) return false;
  try {
    if (config.onGateFallback) config.onGateFallback(operation);
    else console.warn("flow_gate_fallback", operation);
  } catch { /* Observability cannot block the fallback. */ }
  return true;
}

async function captureClick(request: Request, url: URL, config: BrandWorkerConfig, settings: BrandSettings, assignment: Assignment): Promise<string | null> {
  const params = adParams(url);
  if (!CLICK_TRIGGER_KEYS.some((key) => params[key])) return null;
  const keyword = keywordFor(url, settings);
  if (keyword) params.keyword = keyword;
  else delete params.keyword;
  let referrer: string | null = null;
  try {
    const value = new URL(request.headers.get("referer") ?? "");
    if (["https:", "http:"].includes(value.protocol)) referrer = value.origin.slice(0, 512);
  } catch { /* An absent/invalid referrer contributes no attribution. */ }
  try {
    const result = await rpc(config, "recordClick", {
      brand_id: settings.brand_id, hostname: settings.hostname,
      landing_path: url.pathname, referrer_origin: referrer, params, ...attribution(assignment),
    });
    return cookie("_vc", result.data.click_session_id);
  } catch { return null; }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function serveHtml(url: URL, config: BrandWorkerConfig, assetPath: string, keyword: string | null,
  extra: { cfg?: RuntimeConfig; cta?: ClickParams; site?: { text: EffectiveSiteText; page: "index" | "other" } } = {}): Promise<Response> {
  // Do not forward visitor headers or query strings to static assets (UA/IP/referrer parity).
  const asset = await config.assets.fetch(new Request(new URL(assetPath, url.origin)));
  if (!asset.ok) { await asset.body?.cancel(); return notFound(); }
  let rewriter = new HTMLRewriter();
  if (keyword) rewriter = rewriter.on("[data-kw]", { element(element) { element.setInnerContent(keyword); } });
  if (extra.site) rewriter = applySiteText(rewriter, extra.site.text, extra.site.page);
  if (extra.cfg) {
    const payload = encodeRuntimeConfig(extra.cfg);
    rewriter = rewriter.on('script[type="application/json"]#cfg', { element(element) { element.setInnerContent(payload, { html: true }); } });
  }
  if (extra.cta) {
    const hidden = Object.entries(extra.cta)
      .filter(([, value]) => isBrandClean(value))
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeAttribute(value)}">`).join("");
    rewriter = rewriter.on("form[data-cta]", { element(element) { element.append(hidden, { html: true }); } });
  }
  const transformed = rewriter.transform(asset);
  const headers = new Headers(transformed.headers);
  for (const header of ["content-length", "etag", "last-modified", "set-cookie", "vary"]) headers.delete(header);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "private, no-store");
  return new Response(transformed.body, { status: asset.status, headers });
}

function proxyRoute(path: string, settings: BrandSettings): { kind: AnalyticsKind; suffix: string } | null {
  if (path === "/api/telemetry") return { kind: "telemetry", suffix: "/" };
  if (path === "/api/errors") return { kind: "errors", suffix: "/" };
  for (const kind of ["posthog", "sentry"] as const) {
    const base = settings.proxies[kind];
    if (base && (path === base || (kind === "posthog" && path.startsWith(`${base}/`)))) {
      return { kind, suffix: path.slice(base.length) || "/" };
    }
  }
  return null;
}

// posthog-js retries every response that is not 200 and not 4xx (retry-queue.js), so an empty 204 would
// send each PostHog event twice. PostHog's capture endpoint answers 200 with {"status":1}; the proxy does too.
// The answer is static: it never carries anything from core or PostHog.
function analyticsAccepted(kind: AnalyticsKind): Response {
  if (kind === "posthog") return new Response('{"status":1}', { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function handle(request: Request, config: BrandWorkerConfig, settings: BrandSettings, assetFor: ReturnType<typeof createAssetCache>): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (url.hostname === `www.${settings.hostname}`) {
    url.hostname = settings.hostname;
    url.protocol = "https:";
    url.port = "";
    return redirect(url.href, 301);
  }
  if (url.hostname !== settings.hostname) return notFound();
  const read = request.method === "GET" || request.method === "HEAD";
  const legal = LEGAL_PATHS.find((page) => path === page || path === `${page}/`);
  const form = path === settings.formRoute || path === `${settings.formRoute}/`;
  const provider = path === `${settings.formRoute}/provider`;
  const complete = path === `${settings.formRoute}/complete`;
  const apply = path === "/apply" || path === "/apply/";
  const assetKind = Object.hasOwn(BRAND_ASSET_PATHS, path) ? BRAND_ASSET_PATHS[path as keyof typeof BRAND_ASSET_PATHS] : null;
  const staticAsset = assetKind !== null || STATIC_FILES.some((file) => path === file) || STATIC_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
  const proxy = proxyRoute(path, settings);
  const allowed = (read && (path === "/" || path === "/go" || legal || form || provider || complete || apply || staticAsset || path === "/api/zip" || path === "/api/health")) ||
    (request.method === "POST" && (path === "/api/leads" || proxy));
  if (!allowed) return notFound();
  if (settings.paused && !staticAsset) {
    return new Response(PAUSE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "300" } });
  }
  if (assetKind) {
    // The brand's uploaded file, else (favicon paths) the template's own static file, else the generated initial letter.
    // `/favicon.svg` serves an uploaded favicon only when it is an SVG. Nothing here depends on the visitor.
    const stored = await assetFor(config, settings, assetKind);
    const wrongType = stored !== null && path === "/favicon.svg" && stored.contentType !== "image/svg+xml";
    if (stored && !wrongType) return assetResponse(stored.bytes, stored.contentType);
    if (assetKind === "favicon") {
      const response = await config.assets.fetch(new Request(new URL(path, url.origin), { method: request.method }));
      if (response.status === 200 || response.status === 304) return response;
      await response.body?.cancel();
    }
    return wrongType ? notFound() : initialResponse(effectiveSiteText(settings).brand);
  }
  if (staticAsset) {
    const response = await config.assets.fetch(new Request(new URL(path, url.origin), { method: request.method }));
    if (response.status !== 200 && response.status !== 304) { await response.body?.cancel(); return notFound(); }
    return response;
  }
  const site = effectiveSiteText(settings);
  if (legal) return serveHtml(url, config, `${legal}/index.html`, null, { site: { text: site, page: "other" } });
  if (path === "/api/health") return json({ ok: true });
  if (proxy) {
    try {
      if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") return json({ error: "unsupported_encoding" }, 415);
      const body = await readCappedBody(request, ANALYTICS_LIMITS[proxy.kind]);
      await withCoreTimeout(() => config.core.forwardAnalytics({
        brand_id: settings.brand_id, hostname: settings.hostname, kind: proxy.kind, path: proxy.suffix,
        content_type: request.headers.get("content-type") ?? "text/plain", body,
      }), config.coreTimeoutMs);
      return analyticsAccepted(proxy.kind);
    } catch (error) {
      // Core's per brand limit: drop like an accepted event. A success answer makes neither SDK retry.
      if (error instanceof CoreError && error.status === 429) return analyticsAccepted(proxy.kind);
      return json({ error: error instanceof PayloadTooLarge ? "payload_too_large" : "unavailable" }, error instanceof PayloadTooLarge ? 413 : 503);
    }
  }
  if (path === "/api/zip") {
    const input = { brand_id: settings.brand_id, zip: url.searchParams.get("zip") ?? "" };
    if (!LeadsRpc.zip.request.safeParse(input).success) return json({ found: false }, 400);
    try {
      const result = await rpc(config, "zip", input);
      if (!isBrandClean(JSON.stringify(result.data))) return json({ found: false }, 503);
      return json(result.data, result.status);
    } catch { return json({ found: false }, 503); }
  }
  if (apply) {
    return new Response(APPLY_HTML, { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "referrer-policy": "no-referrer", "x-robots-tag": "noindex",
    } });
  }
  if (complete) {
    const ref = url.searchParams.get("ref") ?? "";
    return new Response(COMPLETE_HTML(/^[a-f0-9-]{1,8}$/i.test(ref) ? ref : ""), { status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  if (provider) {
    try {
      const result = await rpc(config, "resolveContinuation", { brand_id: settings.brand_id, token: url.searchParams.get("c") ?? "" });
      const destination = new URL(result.data.url, url.origin);
      if (destination.protocol !== "https:" || destination.username || destination.password) return redirect("/");
      const response = redirect(destination.href);
      response.headers.set("referrer-policy", "no-referrer");
      return response;
    } catch { return redirect("/"); }
  }

  const assignment = assignVariant(request, settings);
  const finish = (response: Response) => {
    if (assignment.setCookie) response.headers.append("set-cookie", assignment.setCookie);
    return response;
  };
  const keyword = keywordFor(url, settings);
  if (path === "/") {
    const [response, clickCookie] = await Promise.all([
      serveHtml(url, config, "/index.html", keyword, { cta: adParams(url), site: { text: site, page: "index" } }),
      captureClick(request, url, config, settings, assignment),
    ]);
    if (clickCookie) response.headers.append("set-cookie", clickCookie);
    return finish(response);
  }
  if (path === "/go") {
    const handoff = paramHandoff(url, settings);
    if (!handoff) return gateFail(url);
    const query = new URLSearchParams({ requested_amount: String(handoff.amount), zip: handoff.zip, ...adParams(url) });
    const response = redirect(`${settings.formRoute}?${query}`);
    if (settings.flow_gate_mode === "signed_cookie") {
      try {
        const issued = await rpc(config, "issueHandoff", { brand_id: settings.brand_id, requested_amount: handoff.amount, zip: handoff.zip });
        response.headers.append("set-cookie", cookie("_vh", issued.data.token, HANDOFF_TTL_SECONDS));
      } catch (error) { if (!fallback(config, "issueHandoff", error)) return gateFail(url); }
    }
    const clickCookie = await captureClick(request, url, config, settings, assignment);
    if (clickCookie) response.headers.append("set-cookie", clickCookie);
    return finish(response);
  }
  if (form) {
    let handoff = paramHandoff(url, settings);
    if (settings.flow_gate_mode === "signed_cookie") {
      try {
        const verified = await rpc(config, "verifyHandoff", { brand_id: settings.brand_id, token: (readCookie(request, "_vh") ?? "").slice(0, 512) });
        if (!verified.data.valid || Date.parse(verified.data.expires_at) <= Date.now() || !settings.amount_buckets.includes(verified.data.requested_amount)) return gateFail(url);
        handoff = { amount: verified.data.requested_amount, zip: verified.data.zip };
      } catch (error) { if (!fallback(config, "verifyHandoff", error)) return gateFail(url); }
    }
    if (!handoff) return gateFail(url);
    return finish(await serveHtml(url, config, "/_f/index.html", keyword, {
      cfg: { brand: site.brand, amount: handoff.amount, zip: handoff.zip, keyword,
        formRoute: settings.formRoute, variant: assignment.variant, proxies: settings.proxies },
      site: { text: site, page: "other" },
    }));
  }
  if (path === "/api/leads") {
    let lead: FormLeadPayload;
    try {
      const raw: unknown = JSON.parse(await readCappedBody(request, 128 * 1024));
      // Ignore attempted server-context overrides, while keeping all V1 payload fields intact.
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const { brand_id: _brand, hostname: _host, ...payload } = raw as Record<string, unknown>;
        lead = FormLeadPayload.parse(payload);
      } else return json({ status: "invalid", message: "Invalid payload" }, 400);
    } catch (error) {
      return json({ status: "invalid", message: "Invalid payload" }, error instanceof PayloadTooLarge ? 413 : 400);
    }
    const click = OpaqueToken.safeParse(readCookie(request, "_vc"));
    try {
      const result = await rpc(config, "submitLead", {
        brand_id: settings.brand_id, hostname: settings.hostname,
        click_session_id: click.success ? click.data : null, ...attribution(assignment), lead,
        client: { ip: request.headers.get("cf-connecting-ip")?.slice(0, 64) || "unknown", user_agent: (request.headers.get("user-agent") ?? "").slice(0, 512) },
      }, { consent_brand: site.brand,
        ...(request.headers.get("sec-gpc") === "1" ? { gpc: "1" } : request.headers.get("sec-gpc") === "0" ? { gpc: "0" } : {}),
      });
      const data = result.data;
      const body = "continuation" in data ? {
        status: data.status, lead_id: data.lead_id, reference: data.reference,
        redirect_url: `${settings.formRoute}/provider?c=${encodeURIComponent(data.continuation)}`,
      } : data;
      if (!isBrandClean(JSON.stringify(body))) throw new CoreError(502);
      return finish(json(body, result.status));
    } catch { return json({ status: "error", message: "Please try again in a moment." }, 503); }
  }
  return notFound();
}

/** Refresh public settings once per minute; static BRAND_CONFIG remains the outage fallback. */
export function createBrandWorker(source: BrandConfigSource): { fetch(request: Request): Promise<Response> } {
  if (typeof source !== "function") BrandSettings.parse(source);
  const settingsFor = createSettingsCache();
  const assetFor = createAssetCache();
  return { async fetch(request) {
    const config = typeof source === "function" ? await source() : source;
    const response = await handle(request, config, await settingsFor(config), assetFor);
    if (request.method !== "HEAD") return response;
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers: response.headers });
  } };
}
