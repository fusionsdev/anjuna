import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { BrandLabel, buildBrandLabels } from "../src/client/brand-labels";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("buildBrandLabels", () => {
  it("prefers the factory domain, falls back to the runtime hostname", () => {
    const map = buildBrandLabels(
      [{ brand_id: "b1", hostnames: ["one.example"] }],
      [{ brand_id: "b1", hostnames: ["www.one.example"] }, { brand_id: "b2", hostnames: ["two.example"] }],
    );
    expect(map.get("b1")).toBe("one.example");
    expect(map.get("b2")).toBe("two.example");
    expect(map.has("b3")).toBe(false);
  });

  it("works when one source failed", () => {
    expect(buildBrandLabels(null, [{ brand_id: "b2", hostnames: ["two.example"] }]).get("b2")).toBe("two.example");
    expect(buildBrandLabels([{ brand_id: "b1", hostnames: ["one.example"] }], null).get("b1")).toBe("one.example");
  });
});

describe("BrandLabel", () => {
  it("shows the domain first and the id in monospace", async () => {
    vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "b1", hostnames: ["one.example"] }] as never });
    vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    render(<BrandLabel brandId="b1" />);
    expect(await screen.findByText("one.example")).toBeTruthy();
    expect(screen.getByText("b1").tagName).toBe("CODE");
  });

  it("falls back to the id when both sources fail", async () => {
    vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "brands").mockRejectedValue(new Error("down"));
    render(<BrandLabel brandId="b9" />);
    expect(await screen.findByText("b9")).toBeTruthy();
    expect(document.querySelector(".brand-id")).toBeNull();
  });

  it("uses an explicit domain without a lookup result", () => {
    vi.spyOn(api, "lifecycleBrands").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, "brands").mockReturnValue(new Promise(() => undefined));
    render(<BrandLabel brandId="b1" domain="given.example" />);
    expect(screen.getByText("given.example")).toBeTruthy();
  });

  it("does not fetch when the caller already gave a domain", () => {
    const lifecycle = vi.spyOn(api, "lifecycleBrands").mockReturnValue(new Promise(() => undefined));
    const runtime = vi.spyOn(api, "brands").mockReturnValue(new Promise(() => undefined));
    render(<><BrandLabel brandId="b1" domain="one.example" /><BrandLabel brandId="b2" domain="two.example" /></>);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
  });
});
