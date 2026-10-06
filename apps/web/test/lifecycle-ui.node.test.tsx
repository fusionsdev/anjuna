import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { reduceLifecycleState, type LifecycleEvent } from "../src/client/lifecycle-state";

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
});
