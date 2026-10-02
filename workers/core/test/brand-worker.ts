import { createBrandWorker, ServiceBindingCoreClient, type FetchBinding } from "../../../packages/brand-runtime/src/index.js";

export default {
  fetch(request: Request, env: { CORE: FetchBinding }) {
    return createBrandWorker({
      brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/request",
      amount_buckets: [750, 1750], core: new ServiceBindingCoreClient(env.CORE, { credential: "account-a-token" }),
      assets: { async fetch() {
        return new Response('<h1 data-kw>Brand A</h1><script type="application/json" id="cfg">{}</script>', { headers: { "content-type": "text/html" } });
      } },
    }).fetch(request);
  },
};
