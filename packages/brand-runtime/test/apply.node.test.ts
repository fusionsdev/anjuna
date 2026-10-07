import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { BUYER_FIELDS } from "@anjuna/contracts";
import { setup } from "./helpers.js";

async function application(params: Record<string, string>, rendered = false) {
  const html = await (await setup().get(`/apply?${new URLSearchParams(params)}`)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  const retry = { setAttribute: vi.fn() };
  const fallback = { style: { display: "none" } };
  const container = { querySelector: vi.fn(() => rendered ? {} : null) };
  const window = { location: { pathname: "/apply", search: `?${new URLSearchParams(params)}` } };
  const context = {
    window, URLSearchParams,
    document: { getElementById: (id: string) => ({ _lg_retry_: retry, _lg_fallback_: fallback, _lg_form_: container })[id] },
    setTimeout: vi.fn(),
  };
  runInNewContext(script!, context);
  return { ...context, retry, fallback, init: (context as typeof context & { _lg_form_init_: Record<string, string> })._lg_form_init_ };
}

describe("application initialization in the browser (no external script loaded)", () => {
  it("forwards every buyer field and attribution alias, but no other URL keys", async () => {
    const fields = Object.fromEntries(BUYER_FIELDS.map((key) => [key, `value-${key}`]));
    const { init } = await application({ ...fields, lead_id: "lead-1", clickid: "click-1", aid: "999", template: "x", evil: "<script>evil()</script>", ["__proto__"]: "bad", constructor: "bad" });
    expect(init).toEqual({ ...fields, lead_id: "lead-1", clickid: "click-1", aid: "999", template: "fresh", click_id: "click-1", ref: "lead-1" });
  });
  it("keeps explicit click_id/ref precedence and URL values as data", async () => {
    const value = '</script><script>alert("x")</script>';
    const { init } = await application({ aid: "14881", clickid: "alias", click_id: "canonical", lead_id: "lead", ref: "reference", first_name: value });
    expect(init).toEqual({ aid: "14881", template: "fresh", clickid: "alias", click_id: "canonical", lead_id: "lead", ref: "reference", first_name: value });
  });
  it.each(["", "evil", "123x", "-1", "1.5", "1e3", " 123", "123\n", "</script>"])("rejects non-digit aid %j and fixes the template", async (aid) => {
    expect((await application({ aid, template: "x" })).init).toEqual({ aid: "", template: "fresh", click_id: "", ref: "" });
  });
  it("preserves the query on retry and reveals fallback after 8s with no form", async () => {
    const app = await application({ aid: "14881", lead_id: "lead", first_name: "Alice" });
    expect(app.retry.setAttribute).toHaveBeenCalledWith("href", app.window.location.pathname + app.window.location.search);
    expect(app.setTimeout).toHaveBeenCalledWith(expect.any(Function), 8000);
    expect(app.fallback.style.display).toBe("none");
    app.setTimeout.mock.calls[0]![0]();
    expect(app.fallback.style.display).toBe("block");
  });
  it("keeps fallback hidden when rendered, but exposes the script-error callback", async () => {
    const app = await application({}, true);
    app.setTimeout.mock.calls[0]![0]();
    expect(app.fallback.style.display).toBe("none");
    (app.window as typeof app.window & { _lg_showFallback: () => void })._lg_showFallback();
    expect(app.fallback.style.display).toBe("block");
  });
});
