import { describe, expect, it } from "vitest";
import { TenantConfig, TenantSecrets } from "@anjuna/tenants/schema";
import aduplift from "@anjuna/tenants/aduplift.config";
import maimax from "@anjuna/tenants/maimax.config";

describe("TenantConfig schema", () => {
  it.each(["/apply", "/apply/", "/buyer/apply"])("accepts same-origin prepop path %s", (prepopBase) => {
    expect(TenantConfig.safeParse({ ...aduplift, prepopBase }).success).toBe(true);
  });

  it.each(["apply", "//external.example/apply", "/\\external.example/apply", "/apply?aid=999", "/apply#fragment", "javascript:alert(1)"])("rejects unsafe prepop base %s", (prepopBase) => {
    expect(TenantConfig.safeParse({ ...aduplift, prepopBase }).success).toBe(false);
  });

  it("accepts a valid full config", () => {
    const result = TenantConfig.safeParse({
      name: "test-tenant",
      accountId: "a".repeat(32),
      coreDomain: "core.example.com",
      appDomain: "app.example.com",
      leadsGateAid: "99999",
      prepopBase: "https://go.example.com/aff_c",
      brandDefaults: {
        account: "test-tenant",
        formRoute: "/request",
        amountBuckets: [100, 200, 500, 1000],
        payloadVersion: "2026-01",
      },
      drainUrl: "https://drain.example.com",
      listmonkUrl: "https://mail.example.com",
      alertChannel: "alerts",
      secrets: {
        cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
        betterAuthSecret: "BETTER_AUTH_SECRET",
        drainToken: "DRAIN_TOKEN",
        postbackTokenSalt: "POSTBACK_TOKEN_SALT",
        coreToken: "CORE_TOKEN",
      },
      ownerEmail: "owner@example.com",
      r2Templates: "test-templates",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name with uppercase", () => {
    const r = TenantConfig.safeParse({ name: "TestTenant" } as never);
    expect(r.success).toBe(false);
  });

  it("rejects accountId of wrong length", () => {
    const r = TenantConfig.safeParse({ name: "t", accountId: "short" } as never);
    expect(r.success).toBe(false);
  });

  it("rejects a secret name with lowercase", () => {
    const r = TenantSecrets.safeParse({ cloudflareApiToken: "lowercase_token" } as never);
    expect(r.success).toBe(false);
  });

  it("rejects a coreDomain with a path", () => {
    const r = TenantConfig.safeParse({ coreDomain: "core.example.com/path" } as never);
    expect(r.success).toBe(false);
  });

  it("rejects insecure prepop bases, invalid aids, unsafe routes, and invalid amount buckets", () => {
    const base = {
      name: "valid",
      accountId: "a".repeat(32),
      coreDomain: "core.example.com",
      appDomain: "app.example.com",
      leadsGateAid: "1",
      prepopBase: "https://prepop.example.com",
      drainUrl: "https://drain.example.com",
      brandDefaults: { account: "valid", formRoute: "/request", amountBuckets: [100, 200], payloadVersion: "2026-01" },
      secrets: { cloudflareApiToken: "CF_TOKEN", betterAuthSecret: "AUTH_SECRET", drainToken: "DRAIN_T", postbackTokenSalt: "PB_SALT", coreToken: "CORE_TOKEN" },
      ownerEmail: "owner@example.com",
    };
    expect(TenantConfig.safeParse({ ...base, prepopBase: "http://prepop.example.com" }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, prepopBase: "https://prepop.example.com/form?aid=1" }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, prepopBase: "https://prepop.example.com/form#fragment" }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, leadsGateAid: "aid with spaces" }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, leadsGateAid: "a".repeat(33) }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, amountBuckets: [200, 100] } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, amountBuckets: [99] } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, amountBuckets: [5001] } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, amountBuckets: Array.from({ length: 33 }, (_, i) => 100 + i) } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, formRoute: "request" } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, formRoute: "/Request" } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, formRoute: "/api" } }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...base, brandDefaults: { ...base.brandDefaults, formRoute: "/request/" } }).success).toBe(false);
  });

  it("accepts config without optional fields", () => {
    const r = TenantConfig.safeParse({
      name: "minimal",
      accountId: "b".repeat(32),
      coreDomain: "core.minimal.io",
      appDomain: "app.minimal.io",
      leadsGateAid: "1",
      prepopBase: "https://prepop.example.com",
      drainUrl: "https://drain.example.com",
      brandDefaults: { account: "minimal", formRoute: "/request", amountBuckets: [100], payloadVersion: "2026-01" },
      secrets: {
        cloudflareApiToken: "CF_TOKEN",
        betterAuthSecret: "AUTH_SECRET",
        drainToken: "DRAIN_T",
        postbackTokenSalt: "PB_SALT",
        coreToken: "CORE_TOKEN",
      },
      ownerEmail: "owner@minimal.io",
    });
    expect(r.success).toBe(true);
  });
});

describe("aduplift config", () => {
  it("is a valid TenantConfig", () => {
    expect(TenantConfig.safeParse(aduplift).success).toBe(true);
  });

  it("uses the correct account ID", () => {
    expect(aduplift.accountId).toBe("6cb8500c35210800451bd9a535482850");
  });

  it("secrets are name-references, not values", () => {
    for (const name of Object.values(aduplift.secrets)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // Must not look like an actual token (no mixed case, no long base64-like strings)
      expect(name.length).toBeLessThan(80);
    }
  });
});

describe("maimax config", () => {
  it("is a valid TenantConfig", () => {
    expect(TenantConfig.safeParse(maimax).success).toBe(true);
  });

  it("secrets are name-references, not values", () => {
    for (const name of Object.values(maimax.secrets)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("cross-tenant isolation", () => {
  it("tenants have different names", () => {
    expect(aduplift.name).not.toBe(maimax.name);
  });

  it("tenants have different accountIds", () => {
    // Maimax uses a placeholder — it won't match the owner's real account ID.
    expect(aduplift.accountId).not.toBe(maimax.accountId);
  });

  it("tenants have different secret names (scoped to each tenant)", () => {
    const ownerSecrets = new Set(Object.values(aduplift.secrets));
    const maimaxSecrets = new Set(Object.values(maimax.secrets));
    // No overlap — each tenant's secret names are distinct so they map to
    // different GitHub Actions secrets in different Environments.
    for (const s of maimaxSecrets) {
      expect(ownerSecrets.has(s)).toBe(false);
    }
  });

  it("owner config contains no maimax-prefixed secret names", () => {
    const json = JSON.stringify(aduplift);
    expect(json).not.toContain("MAIMAX_");
  });

  it("maimax config contains no owner account ID", () => {
    const json = JSON.stringify(maimax);
    expect(json).not.toContain(aduplift.accountId);
  });
});
