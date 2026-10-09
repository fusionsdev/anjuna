import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatestUpgradeResponse } from "@anjuna/contracts";
import { UpgradeOutcomes } from "../src/client/screens/UpgradeOutcomes";

const result: LatestUpgradeResponse = { upgrade: {
  audit_id: 1, accepted_at: "2026-10-09T00:00:00Z",
  command: { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-0", started_by: "owner", started_role: "owner" },
  outcomes: (["running", "ready", "failed", "rolled_back", "skipped"] as const).map((status, i) => ({
    brand_id: `brand-${i}`, domain: `brand-${i}.test`, is_canary: i === 0,
    install_id: i === 4 ? null : `install-${i}`, retry_of: i === 1 ? "upgrade-install-1" : null,
    status, error: i === 2 ? "Smoke check failed" : null,
  })),
} };
const response = (value: unknown) => Response.json(value);
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("upgrade-all outcomes", () => {
  it("renders every brand, the canary marker, terminal outcomes and errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(result)));
    render(<UpgradeOutcomes refresh={0} />);
    await screen.findByText("brand-0.test");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    for (const [index, status] of ["running", "ready", "failed", "rolled back", "skipped"].entries()) {
      expect(within(rows[index]!).getByText(`brand-${index}.test`)).toBeTruthy();
      expect(within(rows[index]!).getByText(status)).toBeTruthy();
    }
    expect(within(rows[0]!).getByText("Canary")).toBeTruthy();
    expect(within(rows[2]!).getByText("Smoke check failed")).toBeTruthy();
    expect(within(rows[1]!).getByText("upgrade-install-1")).toBeTruthy();
    expect(within(rows[2]!).queryByText(/Retry of/)).toBeNull();
  });

  it("polls pending outcomes until terminal and cancels timers on unmount", async () => {
    vi.useFakeTimers();
    let next = structuredClone(result);
    const fetcher = vi.fn(async () => response(next));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<UpgradeOutcomes refresh={0} />);
    await act(async () => {});
    expect(screen.getByText("running")).toBeTruthy();
    next.upgrade!.outcomes[0]!.status = "ready";
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText("running")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    next = structuredClone(result);
    view.rerender(<UpgradeOutcomes refresh={1} />);
    await act(async () => {});
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shows a fetch failure and recovers on refresh", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response({ upgrade: null }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<UpgradeOutcomes refresh={0} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not load upgrade-all outcomes. Refresh to retry.");
    expect(screen.queryByText("No accepted upgrade-all yet.")).toBeNull();
    view.rerender(<UpgradeOutcomes refresh={1} />);
    await screen.findByText("No accepted upgrade-all yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
