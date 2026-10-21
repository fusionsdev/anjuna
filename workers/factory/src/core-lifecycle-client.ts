import {
  ApplyRuntimeRequest, ApplyRuntimeResponse, InstallAdsRoutingRequest, InstallAdsRoutingResponse, InstallMailingListRequest,
  InstallMailingListResponse, RuntimeStateRequest, RuntimeStateResponse,
} from "@anjuna/contracts";

export interface CoreLifecycleBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** `deterministic`: a 4xx other than 408 and 429, or a bad token, so a retry cannot succeed. */
export class CoreLifecycleError extends Error {
  constructor(message: string, readonly deterministic = false) { super(message); }
}

const deterministicStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

function boundedError(status: number): Error {
  return new CoreLifecycleError(`Core lifecycle request failed (${status})`, deterministicStatus(status));
}

/** Authenticated client for the private FactoryLifecycleService entrypoint. */
export class CoreLifecycleClient {
  constructor(private readonly binding: CoreLifecycleBinding, private readonly token: string, private readonly timeoutMs = 3000) {
    if (token.length === 0 || /[\r\n]/.test(token)) throw new CoreLifecycleError("CORE_TOKEN is empty or contains a newline", true);
  }

  async applyRuntime(request: ApplyRuntimeRequest): Promise<ApplyRuntimeResponse> {
    return this.post("/lifecycle/runtime", ApplyRuntimeRequest.parse(request), ApplyRuntimeResponse.parse);
  }

  async runtimeState(request: RuntimeStateRequest): Promise<RuntimeStateResponse> {
    return this.post("/lifecycle/runtime-state", RuntimeStateRequest.parse(request), RuntimeStateResponse.parse);
  }

  /** Copies the draft's ads routing into brand_runtime columns that are still NULL (Core never overwrites a set value). */
  async adsRouting(request: InstallAdsRoutingRequest): Promise<InstallAdsRoutingResponse> {
    return this.post("/lifecycle/ads-routing", InstallAdsRoutingRequest.parse(request), InstallAdsRoutingResponse.parse, { detail: true });
  }

  /** Gives the brand its own listmonk list; a stored list id answers without a listmonk call. */
  async mailingList(request: InstallMailingListRequest): Promise<InstallMailingListResponse> {
    return this.post("/lifecycle/mailing-list", InstallMailingListRequest.parse(request), InstallMailingListResponse.parse, { detail: true });
  }

  async verifyRuntime(brandId: string, account: string, revisionId: string | null, installId: string): Promise<void> {
    const state = await this.runtimeState({ brand_id: brandId, account });
    if (state.state !== "applied" || state.applied_revision_id !== revisionId || state.last_lifecycle_install_id !== installId) {
      throw new Error("Core lifecycle verification failed");
    }
  }

  /** `detail`: a failure carries Core's own message ("<message> (<status>)") so the install receipt says what went wrong. */
  private async post<T>(path: string, body: unknown, parse: (value: unknown) => T, options: { detail?: boolean } = {}): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = new Request(`https://core.internal${path}`, {
        method: "POST", redirect: "manual",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(boundedError(504)); }, this.timeoutMs);
      });
      response = await Promise.race([this.binding.fetch(request), timeout]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Core lifecycle request failed")) throw error;
      throw boundedError(503);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = options.detail ? await response.json().then((b) => (b as { message?: unknown } | null)?.message, () => undefined) : undefined;
      if (typeof detail === "string" && detail) throw new CoreLifecycleError(`${detail.slice(0, 300)} (${response.status})`, deterministicStatus(response.status));
      throw boundedError(response.status);
    }
    try { return parse(await response.json()); }
    catch { throw new Error("Core lifecycle response was invalid"); }
  }
}
