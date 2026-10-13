import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLifecycle, LifecycleDetail } from "../src/client/screens/BrandLifecycle";
import { isCurrentOperationResult, isCurrentRefresh, lifecycleMutationAvailability, reduceLifecycleState, shouldPollLifecycle, shouldRecoverAcceptedInstall, type LifecycleEvent } from "../src/client/lifecycle-state";

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

  it("rejects a refresh response from before a brand switch", () => {
    expect(isCurrentRefresh("brand-a", 3, "brand-b", 4)).toBe(false);
    expect(isCurrentRefresh("brand-a", 3, "brand-a", 3)).toBe(true);
  });

  it.each(["draft", "live", "failed"] as const)("hides every mutation for an active %s operation", (brandStatus) => {
    expect(lifecycleMutationAvailability(brandStatus, "queued")).toEqual({ install: false, rollback: false, retry: false, recover: false });
    expect(lifecycleMutationAvailability(brandStatus, "running")).toEqual({ install: false, rollback: false, retry: false, recover: false });
  });

  it("hides every mutation while an accepted dispatch is waiting for delayed install detail", async () => {
    let releaseDetail!: () => void;
    const delayedDetail = new Promise<void>((resolve) => { releaseDetail = resolve; });
    const accepted = true;
    expect(accepted).toBe(true);
    expect(lifecycleMutationAvailability("draft", undefined, accepted)).toEqual({ install: false, rollback: false, retry: false, recover: false });
    releaseDetail();
    await delayedDetail;
    expect(lifecycleMutationAvailability("draft", "ready", false)).toEqual({ install: true, rollback: false, retry: false, recover: false });
  });

  it("keeps an accepted install recoverable after the first detail read fails", async () => {
    const pending = "ins-accepted";
    const running = reduceLifecycleState(undefined, { type: "install", install: {
      install_id: pending, brand_id: "brand-a", revision_id: "rev-1", status: "running", runtime_sync_status: "running", receipts: [],
    }});
    const terminal = { ...running.install!, status: "ready" as const, runtime_sync_status: "ready" as const };
    let reads = 0;
    const readDetail = async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient detail failure");
      return terminal;
    };
    await expect(readDetail()).rejects.toThrow("transient detail failure");
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-a", undefined, undefined)).toBe(true);
    const recovered = await readDetail();
    expect(recovered.status).toBe("ready");
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-a", recovered, reduceLifecycleState(running, { type: "install", install: recovered }))).toBe(false);
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-a", running.install, running)).toBe(true);
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-a", terminal, reduceLifecycleState(running, { type: "install", install: terminal }))).toBe(false);
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-a", { ...terminal, install_id: "old-terminal" }, running)).toBe(true);
    expect(shouldRecoverAcceptedInstall("brand-a", pending, "brand-b", undefined, undefined)).toBe(false);
  });
});

describe("BrandLifecycle SSR", () => {
  it("renders Thai labels with technical terms, receipts, checklist, and owner upgrade controls", () => {
    const html = renderToStaticMarkup(<BrandLifecycle me={{ id: "owner", email: "owner@example.test", role: "owner" }} />);
    expect(html).toContain("สร้างแบรนด์");
    expect(html).toContain("ชื่อแบรนด์ (Brand name)");
    expect(html).toContain("โดเมน (Domain)");
    expect(html).toContain("คีย์เวิร์ด (Keyword)");
    expect(html).toContain("เวอร์ชันเทมเพลต (Sealed template version)");
    expect(html).toContain("การทำงาน (Actions): Install · Rollback · Retry · Recover · Test sold");
    expect(html).toContain("อัปเกรดทุกแบรนด์ (Upgrade-all, Owner เท่านั้น)");
    expect(html).toContain("อัปเกรดแบบ canary ก่อน");
    expect(html.match(/Create draft/g)).toHaveLength(1);
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
      leadId="" onLeadIdChange={() => undefined} onInstall={() => undefined} onRollback={() => undefined} onRedeploy={() => undefined} onRetry={() => undefined} onRecover={() => undefined} onChecklist={() => undefined}
    />);
    expect(html).toContain("lead_id");
    expect(html).toContain("หลักฐาน:");
    expect(html).toContain("รายการตรวจ (Checklist)");
  });

  const detailHtml = (versions: { bundle_form_version: string | null; payload_version: string | null }, status: "draft" | "live" = "draft") => renderToStaticMarkup(<LifecycleDetail
    me={{ id: "employee", email: "employee@example.test", role: "employee" }}
    brand={{ brand_id: "brand-a", account: "account-a", hostnames: ["brand-a.example"], status, current_revision_id: null, runtime_sync_status: "queued", ...versions }}
    checklist={{}} leadId="" onLeadIdChange={() => undefined} onInstall={() => undefined} onRollback={() => undefined} onRedeploy={() => undefined} onRetry={() => undefined} onRecover={() => undefined} onChecklist={() => undefined}
  />);
  const installButton = (html: string) => html.match(/<button[^>]*>ติดตั้ง \(Install\)<\/button>/)?.[0];
  const note = "ติดตั้งไม่ได้: แบรนด์นี้ยังไม่มี form artifact ที่ยืนยันแล้ว";

  it.each([
    ["form version", { bundle_form_version: null, payload_version: "2026-01" }],
    ["payload version", { bundle_form_version: "form@bundle-1", payload_version: null }],
    ["both versions", { bundle_form_version: null, payload_version: null }],
  ])("disables Install and explains why when the %s is missing", (_, versions) => {
    const html = detailHtml(versions);
    expect(installButton(html)).toContain("disabled");
    expect(html).toContain(`<p class="muted small" role="note">${note}</p>`);
  });

  it("enables Install without a note when form and payload versions are both set", () => {
    const html = detailHtml({ bundle_form_version: "form@bundle-1", payload_version: "2026-01" });
    expect(installButton(html)).toBeDefined();
    expect(installButton(html)).not.toContain("disabled");
    expect(html).not.toContain(note);
  });

  it("does not show the Install note when Install is not offered", () => {
    expect(detailHtml({ bundle_form_version: null, payload_version: null }, "live")).not.toContain(note);
  });
});

 it.each(["owner", "employee"] as const)("Recover is visible only to Owner (%s)", (role) => {
   const html = renderToStaticMarkup(<LifecycleDetail
     me={{ id: role, email: `${role}@example.test`, role }}
     brand={{ brand_id: "b", account: "a", hostnames: ["brand.example"], status: "installing", current_revision_id: null, bundle_form_version: null, payload_version: null, runtime_sync_status: "failed" }}
     install={{ install_id: "i", brand_id: "b", revision_id: null, status: "failed", runtime_sync_status: "failed", receipts: [], recovery_required: true }}
     checklist={{}} leadId="" onLeadIdChange={() => {}} onInstall={() => {}} onRollback={() => {}} onRedeploy={() => {}} onRetry={() => {}} onRecover={() => {}} onChecklist={() => {}}
   />);
   expect(html.includes("กู้คืน (Recover, Owner)")).toBe(role === "owner");
   expect(html).not.toContain(">ลองใหม่ (Retry)<");
 });

 it("splits Retry and Recover on recovery evidence, not on the retained brand status", () => {
   // A failed manual rollback leaves the brand installing before its evidence is read.
   expect(lifecycleMutationAvailability("installing", "failed", false, false)).toEqual({ install: false, rollback: false, retry: true, recover: false });
   expect(lifecycleMutationAvailability("installing", "failed", false, true)).toEqual({ install: false, rollback: false, retry: false, recover: true });
   expect(lifecycleMutationAvailability("failed", "failed", false, false)).toEqual({ install: true, rollback: true, retry: true, recover: false });
   expect(lifecycleMutationAvailability("installing", "failed", true, true)).toEqual({ install: false, rollback: false, retry: false, recover: false });
 });
