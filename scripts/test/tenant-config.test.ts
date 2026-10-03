import { describe, expect, it } from "vitest";
import { TenantConfig, TenantSecrets } from "@anjuna/tenants/schema";
import aduplift from "@anjuna/tenants/aduplift.config";
import friend from "@anjuna/tenants/friend.config";

describe("TenantConfig schema", () => {
  it("accepts a valid full config", () => {
    const result = TenantConfig.safeParse({
      name: "test-tenant",
      accountId: "a".repeat(32),
      coreDomain: "core.example.com",
      appDomain: "app.example.com",
      leadsGateAid: "99999",
      prepopBase: "https://go.example.com/aff_c",
      drainUrl: "https://drain.example.com",
      listmonkUrl: "https://mail.example.com",
      alertChannel: "alerts",
      secrets: {
        cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
        betterAuthSecret: "BETTER_AUTH_SECRET",
        drainToken: "DRAIN_TOKEN",
        postbackTokenSalt: "POSTBACK_TOKEN_SALT",
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

  it("accepts config without optional fields", () => {
    const r = TenantConfig.safeParse({
      name: "minimal",
      accountId: "b".repeat(32),
      coreDomain: "core.minimal.io",
      appDomain: "app.minimal.io",
      leadsGateAid: "1",
      prepopBase: "https://prepop.example.com",
      drainUrl: "https://drain.example.com",
      secrets: {
        cloudflareApiToken: "CF_TOKEN",
        betterAuthSecret: "AUTH_SECRET",
        drainToken: "DRAIN_T",
        postbackTokenSalt: "PB_SALT",
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

describe("friend config", () => {
  it("is a valid TenantConfig", () => {
    expect(TenantConfig.safeParse(friend).success).toBe(true);
  });

  it("secrets are name-references, not values", () => {
    for (const name of Object.values(friend.secrets)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("cross-tenant isolation", () => {
  it("tenants have different names", () => {
    expect(aduplift.name).not.toBe(friend.name);
  });

  it("tenants have different accountIds", () => {
    // Friend uses a placeholder — it won't match the owner's real account ID.
    expect(aduplift.accountId).not.toBe(friend.accountId);
  });

  it("tenants have different secret names (scoped to each tenant)", () => {
    const ownerSecrets = new Set(Object.values(aduplift.secrets));
    const friendSecrets = new Set(Object.values(friend.secrets));
    // No overlap — each tenant's secret names are distinct so they map to
    // different GitHub Actions secrets in different Environments.
    for (const s of friendSecrets) {
      expect(ownerSecrets.has(s)).toBe(false);
    }
  });

  it("owner config contains no friend-prefixed secret names", () => {
    const json = JSON.stringify(aduplift);
    expect(json).not.toContain("FRIEND_");
  });

  it("friend config contains no owner account ID", () => {
    const json = JSON.stringify(friend);
    expect(json).not.toContain(aduplift.accountId);
  });
});
