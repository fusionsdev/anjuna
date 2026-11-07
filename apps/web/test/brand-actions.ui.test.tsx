import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/client/api";
import { useBrandActions, type ActionBrand } from "../src/client/useBrandActions";

const brandA: ActionBrand = { id: "a", name: "Alpha", domain: "alpha.test", installId: "inst-a", templateId: "tv-1" };
const brandB: ActionBrand = { id: "b", name: "Beta", domain: "beta.test" };
const brandC: ActionBrand = { id: "c", name: "Gamma", domain: "gamma.test" };

type Actions = ReturnType<typeof useBrandActions>;
let actions: Actions;

function Harness({ onDone }: { onDone?: () => void }) {
  actions = useBrandActions({ onDone });
  return <div>{actions.view}</div>;
}

const dialog = () => screen.getByRole("alertdialog");
const confirmButton = (label: string) => screen.getByRole("button", { name: label });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => { render(<Harness />); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useBrandActions", () => {
  it("names the brand and its domain in the dialog", async () => {
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(dialog().textContent).toContain("Alpha");
    expect(dialog().textContent).toContain("alpha.test");
  });

  it("sends nothing when the dialog is cancelled", async () => {
    const retry = vi.spyOn(api, "retryInstall").mockResolvedValue({ install_id: "n", brand_id: "a", status: "queued" });
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /ยกเลิก/ }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(retry).not.toHaveBeenCalled();
  });

  it("sends one request when the same action runs again while it is pending", async () => {
    const gate = deferred<{ install_id: string; brand_id: string; status: string }>();
    const retry = vi.spyOn(api, "retryInstall").mockReturnValue(gate.promise);
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("ลองใหม่"));
    await waitFor(() => expect(actions.pending.has("retry-install:a")).toBe(true));
    act(() => { void actions.run("retry-install", brandA); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith("inst-a");
    await act(async () => { gate.resolve({ install_id: "n", brand_id: "a", status: "queued" }); });
    await waitFor(() => expect(actions.pending.has("retry-install:a")).toBe(false));
  });

  it("shows the 403 of an employee approve-template as a toast", async () => {
    vi.spyOn(api, "approveTemplate").mockRejectedValue(new ApiError(403, { error: "forbidden" }));
    act(() => { void actions.run("approve-template", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("อนุมัติเทมเพลต"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect(actions.pending.has("approve-template:a")).toBe(false);
  });

  it("attests test sold with the lead id typed for the brand", async () => {
    const attest = vi.spyOn(api, "attestChecklist").mockResolvedValue({});
    act(() => { void actions.run("test-sold", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.change(screen.getByLabelText("lead_id alpha.test"), { target: { value: "lead-9" } });
    fireEvent.click(confirmButton("ยืนยัน"));
    await waitFor(() => expect(attest).toHaveBeenCalledWith("a", "test_sold", "lead-9"));
  });

  it("does not attest test sold without a lead id", async () => {
    const attest = vi.spyOn(api, "attestChecklist").mockResolvedValue({});
    act(() => { void actions.run("test-sold", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("ยืนยัน"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(attest).not.toHaveBeenCalled();
  });

  it("batch test sold sends one request per brand in order and stops at the first failure", async () => {
    const order: string[] = [];
    const attest = vi.spyOn(api, "attestChecklist").mockImplementation(async (brandId) => {
      order.push(brandId);
      if (brandId === "b") throw new ApiError(500, { error: "internal" });
      return {};
    });
    act(() => { void actions.runBatch("test-sold", [brandA, brandB, brandC]); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(dialog().textContent).toContain("alpha.test");
    expect(dialog().textContent).toContain("beta.test");
    expect(dialog().textContent).toContain("gamma.test");
    for (const [domain, lead] of [["alpha.test", "l1"], ["beta.test", "l2"], ["gamma.test", "l3"]]) {
      fireEvent.change(screen.getByLabelText(`lead_id ${domain}`), { target: { value: lead } });
    }
    fireEvent.click(confirmButton("ยืนยัน"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("beta.test"));
    expect(order).toEqual(["a", "b"]);
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it("calls onDone after a successful request", async () => {
    cleanup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    vi.spyOn(api, "retryInstall").mockResolvedValue({ install_id: "n", brand_id: "a", status: "queued" });
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("ลองใหม่"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
