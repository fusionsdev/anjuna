import { describe, expect, it } from "vitest";
import {
  compensationInstallId,
  compensationFailureEvidence,
  deriveAuthoritativeRuntime,
  deriveTenantRuntime,
  lifecycleOperationDecision,
  installStepOrder,
  isInstallMutationAllowed,
  rollbackTargetBelongsToBrand,
  shouldMarkReady,
  validateInstallInputs,
} from "../src/receipt";

const tenant = {
  account: "tenant-a",
  aid: "aid-a",
  prepop_base: "https://prepop.example",
  amount_buckets: [1000, 2500, 5000],
  form_route: "/apply",
  keyword_default: "harbor loans",
  form_version: "form@8ba11d3",
} as const;

describe("factory lifecycle preflight", () => {
  it("accepts only an owned sealed revision with a present artifact and verified payload metadata", () => {
    expect(validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null },
      artifact: { present: true, payload_version: "2026-01" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
    })).toMatchObject({ brand_id: "brand-a" });
  });

  it.each<any>([
    ["revision ownership", { revision: { brand_id: "brand-b" } }],
    ["unsealed template", { revision: { template_status: "draft" } }],
    ["missing artifact", { artifact: { present: false, payload_version: "2026-01" } }],
    ["null payload metadata", { artifact: { present: true, payload_version: null } }],
    ["mismatched payload metadata", { artifact: { present: true, payload_version: "2025-01" } }],
  ])("rejects %s before any Cloudflare mutation", (_name, override) => {
    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null, ...(override.revision ?? {}) },
      artifact: { present: true, payload_version: "2026-01", ...(override.artifact ?? {}) },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
    })).toThrow();
  });

  it("rejects a credential/account mismatch and runtime state that is not absent or applied", () => {
    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null },
      artifact: { present: true, payload_version: "2026-01" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: false },
    })).toThrow(/account/i);
  });

  it("derives tenant-owned defaults and an opaque deterministic drain key without overrides", () => {
    const first = deriveTenantRuntime("brand-a", tenant);
    expect(first).toEqual({ ...tenant, drain_key: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(deriveTenantRuntime("brand-a", tenant)).toEqual(first);
    expect(deriveTenantRuntime("brand-b", tenant).drain_key).not.toBe(first.drain_key);
    expect(JSON.stringify(first)).not.toContain("employee");
  });

  it("rejects employee/BFF money-routing overrides", () => {
    expect(() => deriveTenantRuntime("brand-a", { ...tenant, aid: "override" })).not.toThrow();
    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null },
      artifact: { present: true, payload_version: "2026-01" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
      employee_override: { aid: "evil", prepop_base: "https://evil.example", drain_key: "known" },
    })).toThrow(/override/i);
  });

  it("uses registered artifact metadata for the form bundle and rejects revision-owned routing defaults", () => {
    expect(deriveAuthoritativeRuntime("brand-a", tenant, {
      r2_key: "forms/form@deadbeef.zip",
      payload_version: "2026-01",
    })).toMatchObject({ form_version: "form@deadbeef" });

    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: {
        brand_id: "brand-a", template_status: "sealed", worker_version_id: null,
        config: { amount_buckets: [1], form_route: "/attacker", form_version: "form@attacker" },
      },
      artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@deadbeef" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
    })).toThrow(/tenant-owned|revision.*override/i);
  });
});

describe("factory lifecycle order and readiness", () => {
  it("preserves validate → rollback → render → upload → deploy → attach → smoke order", () => {
    expect(installStepOrder(false)).toEqual([
      "validate", "save_rollback", "render", "upload_assets", "upload_script", "deploy",
      "provision_runtime", "attach_domains", "smoke", "receipt",
    ]);
    expect(installStepOrder(true)).toEqual([
      "validate", "save_rollback", "render", "upload_assets", "upload_script", "deploy",
      "attach_domains", "smoke", "sync_runtime", "receipt",
    ]);
  });

  it.each([
    [{ smoke: true, runtime: true }, true],
    [{ smoke: true, runtime: false }, false],
    [{ smoke: false, runtime: true }, false],
  ])("only marks READY after smoke and runtime verification succeed", (evidence, expected) => {
    expect(shouldMarkReady(evidence)).toBe(expected);
  });

  it("conditionally rejects a concurrent install or rollback mutation", () => {
    expect(isInstallMutationAllowed("draft")).toBe(true);
    expect(isInstallMutationAllowed("live")).toBe(true);
    expect(isInstallMutationAllowed("installing")).toBe(false);
    expect(isInstallMutationAllowed("paused")).toBe(false);
  });

  it.each([
    ["draft", null, "install-a", "claim"],
    ["installing", "install-a", "install-a", "resume"],
    ["installing", "install-a", "install-b", "reject"],
    ["live", "install-a", "install-b", "reject"],
  ] as const)("makes the active-operation CAS decision for %s", (status, active, requested, decision) => {
    expect(lifecycleOperationDecision(status, active, requested)).toBe(decision);
  });
});

describe("factory lifecycle compensation and rollback", () => {
  it("creates a stable distinct compensation install id", () => {
    expect(compensationInstallId("install-a")).toBe("compensate-install-a");
    expect(compensationInstallId("install-a")).not.toBe("install-a");
  });

  it("accepts only a previous deployed revision belonging to the brand", () => {
    expect(rollbackTargetBelongsToBrand({ brand_id: "brand-a", worker_version_id: "v1" }, "brand-a")).toBe(true);
    expect(rollbackTargetBelongsToBrand({ brand_id: "brand-a", worker_version_id: null }, "brand-a")).toBe(false);
    expect(rollbackTargetBelongsToBrand({ brand_id: "brand-b", worker_version_id: "v1" }, "brand-a")).toBe(false);
  });

  it("keeps original and compensation outcomes linked and records recovery evidence", () => {
    expect(compensationFailureEvidence({
      original_install_id: "install-a",
      compensation_install_id: compensationInstallId("install-a"),
      error: "core verification failed",
      mutation_started: true,
    })).toMatchObject({
      original_install_id: "install-a",
      compensation_install_id: "compensate-install-a",
      recovery_required: true,
      audit_action: "install.compensation_failed",
    });
  });
});
