import type { InstallWithReceipts } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_STEP_ERROR, INSTALL_PROGRESS_STEPS, InstallProgress, installErrorMessage, stepStates } from "../src/client/components/InstallProgress";
import { LifecycleDetail } from "../src/client/screens/BrandLifecycle";

afterEach(() => cleanup());

const base: InstallWithReceipts = { install_id: "ins-1", brand_id: "brand-a", revision_id: "rev-1", operation: "install", status: "running", runtime_sync_status: "running", receipts: [] };
const ready = (steps: string[]) => steps.map((step) => ({ step, status: "ready" as const }));
const ALL = INSTALL_PROGRESS_STEPS.map((s) => s.step);

describe("InstallProgress steps", () => {
  it("covers the 11 install steps in run order", () => {
    expect(ALL).toEqual(["validate", "save_rollback", "render", "upload_assets", "upload_script", "provision_runtime", "deploy", "attach_domains", "smoke", "sync_runtime", "receipt"]);
  });

  it("marks done steps, the next step running and the rest pending", () => {
    const states = stepStates({ ...base, receipts: ready(["validate", "save_rollback", "render"]) });
    expect(states.map((s) => s.state)).toEqual(["done", "done", "done", "running", "pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
  });

  it("drops provision_runtime for a redeploy or upgrade of a live brand", () => {
    expect(stepStates({ ...base, operation: "redeploy" }).map((s) => s.step)).toEqual(ALL.filter((s) => s !== "provision_runtime"));
  });

  it("shows the bar position and Retry only when allowed", () => {
    const onRetry = vi.fn();
    const failed = { ...base, status: "failed" as const, runtime_sync_status: "failed" as const, receipts: [...ready(["validate", "save_rollback"]), { step: "render", status: "failed" as const, error: "R2 object not found: x" }] };
    const { rerender } = render(<InstallProgress install={failed} canRetry onRetry={onRetry} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("11");
    fireEvent.click(screen.getByRole("button", { name: "ลองใหม่ (Retry)" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<InstallProgress install={failed} canRetry={false} onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "ลองใหม่ (Retry)" })).toBeNull();
  });
});

describe("InstallProgress failure messages", () => {
  // One known failure text per step that can fail, as the factory writes it.
  const known: Array<[string, string, string]> = [
    ["validate", "Existing DNS records block Custom Domain attach: A brand.example", "dns_conflict"],
    ["validate", "Zone not found for domain brand.example (tried: brand.example)", "zone_missing"],
    ["validate", "Template version is not sealed", "template_not_sealed"],
    ["validate", "Form artifact payload metadata is not verified", "form_artifact"],
    ["validate", '{"error":"Error: Brand already has a lifecycle mutation in progress","actionable":"Wait"}', "lifecycle_busy"],
    ["save_rollback", "Core lifecycle request failed (503)", "core_unavailable"],
    ["render", "Brand bytes contain forbidden identity in /index.html", "forbidden_bytes"],
    ["upload_assets", "Asset upload failed: 500 internal", "cloudflare_api"],
    ["upload_script", "Upload script failed: HTTP 500: boom", "cloudflare_api"],
    ["provision_runtime", "Core lifecycle request failed (403)", "core_refused"],
    ["deploy", "Deploy failed: HTTP 502: upstream", "cloudflare_api"],
    ["attach_domains", "Attach domain failed: conflict (HTTP 409)", "cloudflare_api"],
    ["smoke", "Smoke: apex DNS resolution failed", "smoke_dns"],
    ["smoke", "Smoke: apex missing expected landing content (data-kw/data-cta)", "smoke_content"],
    ["smoke", "Smoke: apex returned 500 (expected 200; cf-ray=abc)", "smoke_status"],
    ["sync_runtime", "Mailing list: listmonk list was not created: listmonk POST list failed: 502 (502)", "mailing_list"],
    ["sync_runtime", "Core lifecycle verification failed", "core_unavailable"],
    ["receipt", "Error: Core lifecycle request failed (429)", "core_unavailable"],
  ];

  it.each(known)("%s: %s maps to %s with a Thai + English message", (step, raw, code) => {
    const result = installErrorMessage(raw);
    expect(result).toMatchObject({ code, known: true });
    expect(result.message).toMatch(/[฀-๿].*\(.+\)$/);
    const install = { ...base, status: "failed" as const, receipts: [{ step, status: "failed" as const, error: raw }] };
    render(<InstallProgress install={install} canRetry onRetry={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toBe(result.message);
    expect(screen.queryByText("รายละเอียด (Details)")).toBeNull();
  });

  it("shows a short generic line and the raw text behind a Details toggle for an unknown failure", () => {
    expect(installErrorMessage("D1_ERROR: something odd")).toEqual({ code: "unknown", message: GENERIC_STEP_ERROR, known: false });
    const install = { ...base, status: "failed" as const, receipts: [{ step: "receipt", status: "failed" as const, error: "D1_ERROR: something odd" }] };
    render(<InstallProgress install={install} canRetry onRetry={() => undefined} />);
    expect(screen.getByText(GENERIC_STEP_ERROR)).toBeDefined();
    const details = screen.getByText("รายละเอียด (Details)").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("D1_ERROR: something odd");
  });
});

describe("BrandLifecycle detail", () => {
  const brand = { brand_id: "brand-a", account: "a", hostnames: ["brand.example"], status: "failed" as const, current_revision_id: null, bundle_form_version: "form@1", payload_version: "2026-01", runtime_sync_status: "failed" as const };
  const owner = { id: "o", email: "o@example.test", role: "owner" as const };

  it("renders InstallProgress with Retry for a failed install", () => {
    const onRetry = vi.fn();
    const install = { ...base, status: "failed" as const, receipts: [{ step: "smoke", status: "failed" as const, error: "Smoke: apex DNS resolution failed" }] };
    render(<LifecycleDetail me={owner} brand={brand} install={install} checklist={{}} leadId="" onLeadIdChange={() => undefined} onInstall={() => undefined} onRollback={() => undefined} onRedeploy={() => undefined} onRetry={onRetry} onRecover={() => undefined} onChecklist={() => undefined} />);
    expect(screen.getByRole("progressbar")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "ลองใหม่ (Retry)" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "ลองใหม่ (Retry)" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("leaves exactly one manual checklist action: Confirm test sold", () => {
    const onChecklist = vi.fn();
    render(<LifecycleDetail me={owner} brand={brand} checklist={{}} leadId="lead-1" onLeadIdChange={() => undefined} onInstall={() => undefined} onRollback={() => undefined} onRedeploy={() => undefined} onRetry={() => undefined} onRecover={() => undefined} onChecklist={onChecklist} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    expect(boxes.filter((box) => !box.disabled)).toHaveLength(1);
    const sold = screen.getByLabelText(/Confirm test sold/) as HTMLInputElement;
    expect(sold.disabled).toBe(false);
    fireEvent.click(sold);
    expect(onChecklist).toHaveBeenCalledWith("test_sold", "lead-1");
    expect(screen.getByText(/Automatic when the install smoke test passes/)).toBeDefined();
  });
});
