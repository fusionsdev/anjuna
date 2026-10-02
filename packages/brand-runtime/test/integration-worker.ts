import { createBrandWorker, type FetchBinding } from "../src/index.js";
import { MockCoreClient } from "../src/testing.js";

export default {
  async fetch(request: Request, env: { ASSETS: FetchBinding }) {
    const worker = createBrandWorker({
      brand_id: "example", brand: "Example Brand", hostname: "example.com", formRoute: "/request",
      amount_buckets: [500, 750, 1000], core: new MockCoreClient(), assets: env.ASSETS,
    });
    const result = await worker.fetch(request);
    const response = new Response(result.body, result);
    response.headers.set("x-runtime-invoked", "yes");
    return response;
  },
};
