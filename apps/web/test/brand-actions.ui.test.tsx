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

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "installDetail").mockResolvedValue({ install_id: "inst-a", recovery_required: false } as never);
  render(<Harness />);
});
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
    vi.spyOn(api, "approveTemplate").mockRejectedValue(new ApiError(403, { error: "forbidden_role" }));
    act(() => { void actions.run("approve-template", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("อนุมัติเทมเพลต"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)");
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

  it("keeps the dialog open with a message when the lead id is empty, then sends once it is typed", async () => {
    const attest = vi.spyOn(api, "attestChecklist").mockResolvedValue({});
    act(() => { void actions.run("test-sold", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("ยืนยัน"));
    await waitFor(() => expect(dialog().textContent).toContain("กรอก lead_id ของ alpha.test"));
    expect(attest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("lead_id alpha.test"), { target: { value: "lead-1" } });
    fireEvent.click(confirmButton("ยืนยัน"));
    await waitFor(() => expect(attest).toHaveBeenCalledWith("a", "test_sold", "lead-1"));
  });

  it("opens the brand page instead of Retry when the install needs recovery", async () => {
    vi.spyOn(api, "installDetail").mockResolvedValue({ install_id: "inst-a", recovery_required: true } as never);
    const retry = vi.spyOn(api, "retryInstall").mockResolvedValue({ install_id: "n", brand_id: "a", status: "queued" });
    await act(async () => { await actions.run("retry-install", brandA); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/brands/a");
  });

  it("sends Retry when the install does not need recovery", async () => {
    const retry = vi.spyOn(api, "retryInstall").mockResolvedValue({ install_id: "n", brand_id: "a", status: "queued" });
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.click(confirmButton("ลองใหม่"));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("inst-a"));
    expect(window.location.pathname).toBe("/");
  });

  it("names the template and version in the approve dialog", async () => {
    act(() => { void actions.run("approve-template", { ...brandA, templateLabel: "Loan Pro v3" }); });
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(dialog().textContent).toContain("Loan Pro v3");
    expect(dialog().textContent).toContain("alpha.test");
  });

  it("sends only the request of the brand whose dialog was confirmed when a second dialog replaces the first", async () => {
    const retry = vi.spyOn(api, "retryInstall").mockResolvedValue({ install_id: "n", brand_id: "b", status: "queued" });
    act(() => { void actions.run("retry-install", brandA); });
    await waitFor(() => expect(dialog().textContent).toContain("alpha.test"));
    act(() => { void actions.run("retry-install", { ...brandB, installId: "inst-b" }); });
    await waitFor(() => expect(dialog().textContent).toContain("beta.test"));
    fireEvent.click(confirmButton("ลองใหม่"));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(retry).toHaveBeenCalledWith("inst-b");
  });

  it("batch test sold sends one request per brand in order and stops at the first failure", async () => {
    const order: string[] = [];
    const first = deferred<unknown>();
    const attest = vi.spyOn(api, "attestChecklist").mockImplementation(async (brandId) => {
      order.push(brandId);
      if (brandId === "a") return first.promise;
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
    await waitFor(() => expect(order).toEqual(["a"]));
    // Brand b does not start while a is unsettled.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["a"]);
    await act(async () => { first.resolve({}); });
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
