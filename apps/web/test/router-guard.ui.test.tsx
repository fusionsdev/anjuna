import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigate, parseRoute, setLeaveGuard, useRoute, viewPath } from "../src/client/router";

afterEach(() => {
  cleanup();
  setLeaveGuard(null);
  window.history.replaceState(null, "", "/");
});

function Probe() {
  return <p data-testid="view">{useRoute().view}</p>;
}

const view = () => screen.getByTestId("view").textContent;

/** Start on /brands, then open /settings, so Back has somewhere to go. */
function openSettings() {
  window.history.replaceState(null, "", "/brands");
  render(<Probe />);
  act(() => navigate("/settings"));
  expect(window.location.pathname).toBe("/settings");
}

async function back() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
  });
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("leave guard", () => {
  it("parseRoute and viewPath know /settings", () => {
    expect(parseRoute("/settings")).toEqual({ view: "settings" });
    expect(viewPath("settings")).toBe("/settings");
  });

  it("navigate without a guard changes the path at once", () => {
    render(<Probe />);
    act(() => navigate("/brands"));
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });

  it("a guard that answers false keeps the path and the view", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(false);
    setLeaveGuard(guard);
    act(() => navigate("/brands"));
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");
    expect(view()).toBe("settings");
  });

  it("a guard that answers true navigates", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(true);
    setLeaveGuard(guard);
    act(() => navigate("/brands"));
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });

  it("navigate to the current path does not ask the guard", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(false);
    setLeaveGuard(guard);
    act(() => navigate("/settings"));
    await flush();
    expect(guard).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings");
  });

  it("Back with a guard set restores /settings, asks once, and on true lands on the previous page", async () => {
    openSettings();
    let answer: (ok: boolean) => void = () => {};
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    setLeaveGuard(guard);
    await back();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");
    expect(view()).toBe("settings");
    await act(async () => answer(true));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });

  it("Forward with a guard set asks once and on true lands on the next page", async () => {
    openSettings();
    await back();
    expect(window.location.pathname).toBe("/brands");
    const guard = vi.fn().mockResolvedValue(true);
    setLeaveGuard(guard);
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");
    expect(view()).toBe("settings");
  });

  it("a guard that clears itself and answers true still navigates", async () => {
    openSettings();
    setLeaveGuard(async () => { setLeaveGuard(null); return true; });
    act(() => navigate("/brands"));
    await flush();
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });

  it("Back with a guard that clears itself and answers true still lands on the previous page", async () => {
    openSettings();
    setLeaveGuard(async () => { setLeaveGuard(null); return true; });
    await back();
    await flush();
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });

  it("a hash-only change to another screen asks the guard and false keeps /settings", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(false);
    setLeaveGuard(guard);
    await act(async () => {
      window.history.pushState(null, "", "/settings#templates");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.hash).toBe("");
    expect(view()).toBe("settings");
  });

  it("a hash-only change answered true opens the templates screen", async () => {
    openSettings();
    setLeaveGuard(vi.fn().mockResolvedValue(true));
    await act(async () => {
      window.history.pushState(null, "", "/settings#templates");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    expect(view()).toBe("templates");
  });

  it("Back with a guard answering false stays on /settings", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(false);
    setLeaveGuard(guard);
    await back();
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");
    expect(view()).toBe("settings");
  });

  it("setLeaveGuard(null) removes the guard", async () => {
    openSettings();
    const guard = vi.fn().mockResolvedValue(false);
    setLeaveGuard(guard);
    setLeaveGuard(null);
    act(() => navigate("/brands"));
    expect(guard).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/brands");
    expect(view()).toBe("brands");
  });
});
