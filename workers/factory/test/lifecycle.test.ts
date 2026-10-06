import { describe, expect, it } from "vitest";
import * as receipt from "../src/receipt";
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
import {
  canaryGate,
  canarySleepStepName,
  upgradeInstallId,
  upgradeRevisionId,
  upgradeWorkflowId,
  selectUpgradeBrands,
  validateUpgradeSelection,
} from "../src/workflows/upgrade-all";

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
      artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@test" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
    })).toMatchObject({ brand_id: "brand-a" });
  });

  it.each<any>([
    ["revision ownership", { revision: { brand_id: "brand-b" } }],
    ["unsealed template", { revision: { template_status: "draft" } }],
    ["missing artifact", { artifact: { present: false, payload_version: "2026-01", bundle_form_version: "form@test" } }],
    ["null payload metadata", { artifact: { present: true, payload_version: null, bundle_form_version: "form@test" } }],
    ["mismatched payload metadata", { artifact: { present: true, payload_version: "2025-01", bundle_form_version: "form@test" } }],
  ])("rejects %s before any Cloudflare mutation", (_name, override) => {
    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null, ...(override.revision ?? {}) },
      artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@test", ...(override.artifact ?? {}) },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
    })).toThrow();
  });

  it("rejects a credential/account mismatch and runtime state that is not absent or applied", () => {
    expect(() => validateInstallInputs({
      brand_id: "brand-a",
      revision: { brand_id: "brand-a", template_status: "sealed", worker_version_id: null },
      artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@test" },
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
      artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@test" },
      tenant,
      runtime_state: { state: "absent", credential_account_match: true },
      employee_override: { aid: "evil", prepop_base: "https://evil.example", drain_key: "known" },
    })).toThrow(/override/i);
  });

  it("uses registered artifact metadata for the form bundle and rejects revision-owned routing defaults", () => {
    expect(deriveAuthoritativeRuntime("brand-a", tenant, {
      r2_key: "forms/opaque.zip",
      payload_version: "2026-01",
      bundle_form_version: "form@deadbeef",
    })).toMatchObject({ form_version: "form@deadbeef" });

    expect(() => deriveAuthoritativeRuntime("brand-a", tenant, {
      r2_key: "forms/form@attacker.zip",
      payload_version: "2026-01",
      bundle_form_version: null,
    })).toThrow(/registered.*bundle form version/i);

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

  it("assembles BRAND_CONFIG with tenant runtime values winning over revision JSON", () => {
    const assembleBrandConfig = (receipt as typeof receipt & { assembleBrandConfig: typeof import("../src/receipt").deriveTenantRuntime }).assembleBrandConfig;
    expect(assembleBrandConfig).toBeTypeOf("function");
    const runtime = deriveAuthoritativeRuntime("brand-a", tenant, {
      r2_key: "forms/opaque.zip",
      payload_version: "2026-01",
      bundle_form_version: "form@registered",
    });
    expect(assembleBrandConfig({
      brand: "Harbor",
      hostname: "attacker.example",
      formRoute: "/attacker",
      amount_buckets: [1],
      form_version: "form@attacker",
      aid: "attacker-aid",
    }, runtime, "brand-a.example")).toMatchObject({
      brand: "Harbor",
      hostname: "brand-a.example",
      formRoute: "/apply",
      form_route: "/apply",
      amount_buckets: [1000, 2500, 5000],
      form_version: "form@registered",
      aid: "aid-a",
      prepop_base: "https://prepop.example",
      drain_key: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
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

describe("upgrade-all", () => {
  const selection = {
    from_template_version_id: "template-v1",
    to_template_version_id: "template-v2",
    from_template: { template_id: "loan-template", status: "sealed" },
    to_template: { template_id: "loan-template", status: "sealed" },
    artifact: { present: true, payload_version: "2026-01", bundle_form_version: "form@abc" },
    canary_brand_id: "brand-a",
  } as const;

  it("rejects equal versions, unsealed or cross-family targets, and unverified payload metadata", () => {
    expect(() => validateUpgradeSelection({
      ...selection,
      to_template_version_id: selection.from_template_version_id,
    })).toThrow(/different/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      to_template: { ...selection.to_template, status: "draft" },
    })).toThrow(/sealed/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      to_template: { ...selection.to_template, template_id: "other-template" },
    })).toThrow(/family/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      artifact: { ...selection.artifact, payload_version: null },
    })).toThrow(/payload/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      artifact: { ...selection.artifact, payload_version: "2026-02" },
    })).toThrow(/payload/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      artifact: { ...selection.artifact, bundle_form_version: "form@../unsafe" },
    })).toThrow(/bundle/i);
    expect(() => validateUpgradeSelection({
      ...selection,
      artifact: { ...selection.artifact, bundle_form_version: "registered-but-not-form-version" },
    })).toThrow(/bundle/i);
  });

  it("derives every upgrade lifecycle ID deterministically from its command identity", () => {
    const input = {
      from_template_version_id: "template-v1",
      to_template_version_id: "template-v2",
      form_artifact_id: "artifact-1",
      canary_brand_id: "brand-a",
      started_by: "owner-1",
      started_role: "owner" as const,
    };
    expect(upgradeWorkflowId(input)).toBe(upgradeWorkflowId({ ...input }));
    expect(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"))
      .toBe(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"));
    expect(upgradeRevisionId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"))
      .toBe(upgradeRevisionId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"));
    expect(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"))
      .not.toBe(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-b"));
    expect(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, input.form_artifact_id, "brand-a"))
      .not.toBe(upgradeInstallId(input.from_template_version_id, input.to_template_version_id, "artifact-2", "brand-a"));
  });

  it("uses a distinct deterministic step name for every canary poll", () => {
    expect([0, 1, 2].map(canarySleepStepName)).toEqual([
      "wait_canary_0",
      "wait_canary_1",
      "wait_canary_2",
    ]);
  });

  it("selects only live source brands, requires the canary, and skips brands already on target", () => {
    expect(selectUpgradeBrands([
      { brand_id: "brand-a", status: "live", current_template_version_id: "template-v1" },
      { brand_id: "brand-b", status: "live", current_template_version_id: "template-v1" },
      { brand_id: "brand-c", status: "draft", current_template_version_id: "template-v1" },
      { brand_id: "brand-d", status: "live", current_template_version_id: "template-v2" },
    ], "template-v1", "template-v2", "brand-a")).toEqual({
      canary: "brand-a",
      remaining: ["brand-b"],
    });
    expect(() => selectUpgradeBrands([], "template-v1", "template-v2", "brand-a")).toThrow(/canary/i);
  });

  it("allows fan-out only after a canary is READY with core sync", () => {
    expect(canaryGate({ install: "ready", core: "ready" })).toBe(true);
    expect(canaryGate({ install: "ready", core: "failed" })).toBe(false);
    expect(canaryGate({ install: "failed", core: "ready" })).toBe(false);
  });

  it("uses the existing per-brand CAS lock to reject an overlapping rollback", () => {
    expect(lifecycleOperationDecision("installing", "upgrade-brand-a", "rollback-brand-a")).toBe("reject");
    expect(lifecycleOperationDecision("installing", "upgrade-brand-a", "upgrade-brand-a")).toBe("resume");
  });
});
