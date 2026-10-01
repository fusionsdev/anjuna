// Readable port of PostHog's official browser snippet (the stub V1 inlined in index.html).
//
// Differences from the stock snippet, both deliberate:
// - array.js is loaded from the brand's FIRST-PARTY proxy path (`<proxyPath>/static/array.js`),
//   never from a PostHog-owned host, so the form page makes no third-party request.
// - it is installed only when initPostHog() is given a proxy path, so a brand without the proxy
//   loads nothing at all.
//
// Behaviour is otherwise the same: calls made before array.js arrives are queued on the stub
// and replayed by the SDK when it loads.

type Queued = unknown[] & { [method: string]: unknown };

const METHODS = [
  "capture", "identify", "alias", "register", "register_once", "register_for_session",
  "unregister", "unregister_for_session", "reset", "opt_in_capturing", "opt_out_capturing",
  "has_opted_in_capturing", "has_opted_out_capturing", "set_config", "get_distinct_id",
  "get_session_id", "people.set", "people.set_once",
];

export function installPostHogStub(proxyPath: string): void {
  const w = window as unknown as { posthog?: Queued & { __SV?: number; _i?: unknown[] } };
  if (w.posthog?.__SV) return;

  const stub = (w.posthog ?? []) as Queued & { __SV?: number; _i: unknown[] };
  w.posthog = stub;
  stub._i = [];

  stub.init = function init(token: string, config: Record<string, unknown>, name?: string) {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.crossOrigin = "anonymous";
    script.async = true;
    script.src = `${proxyPath}/static/array.js`;
    const first = document.getElementsByTagName("script")[0];
    if (first?.parentNode) first.parentNode.insertBefore(script, first);
    else document.head.appendChild(script);

    let target: Queued = stub;
    if (name !== undefined) {
      target = [] as unknown as Queued;
      stub[name] = target;
    } else {
      name = "posthog";
    }
    const people = (target.people as Queued | undefined) ?? ([] as unknown as Queued);
    target.people = people;

    for (const method of METHODS) {
      const parts = method.split(".");
      const owner: Queued = parts.length === 2 ? people : target;
      const fn = parts.length === 2 ? parts[1]! : method;
      owner[fn] = (...args: unknown[]) => {
        owner.push([fn, ...args]);
      };
    }
    stub._i.push([token, config, name]);
  };
  stub.__SV = 1;
}
