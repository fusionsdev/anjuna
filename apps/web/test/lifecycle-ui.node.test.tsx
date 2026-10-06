import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLifecycle, LifecycleDetail } from "../src/client/screens/BrandLifecycle";
import { isCurrentOperationResult, reduceLifecycleState, shouldPollLifecycle, type LifecycleEvent } from "../src/client/lifecycle-state";

describe("lifecycle state reducer", () => {
  it("keeps lifecycle status separate from runtime sync and preserves retry/compensation evidence", () => {
    const state = reduceLifecycleState(undefined, {
      type: "brand",
      brand: {
        brand_id: "brand-a", account: "account-a", hostnames: ["brand-a.example"],
        status: "failed", current_revision_id: "rev-2", runtime_sync_status: "sync_error",
        bundle_form_version: "form@bundle-1", payload_version: "2026-01",
      },
    } satisfies LifecycleEvent);
    const next = reduceLifecycleState(state, { type: "install", install: {
      install_id: "ins-1", brand_id: "brand-a", revision_id: "rev-2", status: "failed",
      runtime_sync_status: "failed", receipts: [{ step: "smoke", status: "failed", error: "smoke failed" }],
    }});
    const retry = reduceLifecycleState(next, { type: "retry", install_id: "ins-1", compensation_install_id: "comp-ins-1" });
    expect(retry.lifecycle_status).toBe("failed");
    expect(retry.runtime_sync_status).toBe("sync_error");
    expect(retry.install?.receipts[0]?.error).toBe("smoke failed");
    expect(retry.retry_install_id).toBe("ins-1");
    expect(retry.compensation_install_id).toBe("comp-ins-1");
    expect(retry.operation_status).toBe("retry");
    expect(reduceLifecycleState(retry, { type: "compensation", install_id: "comp-ins-1" }).operation_status).toBe("compensation");
  });

  it.each(["draft", "queued", "running", "ready", "failed", "rolled_back", "detached", "unmanaged", "sync_error"] as const)(
    "represents %s as a stable lifecycle state",
    (status) => expect(reduceLifecycleState(undefined, { type: "status", status }).lifecycle_status).toBe(status),
  );

  it("maps installing to an active running UI state", () => {
    const state = reduceLifecycleState(undefined, {
      type: "brand",
      brand: {
        brand_id: "brand-a", account: "account-a", hostnames: ["brand-a.example"],
        status: "installing", current_revision_id: "rev-1", runtime_sync_status: "running",
        bundle_form_version: "form@bundle-1", payload_version: "2026-01",
      },
    });
    expect(state.lifecycle_status).toBe("running");
  });

  it.each(["ready", "failed", "rolled_back"] as const)("does not poll a terminal install (%s)", (status) => {
    expect(shouldPollLifecycle({
      lifecycle_status: "running", runtime_sync_status: "running",
      install: { install_id: "i", brand_id: "b", revision_id: "r", status, runtime_sync_status: "ready", receipts: [] },
    })).toBe(false);
  });

  it("polls only from the authoritative queued/running install detail", () => {
    expect(shouldPollLifecycle({
      lifecycle_status: "ready", runtime_sync_status: "queued",
      install: { install_id: "i", brand_id: "b", revision_id: "r", status: "queued", runtime_sync_status: "queued", receipts: [] },
    })).toBe(true);
    expect(shouldPollLifecycle({
      lifecycle_status: "ready", runtime_sync_status: "queued",
      install: { install_id: "i", brand_id: "b", revision_id: "r", status: "ready", runtime_sync_status: "ready", receipts: [] },
    })).toBe(false);
  });

  it("puts rollback details into the authoritative polling state", () => {
    const rollback = { install_id: "rollback-1", brand_id: "brand-a", revision_id: "rev-1", status: "running" as const, runtime_sync_status: "running" as const, receipts: [] };
    const state = reduceLifecycleState(undefined, { type: "install", install: rollback });
    expect(state.install?.install_id).toBe("rollback-1");
    expect(shouldPollLifecycle(state)).toBe(true);
    expect(shouldPollLifecycle(reduceLifecycleState(state, { type: "install", install: { ...rollback, status: "rolled_back" as const, runtime_sync_status: "ready" as const } }))).toBe(false);
  });

  it("rejects late operation results after a brand switch or brand mismatch", () => {
    expect(isCurrentOperationResult("brand-a", 3, "brand-b", 4, "brand-a")).toBe(false);
    expect(isCurrentOperationResult("brand-a", 3, "brand-a", 3, "brand-b")).toBe(false);
    expect(isCurrentOperationResult("brand-a", 3, "brand-a", 3, "brand-a")).toBe(true);
  });
});

describe("BrandLifecycle SSR", () => {
  it("renders Thai labels with technical terms, receipts, checklist, and owner upgrade controls", () => {
    const html = renderToStaticMarkup(<BrandLifecycle me={{ id: "owner", email: "owner@example.test", role: "owner" }} />);
    expect(html).toContain("สร้างแบรนด์");
    expect(html).toContain("Domain");
    expect(html).toContain("Keyword");
    expect(html).toContain("Install");
    expect(html).toContain("Rollback");
    expect(html).toContain("Retry");
    expect(html).toContain("Test sold");
    expect(html).toContain("Upgrade-all");
  });

  it("does not render upgrade-all for employees", () => {
    const html = renderToStaticMarkup(<BrandLifecycle me={{ id: "employee", email: "employee@example.test", role: "employee" }} />);
    expect(html).not.toContain("Upgrade-all");
    expect(html).toContain("สถานะ");
  });

  it("renders a lead id field for test-sold and persisted checklist evidence", () => {
    const html = renderToStaticMarkup(<LifecycleDetail
      me={{ id: "owner", email: "owner@example.test", role: "owner" }}
      brand={{ brand_id: "brand-a", account: "account-a", hostnames: ["brand-a.example"], status: "draft", current_revision_id: "rev-1", runtime_sync_status: "ready", bundle_form_version: "form@bundle-1", payload_version: "2026-01" }}
      checklist={{ drain_route: { brand_id: "brand-a", item: "drain_route", actor_id: "owner", verified_at: "2026-01-01T00:00:00Z" } }}
      leadId="" onLeadIdChange={() => undefined} onInstall={() => undefined} onRollback={() => undefined} onRetry={() => undefined} onChecklist={() => undefined}
    />);
    expect(html).toContain("lead_id");
    expect(html).toContain("Checklist evidence");
  });
});
