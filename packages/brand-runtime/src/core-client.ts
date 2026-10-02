import { LeadsRpc, type LeadsRpcMethod, type LeadsRpcRequest, type LeadsRpcResponse } from "@anjuna/contracts";

export type CoreResult<M extends LeadsRpcMethod> = { status: number; data: LeadsRpcResponse<M> };
type RpcMethods = { [M in LeadsRpcMethod]: (body: LeadsRpcRequest<M>) => Promise<CoreResult<M>> };

export type AnalyticsKind = "posthog" | "sentry" | "telemetry" | "errors";
export interface AnalyticsRequest {
  brand_id: string;
  hostname: string;
  kind: AnalyticsKind;
  /** Relative suffix below the public proxy path, e.g. /i/v0/. Never an arbitrary URL. */
  path: string;
  content_type: string;
  body: string;
}

export interface CoreClient extends RpcMethods {
  forwardAnalytics(request: AnalyticsRequest): Promise<void>;
}

export interface FetchBinding { fetch(request: Request): Promise<Response> }

export class CoreError extends Error {
  constructor(readonly status: number) { super("Core request failed"); }
}
export class CoreUnavailable extends Error {
  constructor() { super("Core unavailable"); }
}

/** Also bounds custom clients and Service Bindings that don't honour AbortSignal. */
export async function withCoreTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms = 3000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new CoreUnavailable()); controller.abort(); }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export interface TransportOptions {
  /** Per-account write-only credential, injected from a Worker secret. */
  credential: string;
  origin?: string;
  timeoutMs?: number;
  /** ADR-0004 has no shared endpoint contract yet; endpoint choices are explicit integration config. */
  analyticsPaths?: Partial<Record<AnalyticsKind, string>>;
}

abstract class TransportCoreClient implements CoreClient {
  private readonly origin: string;
  constructor(private readonly options: TransportOptions, private readonly send: (request: Request) => Promise<Response>) {
    const origin = new URL(options.origin ?? "https://core.aduplift.ai");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("Core origin must be an HTTPS origin");
    }
    if (!options.credential || /[\r\n]/.test(options.credential)) throw new Error("Core credential is required");
    this.origin = origin.origin;
  }

  private request<T>(path: string, body: unknown, decode: (response: Response) => Promise<T>): Promise<T> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error("Invalid core path");
    return withCoreTimeout(async (signal) => {
      const response = await this.send(new Request(this.origin + path, {
        method: "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.credential}` },
        body: JSON.stringify(body),
      }));
      return decode(response);
    }, this.options.timeoutMs);
  }

  private async call<M extends LeadsRpcMethod>(method: M, body: LeadsRpcRequest<M>): Promise<CoreResult<M>> {
    const contract = LeadsRpc[method];
    const validated = contract.request.parse(body);
    return this.request(contract.path, validated, async (response) => {
      // submitLead has contract-shaped 400/429/503 errors as well as 200/201 successes.
      const parsed = contract.response.safeParse(await response.json().catch(() => null));
      if (!parsed.success || (!response.ok && method !== "submitLead")) throw new CoreError(response.status);
      return { status: response.status, data: parsed.data as LeadsRpcResponse<M> };
    });
  }

  recordClick: RpcMethods["recordClick"] = (body) => this.call("recordClick", body);
  submitLead: RpcMethods["submitLead"] = (body) => this.call("submitLead", body);
  resolveContinuation: RpcMethods["resolveContinuation"] = (body) => this.call("resolveContinuation", body);
  zip: RpcMethods["zip"] = (body) => this.call("zip", body);
  issueHandoff: RpcMethods["issueHandoff"] = (body) => this.call("issueHandoff", body);
  verifyHandoff: RpcMethods["verifyHandoff"] = (body) => this.call("verifyHandoff", body);

  async forwardAnalytics(body: AnalyticsRequest): Promise<void> {
    const path = this.options.analyticsPaths?.[body.kind];
    if (!path) throw new Error("Analytics forwarding endpoint is not configured");
    await this.request(path, body, async (response) => {
      await response.body?.cancel();
      if (!response.ok) throw new CoreError(response.status);
    });
  }
}

export class HttpsCoreClient extends TransportCoreClient {
  constructor(options: TransportOptions, send: (request: Request) => Promise<Response> = (request) => fetch(request)) {
    super(options, send);
  }
}

export class ServiceBindingCoreClient extends TransportCoreClient {
  constructor(binding: FetchBinding, options: TransportOptions) {
    super(options, (request) => binding.fetch(request));
  }
}
