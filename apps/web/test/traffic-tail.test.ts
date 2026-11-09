import { expect, it } from "vitest";
import { handleTrafficTailRoute } from "../src/server/traffic-tail.js";
import type { Env } from "../src/server/env.js";
import type { AdminRequestContext } from "@anjuna/contracts";

const ctx: AdminRequestContext = { actor_id: "test-user", actor_role: "employee", request_id: "req_tail" };
const request = new Request("https://panel.example/api/traffic/tail?brand=brand-a,brand-b");
const call = (env: Env, context = ctx) => handleTrafficTailRoute(request, env, new URL(request.url), "/api/traffic/tail", context);

it.each(["employee", "owner"] as const)("%s can stream; brand filter passes and no authentication headers leak", async role => {
  let received: Request | undefined;
  const env = { CORE: { fetch: async (req: Request) => {
    received = req;
    return new Response("retry: 3000\n\n", { headers: { "content-type": "text/event-stream", authorization: "private" } });
  } } } as unknown as Env;
  const response = await call(env, { ...ctx, actor_role: role });
  expect(response?.status).toBe(200);
  expect(new URL(received!.url).searchParams.get("brand")).toBe("brand-a,brand-b");
  expect(response?.headers.get("authorization")).toBeNull();
  expect(await response?.text()).toContain("retry: 3000");
});
it("returns 503 for unreachable core/DO", async () => {
  expect((await call({} as Env))?.status).toBe(503);
  expect((await call({ CORE: { fetch: async () => { throw new Error("down"); } } } as unknown as Env))?.status).toBe(503);
  expect((await call({ CORE: { fetch: async () => new Response("down", { status: 503 }) } } as unknown as Env))?.status).toBe(503);
});
it("returns 503 after the 5 second connection deadline even if the binding ignores abort", async () => {
  const start = Date.now();
  const response = await call({ CORE: { fetch: () => new Promise(() => {}) } } as unknown as Env);
  expect(response?.status).toBe(503);
  expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
  expect(Date.now() - start).toBeLessThan(7000);
});
