import { ApplyRuntimeRequest, ApplyRuntimeResponse, RuntimeStateRequest, RuntimeStateResponse } from "@anjuna/contracts";

export interface CoreLifecycleBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function boundedError(status: number): Error {
  return new Error(`Core lifecycle request failed (${status})`);
}

/** Authenticated client for the private FactoryLifecycleService entrypoint. */
export class CoreLifecycleClient {
  constructor(private readonly binding: CoreLifecycleBinding, private readonly token: string, private readonly timeoutMs = 3000) {
    if (token.length === 0 || /[\r\n]/.test(token)) throw new Error("CORE_TOKEN is empty or contains a newline");
  }

  async applyRuntime(request: ApplyRuntimeRequest): Promise<ApplyRuntimeResponse> {
    return this.post("/lifecycle/runtime", ApplyRuntimeRequest.parse(request), ApplyRuntimeResponse.parse);
  }

  async runtimeState(request: RuntimeStateRequest): Promise<RuntimeStateResponse> {
    return this.post("/lifecycle/runtime-state", RuntimeStateRequest.parse(request), RuntimeStateResponse.parse);
  }

  async verifyRuntime(brandId: string, account: string, revisionId: string | null, installId: string): Promise<void> {
    const state = await this.runtimeState({ brand_id: brandId, account });
    if (state.state !== "applied" || state.applied_revision_id !== revisionId || state.last_lifecycle_install_id !== installId) {
      throw new Error("Core lifecycle verification failed");
    }
  }

  private async post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
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
    if (!response.ok) throw boundedError(response.status);
    try { return parse(await response.json()); }
    catch { throw new Error("Core lifecycle response was invalid"); }
  }
}
