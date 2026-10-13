import {
  ANALYTICS_FORWARD_PATHS, AnalyticsForwardRequest, LeadsRpc, SUBMIT_CONTEXT_HEADERS,
  type AnalyticsKind as ContractAnalyticsKind, type LeadsRpcMethod, type LeadsRpcRequest, type LeadsRpcResponse,
} from "@anjuna/contracts";

export type CoreResult<M extends LeadsRpcMethod> = { status: number; data: LeadsRpcResponse<M> };
export interface SubmitContext { gpc?: "0" | "1"; consent_brand?: string }
type RpcMethods = { [M in LeadsRpcMethod]: (body: LeadsRpcRequest<M>, context?: SubmitContext) => Promise<CoreResult<M>> };

export type AnalyticsKind = ContractAnalyticsKind;
/** The analytics-forward envelope; the contracts package owns its shape and limits. */
export type AnalyticsRequest = AnalyticsForwardRequest;

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
  /** Overrides the contract's core path (ANALYTICS_FORWARD_PATHS) for a kind. */
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

  private request<T>(path: string, body: unknown, decode: (response: Response) => Promise<T>, context?: SubmitContext): Promise<T> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error("Invalid core path");
    return withCoreTimeout(async (signal) => {
      const response = await this.send(new Request(this.origin + path, {
        method: "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.credential}`,
          ...(context?.gpc !== undefined ? { [SUBMIT_CONTEXT_HEADERS.gpc]: context.gpc } : {}),
          ...(context?.consent_brand ? { [SUBMIT_CONTEXT_HEADERS.consent_brand]: encodeURIComponent(context.consent_brand) } : {}),
        },
        body: JSON.stringify(body),
      }));
      return decode(response);
    }, this.options.timeoutMs);
  }

  private async call<M extends LeadsRpcMethod>(method: M, body: LeadsRpcRequest<M>, context?: SubmitContext): Promise<CoreResult<M>> {
    const contract = LeadsRpc[method];
    const validated = contract.request.parse(body);
    return this.request(contract.path, validated, async (response) => {
      // submitLead has contract-shaped 400/429/503 errors as well as 200/201 successes.
      const parsed = contract.response.safeParse(await response.json().catch(() => null));
      const zipNotFound = method === "zip" && response.status === 404 && parsed.success && "found" in parsed.data && !parsed.data.found;
      if (!parsed.success || (!response.ok && method !== "submitLead" && !zipNotFound)) throw new CoreError(response.status);
      return { status: response.status, data: parsed.data as LeadsRpcResponse<M> };
    }, context);
  }

  recordClick: RpcMethods["recordClick"] = (body) => this.call("recordClick", body);
  submitLead: RpcMethods["submitLead"] = (body, context) => this.call("submitLead", body, context);
  resolveContinuation: RpcMethods["resolveContinuation"] = (body) => this.call("resolveContinuation", body);
  zip: RpcMethods["zip"] = (body) => this.call("zip", body);
  issueHandoff: RpcMethods["issueHandoff"] = (body) => this.call("issueHandoff", body);
  verifyHandoff: RpcMethods["verifyHandoff"] = (body) => this.call("verifyHandoff", body);
  brandSettings: RpcMethods["brandSettings"] = (body) => this.call("brandSettings", body);

  async forwardAnalytics(body: AnalyticsRequest): Promise<void> {
    const validated = AnalyticsForwardRequest.parse(body);
    const path = this.options.analyticsPaths?.[body.kind] ?? ANALYTICS_FORWARD_PATHS[body.kind];
    await this.request(path, validated, async (response) => {
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
