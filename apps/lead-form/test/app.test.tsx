// User-visible parity with V1 lite_v1 (3 steps: amount + ZIP prefilled, contact details,
// review & agreement), driven the same way spike/ui_e2e.py drives it, plus the T4 changes:
// brand and label from the runtime config (the ad keyword is never shown), variant from cfg.variant, no gate-interest call.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string; init?: RequestInit };

function setConfig(cfg: Record<string, unknown>) {
  document.head.innerHTML = `<script type="application/json" id="cfg">${JSON.stringify(cfg)}</script>`;
}

async function loadApp() {
  vi.resetModules();
  const mod = await import("../src/App");
  return mod.default;
}

let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  sessionStorage.clear();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/zip")) {
        return new Response(JSON.stringify({ found: true, city: "Beverly Hills", state: "CA" }), { status: 200 });
      }
      if (String(url) === "/api/leads") {
        return new Response(
          JSON.stringify({ status: "accepted", lead_id: "x", redirect_url: "/request/provider?c=t" }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    }),
  );
  window.history.replaceState({}, "", "/request?requested_amount=3250&zip=90210&gclid=G1&keyword=bear%20cash");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("form app", () => {
  it("shows the brand name as the page's only h1 when the config has no label", async () => {
    setConfig({ brand: "Example Brand", keyword: "Bear Cash Loans", amount: 3250, zip: "90210", variant: "lite_v1" });
    const App = await loadApp();
    const { container } = render(<App />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("Example Brand");
    expect(container.querySelector("header")?.textContent).toContain("Example Brand");
    expect(container.querySelector("[data-kw]")).toBeNull();
  });

  it("shows the label in the header and brandName in the footer and consent text when the config has a label", async () => {
    setConfig({ brand: "Example Brand", keyword: "Bear Cash Loans", label: "Vet Payment Plans", amount: 3250, zip: "90210", variant: "lite_v1" });
    const App = await loadApp();
    const { container } = render(<App />);
    expect(container.querySelector("header h1")?.textContent).toBe("Vet Payment Plans");
    expect(container.querySelector("header")?.textContent).not.toContain("Example Brand");
    expect(container.querySelector("footer")?.textContent).toContain("Example Brand");
    expect(container.querySelector("footer")?.textContent).not.toContain("Vet Payment Plans");
    expect(container.textContent).not.toContain("Bear Cash Loans");
  });

  it("has no disclosure bar above the header", async () => {
    setConfig({ brand: "Example Brand", amount: 3250, zip: "90210", variant: "lite_v1" });
    const App = await loadApp();
    const { container } = render(<App />);
    expect(container.textContent).not.toContain("secure credit-matching technology platform");
    expect(container.querySelector(".bg-zinc-900.text-zinc-100")).toBeNull();
    // Nothing precedes the brand header: it sits in the first block of the page.
    expect(container.firstElementChild?.firstElementChild?.querySelector("header")).not.toBeNull();
  });

  it("sets document.title to the label once on mount, and leaves the title alone without one", async () => {
    // setConfig rewrites <head>, so the title is set after it.
    setConfig({ brand: "Example Brand", keyword: "Bear Cash", amount: 3250, zip: "90210", variant: "lite_v1" });
    document.title = "Secure Request";
    let App = await loadApp();
    const first = render(<App />);
    expect(document.title).toBe("Secure Request");
    first.unmount();

    setConfig({ brand: "Example Brand", keyword: "Bear Cash", label: "Vet Payment Plans", amount: 3250, zip: "90210", variant: "lite_v1" });
    document.title = "Secure Request";
    App = await loadApp();
    render(<App />);
    expect(document.title).toBe("Vet Payment Plans");
  });

  it("never renders the URL keyword or cfg.keyword anywhere in the DOM", async () => {
    setConfig({ brand: "Example Brand", keyword: "Bear Cash Loans", label: "Vet Payment Plans", amount: 3250, zip: "90210", variant: "lite_v1" });
    const App = await loadApp();
    const { container } = render(<App />);
    const text = container.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("bear cash");
    expect(container.innerHTML.toLowerCase()).not.toContain("bear cash");
  });

  it("falls back to the neutral brand when the config is empty", async () => {
    setConfig({});
    const App = await loadApp();
    const { container } = render(<App />);
    expect(container.querySelector("header h1")?.textContent).toBe("Secure Request");
    expect(container.textContent?.toLowerCase()).not.toContain("aurum");
  });

  it("renders the full variant when cfg.variant says so", async () => {
    setConfig({ brand: "Example Brand", variant: "full_v1" });
    const App = await loadApp();
    render(<App />);
    expect(screen.getAllByText(/Desired Loan Amount/i).length).toBeGreaterThan(0);
  });

  it("runs lite_v1 end to end: 3 steps, prefilled amount + ZIP, lead payload, no gate-interest", async () => {
    setConfig({ brand: "Example Brand", keyword: "Bear Cash", amount: 3250, zip: "90210", variant: "lite_v1" });
    const App = await loadApp();
    const { container } = render(<App />);

    // Step 1: amount + ZIP prefilled from the handoff; the visitor just continues.
    expect(screen.getAllByText(/Requested Amount/i).length).toBeGreaterThan(0);
    expect((container.querySelector('input[placeholder="e.g. 10001"]') as HTMLInputElement).value).toBe("90210");
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/zip?zip=90210"))).toBe(true));
    await act(async () => {
      fireEvent.click(container.querySelector('button[type="submit"]')!);
    });

    // Step 2: contact details.
    await waitFor(() => expect(screen.getAllByText(/Contact Details/i).length).toBeGreaterThan(0));
    const fill = (sel: string, v: string) => {
      const el = container.querySelector(sel) as HTMLInputElement;
      fireEvent.change(el, { target: { value: v } });
      fireEvent.blur(el);
    };
    fill('input[placeholder="e.g. John"]', "Test");
    fill('input[placeholder="e.g. Smith"]', "Spike");
    fill('input[placeholder="e.g. 555-123-4567"]', "2145550123");
    fill('input[placeholder="example@domain.com"]', "ui-spike@example.com");
    await act(async () => {
      fireEvent.click(container.querySelector('button[type="submit"]')!);
    });

    // Step 3: review & agreement, consent-gated submit.
    await waitFor(() => expect(screen.getAllByText(/Review & Agreement/i).length).toBeGreaterThan(0));
    fireEvent.click(container.querySelector('input[type="checkbox"]')!);
    const submit = [...container.querySelectorAll("main button[type=button]")].filter(
      (b) => !(b as HTMLButtonElement).disabled,
    );
    await act(async () => {
      fireEvent.click(submit[submit.length - 1]!);
    });

    await waitFor(() => expect(calls.some((c) => c.url === "/api/leads")).toBe(true));
    const lead = JSON.parse(String(calls.find((c) => c.url === "/api/leads")!.init!.body));
    expect(lead.form_variant).toBe("lite_v1");
    expect(lead.site).toMatchObject({ site_id: "form-default", brand: "Example Brand" });
    expect(lead.lead).toMatchObject({
      requested_amount: "3250",
      first_name: "Test",
      last_name: "Spike",
      home_phone: "2145550123",
      email: "ui-spike@example.com",
      zip: "90210",
      state: "CA",
    });
    expect(lead.tracking).toMatchObject({ gclid: "G1", keyword: "bear cash" });
    expect(lead.consent.application_consent).toBe(true);

    // Removed side channels.
    expect(calls.some((c) => c.url.includes("gate-interest"))).toBe(false);
  });
});
