import { createBrandWorker, type FetchBinding } from "../../../packages/brand-runtime/src/index";
import { MockCoreClient } from "../../../packages/brand-runtime/src/testing";

// Exercise the real brand runtime. Core and the buyer are local test doubles.
const core = new MockCoreClient();
const submitLead = core.submitLead.bind(core);
core.submitLead = async (body) => {
  const result = await submitLead(body);
  if ("continuation" in result.data) {
    const query = new URLSearchParams({
      requested_amount: body.lead.lead.requested_amount,
      first_name: body.lead.lead.first_name,
      click_id: body.click_session_id ?? "",
    });
    core.continuations.set(result.data.continuation, `https://example.com/prepop?${query}`);
  }
  return result;
};

export default {
  fetch(request: Request, env: { ASSETS: FetchBinding }) {
    // Runtime hostname validation stays enabled; only the local transport is rewritten.
    const url = new URL(request.url);
    url.hostname = "example.test";
    return createBrandWorker({
      brand_id: "example", brand: "Example Brand", hostname: "example.test",
      formRoute: "/request", amount_buckets: [3250], default_variant: "lite_v1",
      core, assets: env.ASSETS,
    }).fetch(new Request(url, request));
  },
};
