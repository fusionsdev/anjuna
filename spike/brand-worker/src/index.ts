// AURUM v3 spike — brand Worker. Serves the static landing + form, runs first on every path,
// and talks to core over HTTPS with a per-account write-only credential. No D1 here.

interface Env {
  ASSETS: Fetcher;
  CORE_URL: string;      // https://<core>.workers.dev in the spike, core.aduplift.ai later
  CORE_TOKEN: string;    // secret: per-account write-only credential
  BRAND_ID: string;
  BRAND_NAME: string;    // display brand injected into the form's runtime config
  FORM_ROUTE: string;    // e.g. /request
  AMOUNTS: string;       // JSON array of allowed buckets
}

const AD_PARAMS = ["gclid", "gbraid", "wbraid", "msclkid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "keyword"];
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid"];
const CLICK_COOKIE = "_vc";

function adParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AD_PARAMS) {
    const v = (url.searchParams.get(k) ?? "").trim();
    if (v) out[k] = v.slice(0, 256);
  }
  return out;
}

// Keyword from the ad's Final URL suffix (keyword={keyword}). Owner-controlled head terms,
// so the only guards are: text-only, safe charset, length cap, title case.
function cleanKeyword(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!s) return null;
  return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function getCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function core(env: Env, path: string, body: unknown): Promise<Response> {
  return fetch(env.CORE_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CORE_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...extraHeaders } });
}

function gateFail(url: URL): Response {
  // Same response for every visitor: back to the landing page, keeping ad params.
  const qs = new URLSearchParams(adParams(url)).toString();
  return redirect("/" + (qs ? `?${qs}` : ""));
}

function validHandoff(url: URL, env: Env): { amount: number; zip: string } | null {
  const amount = Number(url.searchParams.get("requested_amount"));
  const zip = url.searchParams.get("zip") ?? "";
  const buckets: number[] = JSON.parse(env.AMOUNTS);
  if (!buckets.includes(amount) || !/^\d{5}$/.test(zip)) return null;
  return { amount, zip };
}

// Click capture (V1 fo_click + click_sessions, via core). Never blocks the page on failure.
async function captureClick(req: Request, url: URL, env: Env): Promise<string | null> {
  const params = adParams(url);
  const existing = getCookie(req, CLICK_COOKIE);
  const hasNewClickId = CLICK_IDS.some((k) => params[k]);
  if (existing && !hasNewClickId) return null;
  if (!hasNewClickId) return null;
  try {
    const res = await core(env, "/rpc/recordClick", { brand_id: env.BRAND_ID, hostname: url.hostname, params });
    if (!res.ok) return null;
    const { click_session_id } = (await res.json()) as { click_session_id: string };
    return `${CLICK_COOKIE}=${click_session_id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`;
  } catch {
    return null;
  }
}

async function serveHtml(req: Request, env: Env, assetPath: string, keyword: string | null,
                         extra: { cfg?: Record<string, unknown>; ctaParams?: Record<string, string> }): Promise<Response> {
  const assetUrl = new URL(assetPath, req.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { headers: req.headers }));
  let rw = new HTMLRewriter();
  if (keyword) rw = rw.on("[data-kw]", { element(el) { el.setInnerContent(keyword); } }); // text, never HTML
  if (extra.cfg) {
    const payload = JSON.stringify(extra.cfg).replace(/</g, "\\u003c");
    rw = rw.on("script#cfg", { element(el) { el.setInnerContent(payload, { html: true }); } });
  }
  if (extra.ctaParams && Object.keys(extra.ctaParams).length) {
    // Content appended by HTMLRewriter is not re-processed, so attribute values are escaped here.
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const hidden = Object.entries(extra.ctaParams)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    rw = rw.on("form[data-cta]", { element(el) { el.append(hidden, { html: true }); } });
  }
  const out = rw.transform(asset);
  const headers = new Headers(out.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(out.body, { status: asset.status, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const route = env.FORM_ROUTE;
    const keyword = cleanKeyword(url.searchParams.get("keyword"));

    // Landing page.
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const setCookie = await captureClick(req, url, env);
      const res = await serveHtml(req, env, "/index.html", keyword, { ctaParams: adParams(url) });
      if (setCookie) res.headers.append("set-cookie", setCookie);
      return res;
    }

    // Static legal pages and favicons.
    if (req.method === "GET" && (/^\/(privacy|terms)\/?$/.test(path) || /^\/favicon\.(ico|svg)$/.test(path))) {
      const p = /^\/(privacy|terms)\/?$/.test(path) ? path.replace(/\/?$/, "/index.html") : path;
      return env.ASSETS.fetch(new Request(new URL(p, req.url), req));
    }

    // Flow gate entry: landing CTA -> /go.
    if (req.method === "GET" && path === "/go") {
      const h = validHandoff(url, env);
      if (!h) return gateFail(url);
      const setCookie = await captureClick(req, url, env);
      const next = new URLSearchParams({ requested_amount: String(h.amount), zip: h.zip, ...adParams(url) });
      return redirect(`${route}?${next}`, setCookie ? { "set-cookie": setCookie } : {});
    }

    // Form route: only reachable with a valid handoff.
    if (req.method === "GET" && (path === route || path === route + "/")) {
      const h = validHandoff(url, env);
      if (!h) return gateFail(url);
      return serveHtml(req, env, "/_f/index.html", keyword, {
        cfg: { amount: h.amount, zip: h.zip, keyword, formRoute: route, brand: env.BRAND_NAME },
      });
    }

    // Form SPA static assets (fixed neutral base path, independent of formRoute).
    if (req.method === "GET" && path.startsWith("/_f/assets/") && !path.includes("..")) {
      return env.ASSETS.fetch(req);
    }

    // Best-effort form side channels: accepted and dropped in the spike.
    if (req.method === "POST" && ["/api/telemetry", "/api/errors", "/api/gate-interest"].includes(path)) {
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && path === "/api/zip") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Provider hop: opaque continuation -> LeadsGate prepop URL.
    if (req.method === "GET" && path === route + "/provider") {
      const token = url.searchParams.get("c") ?? "";
      try {
        const res = await core(env, "/rpc/resolveContinuation", { brand_id: env.BRAND_ID, token });
        if (!res.ok) return redirect("/");
        const { url: prepop } = (await res.json()) as { url: string };
        return redirect(prepop, { "referrer-policy": "no-referrer" });
      } catch {
        return redirect("/");
      }
    }

    // Lead submit: brand_id/hostname come from this Worker, never from the client.
    if (req.method === "POST" && path === "/api/leads") {
      const lead = await req.json().catch(() => null);
      if (!lead) return Response.json({ status: "invalid", message: "Invalid payload" }, { status: 400 });
      try {
        const res = await core(env, "/rpc/submitLead", {
          brand_id: env.BRAND_ID, hostname: url.hostname, click_session_id: getCookie(req, CLICK_COOKIE), lead,
        });
        const data = (await res.json().catch(() => ({}))) as { status?: string; continuation?: string; lead_id?: string; message?: string };
        // AURUM form contract: {status, lead_id, redirect_url}. The redirect is our own provider hop,
        // so the browser never sees the prepop URL in a JSON response.
        const body = data.continuation
          ? { status: data.status, lead_id: data.lead_id, redirect_url: `${route}/provider?c=${encodeURIComponent(data.continuation)}` }
          : data;
        return Response.json(body, { status: res.status, headers: { "cache-control": "no-store" } });
      } catch {
        return Response.json({ status: "error", message: "Please try again in a moment." }, { status: 503 });
      }
    }

    if (req.method === "GET" && path === "/api/health") return Response.json({ ok: true });
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
