import { describe, expect, it } from "vitest";
import {
  ApplyRuntimeRequest,
  ApplyRuntimeResponse,
  BackfillPayloadVersionRequest,
  ChecklistEvidence,
  ChecklistItemName,
  CreateBrandDraftRequest,
  InstallBrandCommand,
  InstallWithReceipts,
  LifecycleBrandSummary,
  RegisterFormArtifactRequest,
  RollbackBrandCommand,
  RuntimeStateRequest,
  RuntimeStateResponse,
  UpgradeAllCommand,
  VerifySoldLeadRequest,
  VerifySoldLeadResponse,
} from "../src/index.js";

const ids = {
  brand_id: "brand-a",
  account: "tenant-a",
  revision_id: "rev-1",
  install_id: "install-1",
  actor_id: "user-1",
};

const initial_runtime = {
  drain_key: "brand-a",
  aid: "aid-a",
  prepop_base: "https://leads.example.test/prepop",
  amount_buckets: [100, 250, 500],
  form_route: "/apply",
  keyword_default: "Solar Panels",
  form_version: "form@8ba11d3",
};
const apply_ids = {
  install_id: ids.install_id,
  brand_id: ids.brand_id,
  account: ids.account,
  actor_id: ids.actor_id,
};

describe("lifecycle wire contracts", () => {
  it("accepts the command and response goldens", () => {
    expect(
      RegisterFormArtifactRequest.safeParse({
        form_artifact_id: "form-artifact-1",
        template_version_id: "template-v1",
        git_sha: "8ba11d3",
        bundle_form_version: "form@8ba11d3",
        payload_version: "2026-01",
      }).success,
    ).toBe(true);
    expect(
      BackfillPayloadVersionRequest.safeParse({
        form_artifact_id: "legacy-form-1",
        payload_version: "2026-01",
      }).success,
    ).toBe(true);
    expect(CreateBrandDraftRequest.safeParse({
      brand_id: ids.brand_id,
      account: ids.account,
      hostname: "www.example.com",
      keyword_default: "Solar Panels",
      template_version_id: "template-v1",
    }).success).toBe(true);
    expect(InstallBrandCommand.safeParse({
      install_id: ids.install_id,
      brand_id: ids.brand_id,
      revision_id: ids.revision_id,
      started_by: ids.actor_id,
      started_role: "employee",
    }).success).toBe(true);
    expect(RollbackBrandCommand.safeParse({
      install_id: "rollback-1",
      brand_id: ids.brand_id,
      to_revision_id: "rev-0",
      started_by: ids.actor_id,
      started_role: "employee",
    }).success).toBe(true);
    expect(UpgradeAllCommand.safeParse({
      from_template_version_id: "template-v1",
      to_template_version_id: "template-v2",
      form_artifact_id: "form-artifact-2",
      canary_brand_id: ids.brand_id,
      started_by: ids.actor_id,
      started_role: "owner",
    }).success).toBe(true);

    expect(ApplyRuntimeRequest.safeParse({
      ...apply_ids,
      hostnames: ["example.com", "www.example.com"],
      expected_revision_id: null,
      target_revision_id: ids.revision_id,
      actor_role: "employee",
      initial_runtime,
    }).success).toBe(true);
    expect(ApplyRuntimeResponse.safeParse({
      state: "applied",
      install_id: ids.install_id,
      applied_revision_id: ids.revision_id,
      paused: false,
    }).success).toBe(true);
    expect(RuntimeStateRequest.safeParse({ brand_id: ids.brand_id, account: ids.account }).success).toBe(true);
    expect(RuntimeStateResponse.safeParse({
      state: "applied",
      brand_id: ids.brand_id,
      account: ids.account,
      applied_revision_id: ids.revision_id,
      last_lifecycle_install_id: ids.install_id,
      paused: false,
      bundle_form_version: "form@8ba11d3",
      credential_account_match: true,
    }).success).toBe(true);
    expect(VerifySoldLeadRequest.safeParse({
      brand_id: ids.brand_id,
      lead_id: "lead-1",
    }).success).toBe(true);
    expect(VerifySoldLeadResponse.safeParse({
      verified: true,
      event_id: "event-1",
      event_at: "2026-10-06T00:00:00.000Z",
    }).success).toBe(true);
    expect(ChecklistItemName.safeParse("test_sold").success).toBe(true);
    expect(ChecklistEvidence.safeParse({
      brand_id: ids.brand_id,
      item: "test_sold",
      actor_id: ids.actor_id,
      verified_at: "2026-10-06T00:00:00.000Z",
      event_id: "event-1",
    }).success).toBe(true);
    expect(InstallWithReceipts.safeParse({
      install_id: ids.install_id,
      brand_id: ids.brand_id,
      revision_id: ids.revision_id,
      status: "ready",
      runtime_sync_status: "ready",
      receipts: [],
    }).success).toBe(true);
    expect(LifecycleBrandSummary.safeParse({
      brand_id: ids.brand_id,
      account: ids.account,
      hostnames: ["example.com", "www.example.com"],
      status: "live",
      current_revision_id: ids.revision_id,
      runtime_sync_status: "ready",
      bundle_form_version: "form@8ba11d3",
      payload_version: "2026-01",
    }).success).toBe(true);
  });

  it("requires payload metadata when registering an artifact", () => {
    expect(RegisterFormArtifactRequest.safeParse({
      form_artifact_id: "form-artifact-1",
      template_version_id: "template-v1",
      git_sha: "8ba11d3",
      bundle_form_version: "form@8ba11d3",
    }).success).toBe(false);
  });

  it("rejects overwriting an already set payload version", () => {
    expect(BackfillPayloadVersionRequest.safeParse({
      form_artifact_id: "legacy-form-1",
      payload_version: null,
    }).success).toBe(false);
  });

  it("rejects missing revisions and invalid lifecycle statuses", () => {
    expect(InstallBrandCommand.safeParse({
      install_id: ids.install_id,
      brand_id: ids.brand_id,
      started_by: ids.actor_id,
      started_role: "employee",
    }).success).toBe(false);
    expect(InstallWithReceipts.safeParse({
      install_id: ids.install_id,
      brand_id: ids.brand_id,
      revision_id: ids.revision_id,
      status: "queued",
      runtime_sync_status: "unknown",
      receipts: [],
    }).success).toBe(false);
  });

  it("rejects equal upgrade versions and non-Owner upgrade initiators", () => {
    const command = {
      from_template_version_id: "template-v1",
      to_template_version_id: "template-v1",
      form_artifact_id: "form-artifact-2",
      canary_brand_id: ids.brand_id,
      started_by: ids.actor_id,
      started_role: "owner",
    };
    expect(UpgradeAllCommand.safeParse(command).success).toBe(false);
    expect(UpgradeAllCommand.safeParse({ ...command, to_template_version_id: "template-v2", started_role: "employee" }).success).toBe(false);
  });

  it("rejects unknown checklist names", () => {
    expect(ChecklistItemName.safeParse("arbitrary_checkbox").success).toBe(false);
    expect(ChecklistEvidence.safeParse({
      brand_id: ids.brand_id,
      item: "arbitrary_checkbox",
      actor_id: ids.actor_id,
      verified_at: "2026-10-06T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("rejects secret and token fields from lifecycle payloads", () => {
    expect(ApplyRuntimeRequest.safeParse({
      ...apply_ids,
      hostnames: ["example.com"],
      expected_revision_id: null,
      target_revision_id: ids.revision_id,
      actor_role: "employee",
      initial_runtime: { ...initial_runtime, postback_token: "secret" },
    }).success).toBe(false);
    expect(RuntimeStateResponse.safeParse({
      state: "applied",
      brand_id: ids.brand_id,
      account: ids.account,
      applied_revision_id: ids.revision_id,
      last_lifecycle_install_id: ids.install_id,
      paused: false,
      bundle_form_version: "form@8ba11d3",
      credential_account_match: true,
      core_token: "secret",
    }).success).toBe(false);
    expect(ChecklistEvidence.safeParse({
      brand_id: ids.brand_id,
      item: "drain_route",
      actor_id: ids.actor_id,
      verified_at: "2026-10-06T00:00:00.000Z",
      postback_token: "secret",
    }).success).toBe(false);
  });

  it("keeps bundle identity distinct from lead payload version", () => {
    const artifact = RegisterFormArtifactRequest.parse({
      form_artifact_id: "form-artifact-1",
      template_version_id: "template-v1",
      git_sha: "8ba11d3",
      bundle_form_version: "form@8ba11d3",
      payload_version: "2026-01",
    });
    expect(artifact.bundle_form_version).not.toBe(artifact.payload_version);
    expect(LifecycleBrandSummary.safeParse({
      brand_id: ids.brand_id,
      account: ids.account,
      hostnames: ["example.com"],
      status: "live",
      current_revision_id: ids.revision_id,
      runtime_sync_status: "ready",
      bundle_form_version: artifact.bundle_form_version,
      payload_version: artifact.payload_version,
    }).success).toBe(true);
  });
});
