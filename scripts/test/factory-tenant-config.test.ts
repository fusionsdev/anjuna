import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import aduplift from "@anjuna/tenants/aduplift.config";
import maimax from "@anjuna/tenants/maimax.config";

describe("owner-reviewed factory tenant bindings (no deployment)", () => {
  it.each([aduplift, maimax])("matches $name runtime defaults and account isolation", (tenant) => {
    const config = JSON.parse(readFileSync(new URL(`../../workers/factory/wrangler.${tenant.name}.jsonc`, import.meta.url), "utf8"));
    expect(config.account_id).toBe(tenant.accountId);
    expect(config.d1_databases[0].database_id).toBe(tenant.d1!.factory);
    expect(config.vars).toMatchObject({ CF_ACCOUNT_ID: tenant.accountId, CORE_ACCOUNT: tenant.brandDefaults.account,
      CORE_DOMAIN: tenant.coreDomain, CORE_SERVICE_NAME: config.services[0].service,
      DEFAULT_FORM_ROUTE: tenant.brandDefaults.formRoute, DEFAULT_AMOUNT_BUCKETS: JSON.stringify(tenant.brandDefaults.amountBuckets),
      LEADSGATE_AID: tenant.leadsGateAid, LEADSGATE_PREPOP_BASE: tenant.prepopBase });
    expect(config.services[0].entrypoint).toBe("FactoryLifecycleService");
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });
});
